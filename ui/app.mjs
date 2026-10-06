/**
 * 渲染进程入口（阶段 1）：
 *  - 状态轮询（4s）+ 编排事件/日志订阅
 *  - 视图路由（hash）
 *  - 顶栏一键启停（启动/停止/重启/打开界面）
 *
 * 所有数据都来自 preload 暴露的窄 API，页面自身没有任何网络/文件权限。
 */
import { el, clear, fmtDuration } from './dom.mjs';
import dashboard from './views/dashboard.mjs';
import nodeConfig from './views/node-config.mjs';
import logs from './views/logs.mjs';
import analytics from './views/analytics.mjs';
import login from './views/login.mjs';
import settings from './views/settings.mjs';

const api = window.aiusage;
const VIEWS = [dashboard, nodeConfig, logs, analytics, login, settings];
const MAX_EVENTS = 200;
const MAX_LOGS = 2000;
const POLL_MS = 4000;

const state = {
  status: null,
  config: null,
  events: [],
  logs: [],
  busy: null,
  statusError: null,
};

const logSubscribers = new Set();
const eventSubscribers = new Set();
let currentView = null;
let viewInstance = null;

const navEl = document.getElementById('nav');
const viewEl = document.getElementById('view');
const pillEl = document.getElementById('phase-pill');
const detailEl = document.getElementById('phase-detail');
const bannerEl = document.getElementById('banner');
const buttons = {
  start: document.getElementById('btn-start'),
  stop: document.getElementById('btn-stop'),
  restart: document.getElementById('btn-restart'),
  open: document.getElementById('btn-open'),
};

document.getElementById('foot-version').textContent =
  `Electron ${api.versions.electron ?? '?'} · Chromium ${api.versions.chrome ?? '?'}`;

// MARK: - 横幅

function setBanner(kind, message, hint = null, stage = null) {
  if (!kind) {
    bannerEl.className = 'banner hidden';
    clear(bannerEl);
    return;
  }
  bannerEl.className = `banner banner-${kind}`;
  clear(bannerEl);
  bannerEl.append(el('div', { text: stage ? `[${stage}] ${message}` : message }));
  if (hint) bannerEl.append(el('div', { class: 'banner-hint', text: `提示：${hint}` }));
}

// MARK: - 顶栏

const PHASES = {
  stopped: { label: '已停止', cls: 'pill-idle' },
  starting: { label: '启动中…', cls: 'pill-busy' },
  running: { label: '运行中', cls: 'pill-run' },
  stopping: { label: '停止中…', cls: 'pill-busy' },
  error: { label: '启动失败', cls: 'pill-err' },
};

function renderTop() {
  const status = state.status;
  const phase = status?.phase ?? 'stopped';
  const meta = PHASES[phase] ?? { label: phase, cls: 'pill-idle' };
  const degraded = phase === 'running' && status?.degraded;
  pillEl.className = `pill ${degraded ? 'pill-warn' : meta.cls}`;
  pillEl.textContent = degraded ? '运行中（降级）' : meta.label;

  detailEl.textContent = [
    (phase === 'starting' || phase === 'error') && status?.stageLabel ? `阶段：${status.stageLabel}` : null,
    phase === 'running' && status?.startedAt ? `已运行 ${fmtDuration(status.startedAt)}` : null,
    phase === 'running' && status?.entryUrl ? status.entryUrl : null,
    state.busy ? `正在执行：${state.busy}` : null,
    state.statusError ? `状态读取失败：${state.statusError}` : null,
  ].filter(Boolean).join(' · ');

  const busy = !!state.busy;
  buttons.start.disabled = busy || phase === 'running' || phase === 'starting';
  buttons.stop.disabled = busy || phase === 'stopped' || phase === 'stopping';
  buttons.restart.disabled = busy || phase === 'starting' || phase === 'stopping';
  buttons.open.disabled = !status?.entryUrl;
}

// MARK: - 动作

async function runAction(name) {
  if (state.busy) return;
  state.busy = { start: '启动链路', stop: '停止链路', restart: '重启链路' }[name] ?? name;
  setBanner(null);
  renderTop();
  try {
    const res = name === 'start' ? await api.start({})
      : name === 'stop' ? await api.stop()
        : await api.restart({});
    if (!res.ok) {
      setBanner('err', `${state.busy}失败：${res.error.message}`, res.error.hint, res.error.stage);
    } else if (name === 'stop') {
      const detail = res.data;
      setBanner(
        detail.ok ? 'ok' : 'warn',
        detail.ok ? '链路已停止（无残留端口）' : '已停止，但仍有端口被占用',
        (detail.steps ?? []).join('\n'),
      );
    } else {
      setBanner('ok', `${state.busy}完成`);
    }
  } catch (err) {
    setBanner('err', `${state.busy}异常：${err.message}`);
  } finally {
    state.busy = null;
    await refreshStatus();
  }
}

// MARK: - 状态刷新

