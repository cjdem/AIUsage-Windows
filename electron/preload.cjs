/**
 * preload：渲染进程唯一的对外通道。
 *
 * 注意：本文件必须是 CommonJS（.cjs）——Electron 的**沙箱化** preload 不支持 ESM import，
 * 用 .mjs 会报 "Cannot use import statement outside a module"。为了保住 sandbox: true
 * 的隔离强度，这里改用 require('electron')，代价只是语法形式。
 *
 * 只暴露「窄 API」——一组明确命名的方法，不暴露 ipcRenderer 本体、
 * 不暴露任何 Node 模块，UI 无法自行拼出任意 IPC 频道。
 * 所有调用统一返回 { ok, data } 或 { ok:false, error:{message,stage,hint} }，
 * 让 UI 能把失败阶段与提示原样展示给用户。
 */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

const api = {
  /** 链路状态（阶段、端口探活、上游/模型摘要、登录态、最近错误）。 */
  status: () => ipcRenderer.invoke('app:status'),
  /** 脱敏后的配置文件 + 归一化可编辑视图 + 阶段名表 + 公开入口地址。 */
  config: () => ipcRenderer.invoke('app:config'),
  /** 保存配置补丁（先校验再落盘；apiKey 省略表示保持不变）。 */
  saveConfig: (patch) => ipcRenderer.invoke('app:config-save', patch ?? {}),
  /** 一键探测上游能力（只走流式）。 */
  probeUpstream: (options = {}) => ipcRenderer.invoke('app:config-probe', options),
  /** 调用记录与成本聚合（days 默认 7）。 */
  analytics: (options = {}) => ipcRenderer.invoke('app:analytics', options),
  /** 写入虚拟登录（force=true 才会覆盖非本工具写入的凭证）。 */
  loginWrite: (options = {}) => ipcRenderer.invoke('app:login-write', options),
  loginRemove: () => ipcRenderer.invoke('app:login-remove'),
  /** 备份：列表 / 立即备份 / 从某个目录还原。 */
  backupsList: () => ipcRenderer.invoke('app:backups-list'),
  backupCreate: () => ipcRenderer.invoke('app:backup-create'),
  backupRestore: (dir) => ipcRenderer.invoke('app:backup-restore', { dir }),
  /** doctor：私有协议假设的可复现断言。 */
  doctor: () => ipcRenderer.invoke('app:doctor'),
  /** 打开桌面 app（无参启动；会附着到当前 daemon，窗口即已登录）。 */
  openDesktopApp: () => ipcRenderer.invoke('app:open-desktop'),
  start: (options = {}) => ipcRenderer.invoke('app:start', options),
  stop: () => ipcRenderer.invoke('app:stop'),
  restart: (options = {}) => ipcRenderer.invoke('app:restart', options),
  openEntry: () => ipcRenderer.invoke('app:open-entry'),
  /** 最近日志（环形缓冲里的尾部）。 */
  logs: (limit = 400) => ipcRenderer.invoke('app:logs', limit),

  /** 编排事件流（stage/phase/note/warn/error/done）。返回取消订阅函数。 */
  onEvent: subscribe('app:event'),
  /** 日志流（含 daemon 子进程输出）。返回取消订阅函数。 */
  onLog: subscribe('app:log'),

  /** 渲染进程就绪信号（主进程 --smoke 自检用）。 */
  reportReady: (info = {}) => ipcRenderer.send('app:ui-ready', info),

  versions: {
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
    platform: process.platform,
  },
};

contextBridge.exposeInMainWorld('aiusage', api);
