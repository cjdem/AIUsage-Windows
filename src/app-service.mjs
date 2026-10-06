/**
 * 应用编排层（阶段 1）：桌面控制台与命令行共用的唯一「一键启停」实现。
 *
 * 把 scripts/start.ps1 的 8 步序列搬到 Node，并补上脚本做不到的部分：
 *   1. 校验（配置 / 二进制 / 数据目录）
 *   2. 备份真实 data-dir（只读复制）
 *   3. 确保登录态（真实登录直接复用；否则写入带标记的虚拟凭证）
 *   4. 清理上次残留（state.json 记录的 PID + 端口占用者，白名单校验后才杀）
 *   5. 启动推理代理（**本进程内**，:14402）
 *   6. 启动 daemon（子进程，注入 ANTHROPIC_BASE_URL，env 只作用于该子进程）
 *   7. 等 daemon 健康
 *   8. 启动会话反代（本进程内，:8000 → :8010）
 *   9. 自探公开入口
 *
 * 与脚本相比的差异（有意为之）：
 *   - 两个代理跑在本进程内（`createInferenceServer` / `createSessionProxy` 直接 import），
 *     因此「关掉控制台 = 链路停止」，不存在孤儿进程；daemon 仍是子进程（必须）。
 *   - 任一步失败统一回滚（逆序撤销已启动的组件），并如实报告失败阶段与原因。
 *   - 全流程事件流（stage/phase/log/warn/error），供 UI 实时显示。
 *
 * 安全铁律：不写系统环境变量（env 只给 daemon 子进程）；不改 Science 二进制；
 * 杀进程前一律核对映像名，绝不误杀陌生进程；日志/事件里绝不出现密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, describeConfig, resolveConfigPath, ConfigError,
  saveConfigPatch, configForEditing, normalizeUpstream,
} from './config.mjs';
import { configureLogging, log } from './log.mjs';
import { createLogBus, attachProcessLogs, attachStreamLines } from './log-bus.mjs';
import { createInferenceServer } from './inference-server.mjs';
import { createSessionProxy } from './session-proxy.mjs';
import { backupDataDir, probeHTTP, restoreBackup, stopDaemon, waitForHealth } from './science-control.mjs';
import { inspectVirtualLogin, removeVirtualLogin, writeVirtualLogin } from './virtual-login.mjs';
import { runProbe } from './probe.mjs';
import { createAnalyticsStore } from './analytics-store.mjs';
import { runDoctor } from './doctor.mjs';

/** 占位密钥：只给 daemon 子进程看，真实上游 key 永远不会离开本进程。 */
const PLACEHOLDER_KEY = 'sk-aiusage-local-proxy-key';
const MANAGED_BY = 'aiusage-app';
/** 允许被本工具结束的进程映像名（清理残留时的白名单）。 */
const KILLABLE = ['node.exe', 'electron.exe', 'claude-science.exe'];
/** 清理残留时允许查杀的端口名（sandbox 端口只查不杀，避免打断 daemon 内部状态）。 */
const CLEAN_PORTS = ['inference', 'publicEntry', 'daemon'];

export const STATE_DIR = path.join(
  process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? process.cwd(),
  'ClaudeScience',
  'aiusage-proxy',
);
export const STATE_FILE = path.join(STATE_DIR, 'state.json');

export const STAGE_LABELS = {
  validate: '校验配置与二进制',
  backup: '备份真实数据目录',
  login: '确保登录态',
  cleanup: '清理上次残留',
  inference: '启动推理代理',
  'daemon-start': '启动 Claude Science daemon',
  'daemon-health': '等待 daemon 就绪',
  session: '启动会话反代',
  probe: '自探公开入口',
  done: '完成',
};

export class AppServiceError extends Error {
  constructor(message, { stage = null, hint = null } = {}) {
    super(message);
    this.name = 'AppServiceError';
    this.stage = stage;
    this.hint = hint;
  }
}

// MARK: - 进程与端口工具（Windows）

