/**
 * IPC 路由（阶段 1）：status / config / start / stop / restart / open / logs + 事件与日志推送。
 *
 * 约定：
 *  - 每个 handler 都返回 { ok:true, data } 或 { ok:false, error:{message,stage,hint} }，
 *    绝不让异常以 Electron 内部错误字符串的形式漏到 UI（那样用户看不到失败阶段）。
 *  - 事件与日志由主进程主动推送（app:event / app:log），UI 只订阅。
 *
 * 阶段 2/3/5 会在这里追加 config 写入、analytics、adopt 等频道。
 */
import { ipcMain } from 'electron';
import { STAGE_LABELS } from '../../src/app-service.mjs';

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  return {
    ok: false,
    error: {
      message: err?.message ?? String(err),
      stage: err?.stage ?? null,
      hint: err?.hint ?? null,
    },
  };
}

export function registerIpc({ service, getWindow, onUiReady, onStart }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return ok(await fn(...args));
      } catch (err) {
        return fail(err);
      }
    });
  };

  handle('app:status', () => service.status());

  handle('app:config', async () => ({
    display: service.readConfigForDisplay(),
    editing: service.readConfigForEditing(),
    stages: STAGE_LABELS,
    entryUrl: service.entryUrl(),
  }));

  handle('app:config-save', (patch) => service.saveConfig(patch ?? {}));
  handle('app:config-probe', (options) => service.probeUpstream(options ?? {}));

  /** 调用记录与成本统计（阶段 3）。 */
  handle('app:analytics', (options) => ({
    summary: service.analyticsSummary(options ?? {}),
    recent: service.analyticsRecent((options?.recent) ?? 100),
    dir: service.analyticsDir(),
  }));

  /** 登录态与备份（阶段 5）。 */
  handle('app:login-write', (options) => service.loginWrite(options ?? {}));
  handle('app:login-remove', () => service.loginRemove());
  handle('app:backups-list', () => service.backupsList());
  handle('app:backup-create', () => service.backupCreate());
  handle('app:backup-restore', (options) => service.backupRestore(options ?? {}));
  handle('app:doctor', () => service.doctor());

  /** 打开桌面 app（无参启动，会附着到当前 daemon）。 */
  handle('app:open-desktop', () => service.openDesktopApp());

  handle('app:start', async (options) => {
    const result = await service.start(options ?? {});
    onStart?.();
    return result;
  });

  handle('app:stop', () => service.stop());
  handle('app:restart', async (options) => {
    const result = await service.restart(options ?? {});
    onStart?.();
    return result;
  });
  handle('app:open-entry', () => service.openEntry());
  handle('app:logs', (limit) => service.bus.recent(Number(limit) || 400));

  service.onEvent((event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('app:event', event);
  });

  service.bus.subscribe((entry) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('app:log', entry);
  });

  ipcMain.on('app:ui-ready', (_event, info) => {
    try {
      onUiReady?.(info);
    } catch { /* 自检回调异常不影响运行 */ }
  });
}