async function refreshStatus() {
  try {
    const res = await api.status();
    if (res.ok) {
      state.status = res.data;
      state.statusError = null;
    } else {
      state.statusError = res.error.message;
    }
  } catch (err) {
    state.statusError = err.message;
  }
  updateView();
  renderTop();
}

/** 重新拉取配置（保存后调用，让可编辑视图与状态同步）。 */
async function reloadConfig() {
  try {
    const res = await api.config();
    if (res.ok) {
      state.config = res.data;
      updateView();
    }
    return res;
  } catch (err) {
    return { ok: false, error: { message: err.message } };
  }
}

function updateView() {
  try {
    viewInstance?.update?.();
  } catch (err) {
    console.error('视图更新失败', err);
  }
}

// MARK: - 视图路由

function routeId() {
  const match = /^#\/([a-z-]+)$/.exec(location.hash);
  return match && VIEWS.some((v) => v.id === match[1]) ? match[1] : VIEWS[0].id;
}

function renderNav() {
  clear(navEl);
  for (const view of VIEWS) {
    navEl.append(el('a', {
      class: `nav-item${view.id === currentView ? ' active' : ''}`,
      href: `#/${view.id}`,
      onclick: (event) => {
        event.preventDefault();
        location.hash = `#/${view.id}`;
      },
    }, [
      el('span', { class: 'nav-icon', text: view.icon ?? '•' }),
      el('span', { text: view.label }),
      view.tag ? el('span', { class: 'nav-tag', text: view.tag }) : null,
    ]));
  }
}

function makeCtx() {
  return {
    api,
    get status() { return state.status; },
    get config() { return state.config; },
    get events() { return state.events; },
    logs: () => state.logs,
    clearLogs: () => { state.logs = []; updateView(); },
    onLog: (fn) => {
      logSubscribers.add(fn);
      return () => logSubscribers.delete(fn);
    },
    onEvent: (fn) => {
      eventSubscribers.add(fn);
      return () => eventSubscribers.delete(fn);
    },
    runAction,
    setBanner,
    refresh: refreshStatus,
    reloadConfig,
    navigate: (id) => { location.hash = `#/${id}`; },
  };
}

function mountView() {
  const id = routeId();
  if (id === currentView && viewInstance) {
    updateView();
    return;
  }
  try {
    viewInstance?.unmount?.();
  } catch { /* 视图卸载异常忽略 */ }
  currentView = id;
  clear(viewEl);
  const view = VIEWS.find((v) => v.id === id);
  try {
    viewInstance = view.mount(viewEl, makeCtx()) ?? {};
  } catch (err) {
    viewInstance = {};
    viewEl.append(el('div', { class: 'hint-box', text: `视图渲染失败：${err.message}` }));
  }
  renderNav();
  updateView();
}

// MARK: - 事件与日志

function handleEvent(event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();

  if (event.type === 'error') setBanner('err', event.message, event.hint, event.stage);
  else if (event.type === 'warn') setBanner('warn', event.message);
  else if (event.type === 'done') setBanner('ok', event.message);
  else if (event.type === 'phase') refreshStatus();

  for (const fn of eventSubscribers) {
    try { fn(event); } catch { /* 订阅者异常忽略 */ }
  }
  renderTop();
}

function handleLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  for (const fn of logSubscribers) {
    try { fn(entry); } catch { /* 订阅者异常忽略 */ }
  }
}

// MARK: - 启动

buttons.start.addEventListener('click', () => runAction('start'));
buttons.stop.addEventListener('click', () => runAction('stop'));
buttons.restart.addEventListener('click', () => runAction('restart'));
buttons.open.addEventListener('click', async () => {
  const res = await api.openEntry();
  if (!res.ok) setBanner('err', `打开界面失败：${res.error.message}`);
});
window.addEventListener('hashchange', mountView);

async function boot() {
  const cfg = await api.config();
  if (cfg.ok) state.config = cfg.data;
  else setBanner('warn', `读取配置失败：${cfg.error.message}`);

  const logsRes = await api.logs(400);
  if (logsRes.ok) state.logs = logsRes.data;

  renderNav();
  mountView();
  await refreshStatus();

  api.onEvent(handleEvent);
  api.onLog(handleLog);
  setInterval(() => { if (!state.busy) refreshStatus(); }, POLL_MS);

  // 主进程 --smoke 自检依赖这个信号：能走到这里说明 CSP/preload/IPC 全通
  api.reportReady({
    view: currentView,
    phase: state.status?.phase ?? null,
    hasConfig: !!state.config,
    logLines: state.logs.length,
    // 渲染证据：确认仪表盘真的画出来了（而不是白屏）
    cards: document.querySelectorAll('.card').length,
    navItems: document.querySelectorAll('.nav-item').length,
    textLength: document.body.innerText.length,
  });
}

boot().catch((err) => {
  setBanner('err', `界面初始化失败：${err.message}`);
  console.error(err);
});