function runCommand(file, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\n<超时 ${timeoutMs}ms>` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 解析 `netstat -ano -p TCP` 的 LISTENING 行，返回占用该端口的 PID 列表。 */
export function parseListeningPids(netstatOutput, port) {
  const pids = new Set();
  for (const line of String(netstatOutput ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const portMatch = /:(\d+)$/.exec(m[1]);
    if (!portMatch || Number(portMatch[1]) !== Number(port)) continue;
    pids.add(Number(m[2]));
  }
  return [...pids];
}

async function listListeningPids(port) {
  const res = await runCommand('netstat', ['-ano', '-p', 'TCP']);
  if (res.code !== 0 && res.stdout.trim() === '') return [];
  return parseListeningPids(res.stdout, port);
}

/** 进程映像名（小写）；查不到返回 null。 */
async function processImageName(pid) {
  const res = await runCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const m = /^"([^"]+)"/.exec(res.stdout.trim());
  return m ? m[1].toLowerCase() : null;
}

/** 只有映像名在白名单里才结束进程。 */
async function killIfAllowed(pid, allowed = KILLABLE) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 8 || numeric === process.pid) {
    return { pid: numeric || null, killed: false, reason: '拒绝（自身/PID 非法）' };
  }
  const name = await processImageName(numeric);
  if (!name) return { pid: numeric, killed: false, reason: '进程不存在' };
  if (!allowed.includes(name)) {
    return { pid: numeric, name, killed: false, reason: `映像名不在白名单（${name}）` };
  }
  const res = await runCommand('taskkill', ['/PID', String(numeric), '/T', '/F']);
  return {
    pid: numeric,
    name,
    killed: res.code === 0,
    reason: res.code === 0 ? 'killed' : (res.stderr || res.stdout || '').trim().slice(0, 160),
  };
}

/** 结束占用某端口的、映像名在白名单内的进程。 */
async function killPortOwners(port, allowed = KILLABLE) {
  const results = [];
  for (const pid of await listListeningPids(port)) {
    results.push(await killIfAllowed(pid, allowed));
  }
  return results;
}

async function waitForPortFree(port, { timeoutMs = 8000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listListeningPids(port)).length === 0) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return (await listListeningPids(port)).length === 0;
}

function openInBrowser(url) {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch (err) {
    log.warn(`打开浏览器失败：${err.message}`);
    return false;
  }
}

// MARK: - state.json

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeStateFile(payload) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ managedBy: MANAGED_BY, ...payload }, null, 2), 'utf8');
    return true;
  } catch (err) {
    log.warn(`写 state.json 失败：${err.message}`);
    return false;
  }
}

function removeStateFile() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch { /* ignore */ }
}

/** 从 state.json 里收集所有形如 xxxPid 的 PID（兼容 PS 脚本写的旧格式）。 */
export function collectRecordedPids(state) {
  if (!state || typeof state !== 'object') return [];
  const out = new Set();
  for (const [key, value] of Object.entries(state)) {
    if (!/pid$/i.test(key)) continue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 8 && n !== process.pid) out.add(n);
  }
  return [...out];
}

// MARK: - 配置脱敏展示

const SECRET_KEY_RE = /(api[-_]?key|token|secret|password|authorization)/i;

/** 给 UI 展示用的配置副本：任何疑似密钥只显示是否已设置与长度。 */
export function maskConfigSecrets(value, keyName = '') {
  if (Array.isArray(value)) return value.map((item) => maskConfigSecrets(item, keyName));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskConfigSecrets(v, k);
    return out;
  }
  if (typeof value === 'string' && SECRET_KEY_RE.test(keyName)) {
    return value === '' ? '<empty>' : `<set:${value.length}>`;
  }
  return value;
}

/** 备份根目录（与 science-control.backupDataDir 的默认位置保持一致）。 */
export function backupsRoot(cfg) {
  return path.join(cfg.science.dataDir, '..', 'aiusage-science-backups');
}

export function readConfigForDisplay(configPath) {
  const p = resolveConfigPath(configPath);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { path: p, exists: true, config: maskConfigSecrets(raw) };
  } catch (err) {
    return { path: p, exists: fs.existsSync(p), config: null, error: err.message };
  }
}

/** 归一化的可编辑配置视图（密钥打码）；配置本身不合法时返回错误对象而不是抛错。 */
export function readConfigForEditing(configPath) {
  try {
    return { ok: true, ...configForEditing(loadConfig(configPath)) };
  } catch (err) {
    return { ok: false, error: err.message, path: resolveConfigPath(configPath) };
  }
}

// MARK: - 默认依赖（测试可注入替身）
export function defaultDeps() {
  return {
    async startInference(cfg, { analytics = null } = {}) {
      const { server } = createInferenceServer(cfg, { analytics });
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(new AppServiceError(`推理代理监听 :${cfg.ports.inference} 失败：${err.message}`, { stage: 'inference' }));
        server.once('error', onError);
        server.listen(cfg.ports.inference, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
      return {
        port: cfg.ports.inference,
        close: () => new Promise((resolve) => {
          const done = () => resolve();
          server.close(done);
          server.closeAllConnections?.();
          setTimeout(done, 1500).unref?.();
        }),
      };
    },

    createSession(cfg) {
      return createSessionProxy(cfg);
    },

    spawnDaemon(cfg, { logDir }) {
      const args = [
        'serve',
        '--data-dir', cfg.science.dataDir,
        '--port', String(cfg.ports.daemon),
        '--sandbox-port', String(cfg.ports.sandbox),
        '--detached',
        '--no-browser',
      ];
      if (cfg.science.noAutoUpdate) args.push('--no-auto-update');
      fs.mkdirSync(logDir, { recursive: true });
      const child = spawn(cfg.science.binaryPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.ports.inference}`,
          ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
          ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_KEY,
          no_proxy: '127.0.0.1,localhost,::1',
          NO_PROXY: '127.0.0.1,localhost,::1',
        },
      });
      const outStream = fs.createWriteStream(path.join(logDir, 'daemon-serve.log'), { flags: 'a' });
      const errStream = fs.createWriteStream(path.join(logDir, 'daemon-serve.err.log'), { flags: 'a' });
      child.stdout?.pipe(outStream);
      child.stderr?.pipe(errStream);
      return { pid: child.pid ?? null, child, outStream, errStream };
    },

    /** 停止 daemon：官方 CLI 优雅停 → 端口占用者兜底。 */
    async stopDaemonChain(cfg) {
      const cli = await stopDaemon(cfg);
      const killed = [];
      for (const name of CLEAN_PORTS) {
        const port = cfg.ports[name];
        if (!port) continue;
        const owners = await listListeningPids(port);
        for (const pid of owners) {
          const name2 = await processImageName(pid);
          if (name2 === 'claude-science.exe') {
            killed.push(await killIfAllowed(pid, ['claude-science.exe']));
          }
        }
      }
      await waitForPortFree(cfg.ports.daemon, { timeoutMs: 6000 });
      return { cli, killed };
    },

    backup: (cfg) => backupDataDir(cfg),
    inspectLogin: (dataDir) => inspectVirtualLogin(dataDir),
    writeLogin: ({ dataDir, force = false }) => writeVirtualLogin({ dataDir, force }),
    removeLogin: ({ dataDir }) => removeVirtualLogin({ dataDir }),
    restoreBackup: (dir, cfg) => restoreBackup(dir, cfg),
    runDoctor: (cfg) => runDoctor(cfg),
    probe: (url, opts) => probeHTTP(url, opts),
    waitHealth: (port, opts) => waitForHealth(port, opts),
    saveConfig: (patch, targetPath) => saveConfigPatch(targetPath, patch),
    probeUpstream: (upstream, opts) => runProbe(upstream, opts),
    listListeningPids,
    killPortOwners,
    describePid: processImageName,
    killIfAllowed,
    waitForPortFree,
    openUrl: openInBrowser,
    readStateFile,
    writeStateFile,
    removeStateFile,
    logDir: (cfg) => cfg.logging.dir,
  };
}

