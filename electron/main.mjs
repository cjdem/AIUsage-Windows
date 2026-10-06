/**
 * Electron 主进程：窗口 + 托盘 + 编排层宿主 + IPC。
 *
 * 设计要点：
 *  - 编排层（app-service.mjs）跑在主进程里，两个代理也在主进程内监听；
 *    关掉控制台或退出应用时链路会被一起停掉，不会留下孤儿进程。
 *  - 渲染进程完全隔离：contextIsolation + sandbox + 无 nodeIntegration，
 *    UI 只通过 preload 暴露的窄 API 走 IPC，页面自身没有任何网络权限（CSP connect-src 'none'）。
 *  - UI 走自定义协议 aiusage:// 而不是 file://：file:// 下 ES module 会被 CORS 拦掉，
 *    自定义协议给了稳定 origin，模块与 CSP 才能正常工作。
 *  - 关闭窗口 = 收进托盘（链路继续跑）；托盘菜单「退出」才停链并退出。
 *    不写注册表启动项，不做开机自启。
 *  - 打包版把配置放在 %APPDATA%\<产品名>\config.json（首次从内置 config.example.json 播种），
 *    避免往只读的 asar 里写文件，也避免把真实密钥打进安装包。
 *  - `--smoke` 用于自动化自检：等渲染进程报告就绪后打印 SMOKE OK 并退出（不启动链路、不建托盘）。
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAppService } from '../src/app-service.mjs';
import { registerIpc } from './ipc/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI_DIR = path.join(ROOT, 'ui');
const SCHEME = 'aiusage';
const SMOKE = process.argv.includes('--smoke');
const SMOKE_TIMEOUT_MS = 25_000;
const PHASE_LABEL = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  stopping: '停止中…',
  error: '启动失败',
};

let mainWindow = null;
let tray = null;
let service = null;
let startedByApp = false;
let isQuitting = false;
let smokeTimer = null;
/** 界面加载/渲染层错误（smoke 自检失败时一并报出来，便于定位 CSP/preload 问题）。 */
const interfaceErrors = [];

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// MARK: - 配置位置

/**
 * 打包版：配置放 %APPDATA%\<产品名>\config.json，首次从内置 config.example.json 播种
 * （真实密钥只存在于用户机器上，绝不进安装包）。开发模式返回 null → 用仓库里的 config.json。
 */
function resolveConfigPathForApp() {
  if (!app.isPackaged) return null;
  try {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    const target = path.join(userData, 'config.json');
    if (!fs.existsSync(target)) {
      const template = path.join(ROOT, 'config.example.json');
      if (fs.existsSync(template)) {
        fs.copyFileSync(template, target);
        console.log(`已播种配置模板：${target}`);
      }
    }
    return target;
  } catch (err) {
    console.error(`准备配置目录失败：${err.message}`);
    return null;
  }
}

// MARK: - UI 协议

/** 只服务 ui/ 目录内的文件，拒绝目录穿越。 */
function registerUiProtocol() {
  if (typeof protocol.handle !== 'function') return false;
  protocol.handle(SCHEME, async (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const clean = rel.replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(UI_DIR, clean);
    if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch (err) {
      return new Response(`not found: ${err.message}`, { status: 404 });
    }
  });
  return true;
}

// MARK: - 窗口

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#11131a',
    title: 'AIUsage · Claude Science 控制台',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  // 关闭窗口 = 收进托盘（链路继续跑）；真正退出走托盘菜单或 before-quit
  mainWindow.on('close', (event) => {
    if (isQuitting || SMOKE) return;
    event.preventDefault();
    mainWindow.hide();
    refreshTrayMenu();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 界面层错误一律记录下来：smoke 自检失败时能直接看到原因（CSP / preload / 渲染进程崩溃）
  const noteInterfaceError = (text) => {
    interfaceErrors.push(String(text).slice(0, 300));
    if (interfaceErrors.length > 10) interfaceErrors.shift();
    console.error(`[界面] ${text}`);
  };
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    noteInterfaceError(`加载失败 ${code} ${description} ${url}`);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    noteInterfaceError(`preload 失败 ${preloadPath}: ${error?.message ?? error}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    noteInterfaceError(`渲染进程退出：${details?.reason ?? '未知'}`);
  });

  // 外链一律交给系统浏览器；本应用自身不加载任何外部内容
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${SCHEME}://`)) event.preventDefault();
  });

  // 开发模式便利键（不建菜单，保持界面干净）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.control && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  if (registerUiProtocol()) {
    mainWindow.loadURL(`${SCHEME}://ui/index.html`);
  } else {
    // 极老版本 Electron 没有 protocol.handle：退回 file://（ES module 可能被拦，但至少能显示错误页）
    mainWindow.loadFile(path.join(UI_DIR, 'index.html'));
  }
}

// MARK: - 托盘