// MARK: - 编排服务

export function createAppService({
  configPath = null,
  skipBackup = false,
  openBrowser = false,
  healthTimeoutMs = 120_000,
  deps: overrides = {},
  bus: injectedBus = null,
} = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const bus = injectedBus ?? createLogBus();
  attachProcessLogs(bus, { source: 'proxy' });

  const state = {
    phase: 'stopped',
    stage: null,
    startedAt: null,
    lastError: null,
    lastErrorStage: null,
    degraded: false,
    loginMode: null,
    daemonPid: null,
    recentOps: [],
  };

  let cfg = null;
  let analytics = null;
  let analyticsDir = null;
  let inference = null;
  let session = null;
  let daemon = null;
  let daemonDetach = [];
  const eventSubscribers = new Set();

  function emit(event) {
    const payload = { ts: new Date().toISOString(), phase: state.phase, ...event };
    if (payload.type === 'error' || payload.type === 'warn') {
      state.recentOps.push({ ts: payload.ts, type: payload.type, message: payload.message ?? '' });
      if (state.recentOps.length > 30) state.recentOps.shift();
    }
    for (const fn of eventSubscribers) {
      try {
        fn(payload);
      } catch { /* 订阅者异常忽略 */ }
    }
  }

  function setPhase(phase) {
    state.phase = phase;
    emit({ type: 'phase', phase });
  }

  async function stage(name, fn) {
    state.stage = name;
    const label = STAGE_LABELS[name] ?? name;
    emit({ type: 'stage', stage: name, label });
    log.info(`[${name}] ${label}`);
    const t0 = Date.now();
    const result = await fn();
    log.info(`[${name}] 完成（${Date.now() - t0}ms）`);
    return result;
  }

  function entryUrl() {
    const c = cfg ?? safeLoadConfig();
    return c ? `http://localhost:${c.ports.publicEntry}/` : null;
  }

  function safeLoadConfig() {
    try {
      return loadConfig(configPath);
    } catch {
      return null;
    }
  }

  /** 调用记录存储（懒加载；日志目录变了就换一个）。 */
  function getAnalytics(configNow = null) {
    const c = configNow ?? cfg ?? safeLoadConfig();
    const dir = c?.logging?.dir ?? null;
    if (!analytics || analyticsDir !== dir) {
      analytics = createAnalyticsStore({ dir });
      analyticsDir = dir;
    }
    return analytics;
  }

  // ---- 启动 ----

  async function start(options = {}) {
    if (state.phase === 'starting') throw new AppServiceError('启动已在进行中');
    if (state.phase === 'running') {
      emit({ type: 'warn', message: '链路已在运行，跳过重复启动' });
      return await status();
    }
    const doBackup = options.skipBackup ?? skipBackup;
    const timeout = options.healthTimeoutMs ?? healthTimeoutMs;

    setPhase('starting');
    state.lastError = null;
    state.lastErrorStage = null;
    state.degraded = false;

    const undo = [];
    const rollback = async (err) => {
      emit({ type: 'warn', message: '启动失败，正在回滚已启动的组件…' });
      for (const fn of undo.reverse()) {
        try {
          await fn();
        } catch (e) {
          log.warn(`回滚步骤失败：${e.message}`);
          emit({ type: 'warn', message: `回滚步骤失败：${e.message}` });
        }
      }
      deps.removeStateFile();
    };

    try {
      await stage('validate', async () => {
        const c = loadConfig(configPath);
        cfg = c;
        // restart 场景：先关掉上一次的日志流，避免句柄泄漏
        log.close();
        configureLogging({ level: c.logging.level, dir: c.logging.dir, fileName: 'app.log' });
        if (!fs.existsSync(c.science.dataDir)) {
          throw new AppServiceError(`找不到 Claude Science 数据目录：${c.science.dataDir}`, {
            stage: 'validate',
            hint: '请先启动一次 Claude Science 桌面应用（它会在首次运行时生成 encryption.key 等文件），再回来启动代理链。',
          });
        }
        if (!fs.existsSync(c.science.binaryPath)) {
          throw new AppServiceError(`找不到 Claude Science 可执行文件：${c.science.binaryPath}`, {
            stage: 'validate',
            hint: '请确认安装路径，或在 config.json 里修改 science.binaryPath。',
          });
        }
        log.info('配置校验通过', describeConfig(c));
        return c;
      });

      if (!doBackup) {
        await stage('backup', async () => {
          const result = await deps.backup(cfg);
          emit({ type: 'note', message: `已备份 ${result.copied.length} 项到 ${result.dest}` });
          return result;
        });
      } else {
        emit({ type: 'note', message: '按参数跳过备份' });
      }

      await stage('login', async () => {
        const info = await deps.inspectLogin(cfg.science.dataDir);
        if (!info.keyAvailable) {
          throw new AppServiceError(`读不到 encryption.key（${info.keyError ?? '未知原因'}）`, {
            stage: 'login',
            hint: '请先启动一次 Claude Science 桌面应用以生成密钥文件。',
          });
        }
        if (info.hasRealLogin) {
          state.loginMode = 'real';
          emit({ type: 'note', message: '检测到真实 Claude 登录：直接复用，不写虚拟凭证' });
          return info;
        }
        if (info.tokens.length > 0) {
          state.loginMode = 'virtual-reuse';
          emit({ type: 'note', message: '复用已有虚拟登录凭证' });
          return info;
        }
        const written = await deps.writeLogin({ dataDir: cfg.science.dataDir });
        state.loginMode = 'virtual-created';
        emit({ type: 'note', message: `已写入虚拟登录：${written.file}（虚构账号，不联网）` });
        return written;
      });

      await stage('cleanup', async () => {
        const killed = [];
        const previous = deps.readStateFile();
        for (const pid of collectRecordedPids(previous)) {
          const r = await deps.killIfAllowed(pid, ['node.exe', 'electron.exe']);
          if (r.killed) killed.push(`pid ${r.pid}(${r.name})`);
        }
        await deps.stopDaemonChain(cfg);
        for (const name of CLEAN_PORTS) {
          const port = cfg.ports[name];
          const results = await deps.killPortOwners(port);
          for (const r of results) if (r.killed) killed.push(`pid ${r.pid}(${r.name}) 占用 :${port}`);
        }
        const busy = [];
        for (const name of CLEAN_PORTS) {
          const owners = await deps.listListeningPids(cfg.ports[name]);
          for (const pid of owners) {
            const owner = await deps.describePid?.(pid);
            busy.push(`:${cfg.ports[name]} 被 pid ${pid}${owner ? `(${owner})` : ''} 占用`);
          }
        }
        if (busy.length > 0) {
          throw new AppServiceError(`启动前端口仍被占用：${busy.join('；')}`, {
            stage: 'cleanup',
            hint: '这些端口被非本工具的进程占用，请先释放（或修改 config.json 的 ports）。',
          });
        }
        // 沙箱端口由 daemon 内部持有（残留 daemon 会同时占着它）：这里只提示，不查杀
        const sandboxOwners = await deps.listListeningPids(cfg.ports.sandbox);
        if (sandboxOwners.length > 0) {
          emit({
            type: 'warn',
            message: `沙箱端口 :${cfg.ports.sandbox} 已被 pid ${sandboxOwners.join(',')} 占用，daemon 可能启动失败`,
          });
        }
        if (killed.length > 0) emit({ type: 'note', message: `已清理残留进程：${killed.join('、')}` });
        deps.removeStateFile();
        return { killed };
      });

      await stage('inference', async () => {
        inference = await deps.startInference(cfg, { analytics: getAnalytics(cfg) });
        undo.push(async () => {
          if (inference) await inference.close();
          inference = null;
        });
        const ready = await deps.probe(`http://127.0.0.1:${cfg.ports.inference}/health`, { timeoutMs: 3000 });
        if (!ready.ok) {
          throw new AppServiceError(`推理代理未就绪（:${cfg.ports.inference}）：${ready.error ?? `HTTP ${ready.status}`}`, { stage: 'inference' });
        }
        emit({ type: 'note', message: `推理代理已监听 http://127.0.0.1:${cfg.ports.inference}` });
        return inference;
      });

      await stage('daemon-start', async () => {
        daemon = deps.spawnDaemon(cfg, { logDir: deps.logDir(cfg) });
        state.daemonPid = daemon.pid ?? null;
        if (daemon.child?.stdout) {
          daemonDetach.push(attachStreamLines(daemon.child.stdout, bus, { source: 'daemon' }));
        }
        if (daemon.child?.stderr) {
          daemonDetach.push(attachStreamLines(daemon.child.stderr, bus, { source: 'daemon', level: 'error' }));
        }
        undo.push(async () => {
          for (const detach of daemonDetach.splice(0)) detach();
          await deps.stopDaemonChain(cfg);
          daemon = null;
          state.daemonPid = null;
        });
        if (daemon.child) {
          daemon.child.on('exit', (code) => {
            log.info(`daemon 启动器退出（code=${code}），实际守护进程可能仍在后台`);
          });
        }
        emit({ type: 'note', message: `daemon 已拉起（启动器 pid ${state.daemonPid ?? '-'}）` });
        return daemon;
      });

      await stage('daemon-health', async () => {
        const healthy = await deps.waitHealth(cfg.ports.daemon, { timeoutMs: timeout, path: '/health' });
        if (!healthy) {
          throw new AppServiceError(`daemon 未在 ${Math.round(timeout / 1000)}s 内就绪`, {
            stage: 'daemon-health',
            hint: `详见 ${path.join(deps.logDir(cfg), 'daemon-serve.err.log')}`,
          });
        }
        emit({ type: 'note', message: `daemon 就绪（:${cfg.ports.daemon}）` });
        return true;
      });

      await stage('session', async () => {
        session = deps.createSession(cfg);
        await session.start();
        undo.push(async () => {
          if (session) await session.stop();
          session = null;
        });
        emit({
          type: 'note',
          message: `会话反代已监听 http://localhost:${cfg.ports.publicEntry} → daemon :${cfg.ports.daemon}`,
        });
        return session;
      });

      await stage('probe', async () => {
        const result = await session.probe();
        if (result.ok) {
          emit({ type: 'note', message: `公开入口自探通过：${entryUrl()}（已登录，无需点一次性链接）` });
        } else {
          state.degraded = true;
          emit({
            type: 'warn',
            message: `公开入口自探未通过（${result.error ?? `HTTP ${result.status}`}）——会话 cookie 可能仍在后台重铸，刷新页面即可`,
          });
        }
        return result;
      });

      state.startedAt = new Date().toISOString();
      setPhase('running');
      deps.writeStateFile({
        managedBy: MANAGED_BY,
        phase: 'running',
        startedAt: state.startedAt,
        hostPid: process.pid,
        daemonPid: state.daemonPid,
        configPath: cfg.configPath,
        ports: cfg.ports,
        inProcess: ['inference', 'session'],
      });
      emit({ type: 'done', message: `链路已就绪：${entryUrl()}`, url: entryUrl() });
      if (openBrowser) deps.openUrl(entryUrl());
      return await status();
    } catch (err) {
      await rollback(err);
      state.lastError = err.message;
      state.lastErrorStage = err.stage ?? state.stage;
      setPhase('error');
      emit({
        type: 'error',
        stage: state.lastErrorStage,
        message: err.message,
        hint: err.hint ?? null,
      });
      throw err;
    }
  }

  // ---- 停止 ----

  async function stop() {
    if (state.phase === 'stopping') throw new AppServiceError('停止已在进行中');
    setPhase('stopping');
    const steps = [];
    const cfgNow = cfg ?? safeLoadConfig();

    if (session) {
      try {
        await session.stop();
        steps.push('会话反代已停止');
      } catch (err) {
        steps.push(`会话反代停止失败：${err.message}`);
      }
      session = null;
    }

    if (cfgNow) {
      try {
        const result = await deps.stopDaemonChain(cfgNow);
        const killed = (result?.killed ?? []).filter((k) => k.killed).length;
        steps.push(`daemon 已停止（CLI code=${result?.cli?.code ?? '-'}${killed ? `，兜底结束 ${killed} 个进程` : ''}）`);
      } catch (err) {
        steps.push(`daemon 停止失败：${err.message}`);
      }
    }

    if (inference) {
      try {
        await inference.close();
        steps.push('推理代理已停止');
      } catch (err) {
        steps.push(`推理代理停止失败：${err.message}`);
      }
      inference = null;
    }

    for (const detach of daemonDetach.splice(0)) detach();
    daemon = null;
    state.daemonPid = null;

    // 兜底：把上次 PS 脚本留下的独立 node 代理也清掉
    if (cfgNow) {
      const previous = deps.readStateFile();
      for (const pid of collectRecordedPids(previous)) {
        const r = await deps.killIfAllowed(pid, ['node.exe', 'electron.exe']);
        if (r.killed) steps.push(`已清理残留 pid ${r.pid}(${r.name})`);
      }
      for (const name of CLEAN_PORTS) {
        const owners = await deps.listListeningPids(cfgNow.ports[name]);
        for (const pid of owners) {
          const r = await deps.killIfAllowed(pid, ['node.exe']);
          if (r.killed) steps.push(`已清理占用 :${cfgNow.ports[name]} 的 node(pid ${r.pid})`);
        }
      }
    }

    deps.removeStateFile();
    state.phase = 'stopped';
    state.stage = null;
    state.startedAt = null;
    state.degraded = false;
    emit({ type: 'phase', phase: 'stopped' });

    const leftovers = cfgNow
      ? (await Promise.all(CLEAN_PORTS.map(async (name) => ({
        port: cfgNow.ports[name],
        owners: await deps.listListeningPids(cfgNow.ports[name]),
      })))).filter((x) => x.owners.length > 0)
      : [];

    if (leftovers.length > 0) {
      emit({ type: 'warn', message: `仍有端口被占用：${leftovers.map((x) => `:${x.port}(pid ${x.owners.join(',')})`).join('、')}` });
    }
    emit({ type: 'done', message: '链路已停止（虚拟登录凭证保留）' });
    log.close();
    return { ok: leftovers.length === 0, steps, leftovers };
  }

  async function restart(options = {}) {
    await stop();
    return await start(options);
  }

  // ---- 状态 ----

  async function status() {
    const cfgNow = safeLoadConfig();
    const ports = cfgNow?.ports ?? null;
    const probes = ports
      ? await Promise.all([
        deps.probe(`http://127.0.0.1:${ports.inference}/health`, { timeoutMs: 1500 }),
        deps.probe(`http://127.0.0.1:${ports.daemon}/health`, { timeoutMs: 1500 }),
        deps.probe(`http://127.0.0.1:${ports.publicEntry}/`, { timeoutMs: 2000 }),
      ])
      : [null, null, null];

    let login = null;
    if (cfgNow) {
      try {
        const info = await deps.inspectLogin(cfgNow.science.dataDir);
        login = {
          dataDir: info.dataDir,
          keyAvailable: info.keyAvailable,
          keyError: info.keyError ?? null,
          files: info.files ?? [],
          hasRealLogin: !!info.hasRealLogin,
          tokens: (info.tokens ?? []).map((t) => ({
            file: t.file,
            userId: t.userId,
            email: t.email ?? null,
            provider: t.provider ?? null,
            expiresAt: t.expiresAt ?? null,
            virtual: !!t.virtual,
            decryptError: t.decryptError ?? null,
          })),
        };
      } catch (err) {
        login = { error: err.message };
      }
    }

    return {
      phase: state.phase,
      stage: state.stage,
      stageLabel: state.stage ? (STAGE_LABELS[state.stage] ?? state.stage) : null,
      startedAt: state.startedAt,
      degraded: state.degraded,
      loginMode: state.loginMode,
      // 阶段 1 曾漏把这个字段放进返回值，导致界面上的登录态一直是空的
      login,
      daemonPid: state.daemonPid,
      hostPid: process.pid,
      lastError: state.lastError,
      lastErrorStage: state.lastErrorStage,
      recentOps: state.recentOps.slice(-10),
      entryUrl: ports ? `http://localhost:${ports.publicEntry}/` : null,
      ports,
      endpoints: ports ? {
        inference: { port: ports.inference, listening: !!(probes[0]?.ok), status: probes[0]?.status ?? probes[0]?.error ?? null },
        daemon: { port: ports.daemon, listening: !!(probes[1]?.ok), status: probes[1]?.status ?? probes[1]?.error ?? null },
        publicEntry: { port: ports.publicEntry, listening: !!(probes[2]?.ok), status: probes[2]?.status ?? probes[2]?.error ?? null },
        sandbox: { port: ports.sandbox, listening: null, status: '由 daemon 管理' },
      } : null,
      // 多上游：界面看的是脱敏列表；upstream 保留为主上游（兼容旧视图）
      upstreams: cfgNow ? cfgNow.upstreams.map((u) => ({
        id: u.id,
        label: u.label,
        baseURL: u.baseURL,
        apiKey: u.apiKey ? `<set:${u.apiKey.length}>` : '<missing>',
        apiMode: u.apiMode,
        maxTokensField: u.maxTokensField,
        sendStreamUsage: u.sendStreamUsage,
        supportsTools: u.supportsTools,
        supportsReasoningEffort: u.supportsReasoningEffort,
        supportsParallelTools: u.supportsParallelTools,
        timeoutMs: u.timeoutMs,
        isLoopback: u.isLoopback,
      })) : null,
      upstream: cfgNow ? {
        id: cfgNow.upstream.id,
        label: cfgNow.upstream.label,
        baseURL: cfgNow.upstream.baseURL,
        apiKey: cfgNow.upstream.apiKey ? '<set>' : '<missing>',
        supportsTools: cfgNow.upstream.supportsTools,
        supportsReasoningEffort: cfgNow.upstream.supportsReasoningEffort,
        sendStreamUsage: cfgNow.upstream.sendStreamUsage,
        maxTokensField: cfgNow.upstream.maxTokensField,
      } : null,
      models: cfgNow ? cfgNow.models.map((m) => ({
        id: m.id,
        publishAs: m.publishAs,
        displayName: m.displayName,
        upstream: m.upstreamId,
      })) : [],
      tiers: cfgNow?.tiers ?? null,
      defaultModel: cfgNow?.defaultModel ?? null,
      unknownModelPolicy: cfgNow?.unknownModelPolicy ?? null,
      science: cfgNow ? {
        dataDir: cfgNow.science.dataDir,
        binaryPath: cfgNow.science.binaryPath,
        binaryExists: fs.existsSync(cfgNow.science.binaryPath),
        noAutoUpdate: cfgNow.science.noAutoUpdate,
      } : null,
      logging: cfgNow ? { level: cfgNow.logging.level, dir: cfgNow.logging.dir } : null,
      analytics: cfgNow ? (() => {
        const store = getAnalytics(cfgNow);
        return { dir: store.dir, ...store.stats() };
      })() : null,
      configPath: cfgNow?.configPath ?? resolveConfigPath(configPath),
      configError: cfgNow ? null : (() => {
        try {
          loadConfig(configPath);
          return null;
        } catch (err) {
          return err instanceof ConfigError ? err.message : err.message;
        }
      })(),
    };
  }

  return {
    state,
    bus,
    /** 订阅编排事件（stage/phase/log/warn/error/done）。 */
    onEvent(fn) {
      eventSubscribers.add(fn);
      return () => eventSubscribers.delete(fn);
    },
    getConfigPath: () => resolveConfigPath(configPath),
    entryUrl,
    openEntry: () => deps.openUrl(entryUrl()),
    /**
     * 启动桌面 app（无参，等同双击桌面图标）。
     *
     * 阶段 4 spike 实测结论（详见 docs/WINDOWS_SCIENCE_APP_ROADMAP.md）：
     * 只要我们的 daemon 在跑（auth-owner.lock 指向它），无参启动的桌面 app 会**附着**到
     * 这个 daemon、不另起实例，并用 daemon 自己发布的 Web UI（:daemonPort + nonce）打开窗口——
     * 因此窗口本身就是「已登录」的。不需要占端口或改写 lock 文件。
     */
    openDesktopApp() {
      const cfgNow = loadConfig(configPath);
      const child = spawn(cfgNow.science.binaryPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      emit({
        type: 'note',
        message: `已启动桌面 app（pid ${child.pid ?? '-'}）：它会附着到当前 daemon，窗口即已登录`,
      });
      return { pid: child.pid ?? null, binaryPath: cfgNow.science.binaryPath };
    },
    start,
    stop,
    restart,
    status,
    isRunning: () => state.phase === 'running',
    readConfigForDisplay: () => readConfigForDisplay(configPath),
    /** 归一化的可编辑配置视图（密钥打码）。 */
    readConfigForEditing: () => readConfigForEditing(configPath),
    /** 调用记录与成本统计（阶段 3）。 */
    analyticsSummary: (options = {}) => getAnalytics().summarize({ days: options.days ?? 7 }),
    analyticsRecent: (n = 100) => getAnalytics().recent(n),
    analyticsDir: () => getAnalytics().dir,
    /** 写入虚拟登录（默认拒绝覆盖非本工具写入的凭证）。 */
    async loginWrite(options = {}) {
      const cfgNow = loadConfig(configPath);
      const result = await deps.writeLogin({ dataDir: cfgNow.science.dataDir, force: options.force === true });
      emit({
        type: 'note',
        message: `已写入虚拟登录：${result.file ?? '(已写入)'}`
          + `${result.removedFiles?.length ? `；清理旧虚拟令牌 ${result.removedFiles.length} 个` : ''}`,
      });
      return result;
    },
    /** 移除本工具写入的虚拟令牌（只删带标记的）。 */
    async loginRemove() {
      const cfgNow = loadConfig(configPath);
      const result = await deps.removeLogin({ dataDir: cfgNow.science.dataDir });
      emit({
        type: 'note',
        message: result.removed ? `已移除虚拟登录：${result.file}` : `未移除：${result.reason ?? '未知原因'}`,
      });
      return result;
    },
    /** 备份列表（真实 data-dir 的凭据/状态文件）。 */
    async backupsList() {
      const cfgNow = loadConfig(configPath);
      const root = backupsRoot(cfgNow);
      let names = [];
      try {
        names = fs.readdirSync(root, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name);
      } catch {
        names = [];
      }
      const entries = [];
      for (const name of names.sort().reverse()) {
        const dir = path.join(root, name);
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backup-manifest.json'), 'utf8'));
        } catch { /* 没有清单也照常列出 */ }
        entries.push({
          name,
          dir,
          createdAt: manifest?.createdAt ?? null,
          copied: manifest?.copied ?? null,
          missing: manifest?.missing ?? null,
        });
      }
      return { root, entries };
    },
    /** 立即创建一次备份。 */
    async backupCreate() {
      const cfgNow = loadConfig(configPath);
      const result = await deps.backup(cfgNow);
      emit({ type: 'note', message: `已备份 ${result.copied.length} 项到 ${result.dest}` });
      return result;
    },
    /** 从某个备份目录还原（危险操作：会覆盖当前凭据/状态文件）。 */
    async backupRestore(options = {}) {
      if (!options.dir) throw new AppServiceError('缺少备份目录');
      const cfgNow = loadConfig(configPath);
      const restored = await deps.restoreBackup(options.dir, cfgNow);
      emit({
        type: 'warn',
        message: `已从备份还原 ${restored.length} 项：${options.dir}（建议重启链路）`,
      });
      return { restored, dir: options.dir, needRestart: state.phase === 'running' };
    },
    /** doctor：把对 Science 私有协议的假设变成可复现断言。 */
    async doctor() {
      const cfgNow = loadConfig(configPath);
      const report = await deps.runDoctor(cfgNow);
      emit({
        type: report.summary.fail > 0 ? 'warn' : 'note',
        message: `doctor：通过 ${report.summary.pass}，失败 ${report.summary.fail}，跳过 ${report.summary.skip}`,
      });
      return report;
    },
    /** 保存配置补丁：先校验再落盘；返回保存后的可编辑视图。 */
    async saveConfig(patch) {
      const result = await deps.saveConfig(patch ?? {}, configPath);
      cfg = null; // 让下一次状态/启动重新读盘
      const needRestart = state.phase === 'running' || state.phase === 'starting';
      emit({
        type: 'note',
        message: `配置已保存：${result.path}${needRestart ? '（运行中的链路需重启后生效）' : ''}`,
      });
      return { saved: true, path: result.path, needRestart, editing: configForEditing(result.cfg) };
    },
    /**
     * 一键探测上游（只走流式）。默认探测已保存的主上游；
     * 可传 upstreamId 或临时的 baseURL / apiKey（界面里未保存的编辑也能先试）。
     */
    async probeUpstream(options = {}) {
      const cfgNow = loadConfig(configPath);
      const wantedId = options.upstreamId ?? cfgNow.upstream.id;
      const saved = cfgNow.upstreamById.get(wantedId) ?? null;
      if (!saved && !options.baseURL) {
        throw new AppServiceError(`未知上游：${wantedId}`, {
          hint: `可用：${[...cfgNow.upstreamById.keys()].join(', ')}`,
        });
      }
      const target = normalizeUpstream({
        ...(saved ?? {}),
        id: wantedId,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      }, 0, wantedId);
      const probeModel = options.model ?? cfgNow.defaultModel;
      emit({ type: 'note', message: `开始探测上游 ${target.id}（模型 ${probeModel}，只走流式）` });
      const report = await deps.probeUpstream(target, { model: probeModel, deep: options.deep !== false });
      const toolCount = (report.tools?.toolCalls ?? []).length;
      emit({
        type: report.ok ? 'note' : 'warn',
        message: `探测${report.ok ? '完成' : '未通过'}：流式=${report.stream?.ok ? 'OK' : '失败'}`
          + (report.tools ? `，工具调用=${toolCount > 0 ? 'OK' : '未观察到'}` : '')
          + (report.reasoningEffort ? `，effort=${report.reasoningEffort.ok ? 'OK' : '不支持'}` : ''),
      });
      return report;
    },
  };
}

// MARK: - CLI

function parseArgs(argv) {
  const out = { config: null, json: false, noBackup: false, noBrowser: false, healthTimeout: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') out.config = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--no-backup') out.noBackup = true;
    else if (arg === '--no-browser') out.noBrowser = true;
    else if (arg === '--health-timeout') out.healthTimeout = Number(argv[++i]) * 1000;
  }
  return out;
}

function renderEvent(json) {
  return (event) => {
    if (json) {
      console.log(JSON.stringify(event));
      return;
    }
    const label = event.label ? ` ${event.label}` : '';
    switch (event.type) {
      case 'stage': console.log(`\n==> [${event.stage}]${label}`); break;
      case 'note': console.log(`    · ${event.message}`); break;
      case 'warn': console.warn(`    ! ${event.message}`); break;
      case 'error': console.error(`    × [${event.stage ?? '-'}] ${event.message}${event.hint ? `\n      提示：${event.hint}` : ''}`); break;
      case 'done': console.log(`\n${event.message}`); break;
      default: break;
    }
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'status';
  const opts = parseArgs(argv.slice(1));

  if (command === 'status') {
    const service = createAppService({ configPath: opts.config });
    const s = await service.status();
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.endpoints && (s.endpoints.inference.listening || s.endpoints.daemon.listening || s.endpoints.publicEntry.listening) ? 0 : 1);
  }

  if (command === 'stop') {
    const service = createAppService({ configPath: opts.config });
    const result = await service.stop();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'restart' || command === 'start') {
    const service = createAppService({
      configPath: opts.config,
      skipBackup: opts.noBackup,
      openBrowser: !opts.noBrowser && command === 'start',
      ...(opts.healthTimeout ? { healthTimeoutMs: opts.healthTimeout } : {}),
    });
    service.onEvent(renderEvent(opts.json));
    try {
      if (command === 'restart') await service.stop();
      await service.start();
    } catch (err) {
      console.error(`启动失败：${err.message}`);
      process.exit(1);
    }
    console.log('\n链路已在前台运行（Ctrl+C 停止；本模式下两个代理随本进程退出）。');
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await service.stop();
    process.exit(0);
  }

  if (command === 'open') {
    const service = createAppService({ configPath: opts.config });
    const url = service.entryUrl();
    if (!url) {
      console.error('配置无法加载，取不到公开入口地址');
      process.exit(1);
    }
    openInBrowser(url);
    console.log(url);
    process.exit(0);
  }

  console.error('用法：node src/app-service.mjs [start|stop|restart|status|open] [--config <path>] [--json] [--no-backup] [--no-browser]');
  process.exit(2);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`执行失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}