async function runFromTray(action) {
  if (!service) return;
  try {
    if (action === 'start') {
      startedByApp = true;
      await service.start();
    } else if (action === 'restart') {
      startedByApp = true;
      await service.restart();
    } else if (action === 'stop') {
      await service.stop();
    }
  } catch (err) {
    console.error(`托盘操作 ${action} 失败：${err.message}`);
  }
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const phase = service?.state?.phase ?? 'stopped';
  const label = PHASE_LABEL[phase] ?? phase;
  const running = phase === 'running';
  const busy = phase === 'starting' || phase === 'stopping';

  tray.setToolTip(`AIUsage Science Proxy · ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `状态：${label}`, enabled: false },
    { type: 'separator' },
    { label: '打开控制台', click: showWindow },
    { label: '打开浏览器界面', enabled: !!service?.entryUrl(), click: () => service?.openEntry() },
    { label: '打开桌面 app', click: () => service?.openDesktopApp() },
    { type: 'separator' },
    { label: '启动链路', enabled: !running && !busy, click: () => runFromTray('start') },
    { label: '停止链路', enabled: running && !busy, click: () => runFromTray('stop') },
    { label: '重启链路', enabled: running && !busy, click: () => runFromTray('restart') },
    { type: 'separator' },
    {
      label: '退出（会停止链路）',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  try {
    const iconPath = path.join(UI_DIR, 'tray-icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
    refreshTrayMenu();
  } catch (err) {
    console.error(`创建托盘失败（不影响主功能）：${err.message}`);
  }
}

// MARK: - smoke 自检

/** smoke 结果：Windows 上 Electron 的 stdout 不回传父进程，所以同时写文件。 */
function finishSmoke(message, code) {
  console.log(message);
  const out = process.env.AIUSAGE_SMOKE_OUT;
  if (out) {
    try {
      fs.writeFileSync(out, `${message}\n`, 'utf8');
    } catch { /* 自检输出写不出去也不影响结论 */ }
  }
  app.exit(code);
}

function bootSmokeWatchdog() {
  if (!SMOKE) return;
  smokeTimer = setTimeout(() => {
    finishSmoke(
      `SMOKE FAIL：渲染进程在 ${SMOKE_TIMEOUT_MS}ms 内未报告就绪（检查 UI 加载/CSP/IPC）`
      + `；界面错误：${interfaceErrors.join(' | ') || '无'}`,
      1,
    );
  }, SMOKE_TIMEOUT_MS);
}

/** smoke 自检：把六个视图都切一遍，确认都能渲染且没有报错提示；可选逐视图截图。 */
async function smokeWalkViews() {
  const views = ['dashboard', 'node-config', 'logs', 'analytics', 'login', 'settings'];
  const report = {};
  // 需要截图时设 AIUSAGE_SCREENSHOT_DIR：每个视图存一张 PNG（可直接当文档素材）
  const shotDir = process.env.AIUSAGE_SCREENSHOT_DIR ?? null;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  for (const id of views) {
    try {
      await mainWindow.webContents.executeJavaScript(`location.hash = '#/${id}'; true`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (shotDir) {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, `${id}.png`), image.toPNG());
      }
      report[id] = await mainWindow.webContents.executeJavaScript(`(() => ({
        cards: document.querySelectorAll('.card').length,
        textLength: document.body.innerText.length,
        errors: Array.from(document.querySelectorAll('.banner-err, .hint-box'))
          .map((node) => node.textContent.slice(0, 140)),
      }))()`);
    } catch (err) {
      report[id] = { error: err.message };
    }
  }
  if (shotDir) report.screenshots = shotDir;
  return report;
}

async function onUiReady(info) {
  if (!SMOKE) return;
  if (smokeTimer) clearTimeout(smokeTimer);
  smokeTimer = null;
  try {
    const status = await service.status();
    const views = await smokeWalkViews();
    finishSmoke(`SMOKE OK ${JSON.stringify({
      renderer: info ?? null,
      packaged: app.isPackaged,
      phase: status.phase,
      ports: status.ports,
      configPath: status.configPath,
      configError: status.configError,
      binaryExists: status.science?.binaryExists ?? null,
      interfaceErrors,
      views,
    })}`, 0);
  } catch (err) {
    finishSmoke(`SMOKE FAIL：status() 抛错 ${err.message}`, 1);
  }
}

// MARK: - 生命周期

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    service = createAppService({
      configPath: resolveConfigPathForApp(),
      // 在 Electron 里「打开界面」用系统默认浏览器，而不是 cmd start
      deps: { openUrl: (url) => shell.openExternal(url) },
    });

    registerIpc({
      service,
      getWindow: () => mainWindow,
      onUiReady,
      // 记录「链路是本应用启动的」：只有这种情况才在退出时自动停止
      onStart: () => { startedByApp = true; },
    });

    // 阶段/完成事件都会影响托盘菜单可用项
    service.onEvent((event) => {
      if (event.type === 'phase' || event.type === 'done' || event.type === 'error') refreshTrayMenu();
    });

    createWindow();
    if (!SMOKE) createTray();
    bootSmokeWatchdog();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // 有托盘常驻：窗口全关也不退出（用户从托盘菜单显式退出）
  app.on('window-all-closed', () => {
    if (SMOKE) app.quit();
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (startedByApp && service && service.state.phase !== 'stopped') {
      event.preventDefault();
      console.log('退出前停止本应用启动的链路…');
      service.stop()
        .then(() => console.log('链路已停止'))
        .catch((err) => console.error(`停止失败：${err.message}`))
        .finally(() => app.exit(0));
    }
  });
}
