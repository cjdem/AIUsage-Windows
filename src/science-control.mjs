/**
 * 与本地 Claude Science daemon 打交道的全部机械动作：
 * 健康检查、用官方 CLI 铸一次性 nonce、把 nonce 换成会话 cookie、备份/还原真实数据目录、优雅停止。
 *
 * 安全约定：
 *  - 只执行官方 CLI 的只读/标准子命令（url / stop），不改 Science 二进制、不写系统环境变量。
 *  - cookie 与 nonce 只在内存里传递；写日志时只记名字与数量，绝不记值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, configureLogging } from './log.mjs';
import { loadConfig } from './config.mjs';

/** 需要备份的真实凭据/状态文件（不包含运行期缓存与大型运行时资产）。 */
const BACKUP_ITEMS = [
  'encryption.key',
  'encryption.key.dpapi',
  '.key-backups',
  '.oauth-tokens',
  'active-org.json',
  'config.toml',
  'preferences.json',
  'auth-owner.lock',
  'orgs',
];

export function parseNonce(text) {
  const m = /[?&]nonce=([0-9a-zA-Z_-]{8,})/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function parseLoginURL(text) {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?\/[^\s"']*nonce=[0-9a-zA-Z_-]{8,}/.exec(String(text ?? ''));
  return m ? { url: m[0], port: m[1] ? Number(m[1]) : null } : null;
}

/** 跑一次官方 CLI，返回 {code, stdout, stderr}。 */
export function runScienceCli(binaryPath, args, { timeoutMs = 20_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      windowsHide: true,
      env: {
        ...process.env,
        // 本机存在 HTTP_PROXY，回环直连必须绕过它
        no_proxy: '127.0.0.1,localhost,::1',
        NO_PROXY: '127.0.0.1,localhost,::1',
        ...env,
      },
    });
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

/** HTTP 探活（不抛错）。 */
export async function probeHTTP(url, { timeoutMs = 1500, method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, signal: controller.signal, redirect: 'manual' });
    return { ok: true, status: res.status, location: res.headers.get('location') ?? null };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHealth(port, { timeoutMs = 60_000, intervalMs = 700, path: healthPath = '/api/health' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    const r = await probeHTTP(`http://127.0.0.1:${port}${healthPath}`, { timeoutMs: 2000 });
    if (r.ok && r.status < 500) return true;
    last = r.ok ? `HTTP ${r.status}` : r.error;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  log.warn(`等待 :${port}${healthPath} 就绪超时，最后一次：${last}`);
  return false;
}

/** 用官方 CLI 铸一次性 nonce（同时拿到它公布的登录链接）。 */
export async function mintLoginURL(cfg) {
  const res = await runScienceCli(cfg.science.binaryPath, ['url', '--data-dir', cfg.science.dataDir]);
  const parsed = parseLoginURL(res.stdout) ?? parseLoginURL(res.stderr);
  if (!parsed) {
    return {
      ok: false,
      code: res.code,
      stderr: res.stderr.trim().slice(0, 500),
      stdout: res.stdout.trim().slice(0, 500),
    };
  }
  return { ok: true, ...parsed, nonce: parseNonce(parsed.url) };
}

/** 把 nonce 换成会话 cookie：新版走同源表单 POST，旧版回退 GET /?nonce=。 */
export async function exchangeNonceForCookies({ port, nonce, dest = '/' }) {
  const attempts = [];
  const form = `nonce=${encodeURIComponent(nonce)}&dest=${encodeURIComponent(dest)}`;
  attempts.push({
    label: 'POST /api/auth/nonce',
    request: () => fetch(`http://127.0.0.1:${port}/api/auth/nonce`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: `http://localhost:${port}`,
      },
      body: form,
    }),
  });
  attempts.push({
    label: 'GET /?nonce=',
    request: () => fetch(`http://127.0.0.1:${port}/?nonce=${encodeURIComponent(nonce)}`, {
      method: 'GET',
      redirect: 'manual',
    }),
  });

  const details = [];
  for (const attempt of attempts) {
    let res;
    try {
      res = await attempt.request();
    } catch (err) {
      details.push(`${attempt.label}: transport ${err.message}`);
      continue;
    }
    const raw = res.headers.getSetCookie?.() ?? [];
    const cookies = raw.map((line) => {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      return idx > 0
        ? { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), raw: line }
        : null;
    }).filter(Boolean);
    const sessionish = cookies.some((c) => /auth|session|token/i.test(c.name));
    details.push(`${attempt.label}: status=${res.status} cookies=[${cookies.map((c) => c.name).join(',')}]`);
    if (cookies.length > 0 && sessionish) {
      return { ok: true, cookies, details, status: res.status };
    }
  }
  return { ok: false, cookies: [], details };
}

/** 备份真实数据目录里的凭据/状态文件（只读复制，绝不移动或删除原文件）。 */
export function backupDataDir(cfg, destRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destRoot ?? path.join(cfg.science.dataDir, '..', 'aiusage-science-backups'), stamp);
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  const missing = [];
  for (const item of BACKUP_ITEMS) {
    const src = path.join(cfg.science.dataDir, item);
    if (!fs.existsSync(src)) {
      missing.push(item);
      continue;
    }
    const target = path.join(dest, item);
    fs.cpSync(src, target, { recursive: true, force: true });
    copied.push(item);
  }
  fs.writeFileSync(path.join(dest, 'backup-manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    dataDir: cfg.science.dataDir,
    copied,
    missing,
  }, null, 2));
  log.info(`已备份 ${copied.length} 项到 ${dest}（缺失 ${missing.length} 项）`);
  return { dest, copied, missing };
}

/** 从备份目录还原（用于把真实目录恢复原状）。 */
export function restoreBackup(backupDir, cfg) {
  if (!fs.existsSync(backupDir)) throw new Error(`备份目录不存在：${backupDir}`);
  const manifestPath = path.join(backupDir, 'backup-manifest.json');
  const items = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).copied
    : BACKUP_ITEMS;
  const restored = [];
  for (const item of items) {
    const src = path.join(backupDir, item);
    if (!fs.existsSync(src)) continue;
    const target = path.join(cfg.science.dataDir, item);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(src, target, { recursive: true, force: true });
    restored.push(item);
  }
  log.info(`已还原 ${restored.length} 项到 ${cfg.science.dataDir}`);
  return restored;
}

/** 优雅停止 daemon：优先官方 CLI，失败再试控制端点（需要 bearer 文件）。 */
export async function stopDaemon(cfg) {
  const cli = await runScienceCli(cfg.science.binaryPath, ['stop', '--data-dir', cfg.science.dataDir]);
  return { code: cli.code, stdout: cli.stdout.trim().slice(0, 300), stderr: cli.stderr.trim().slice(0, 300) };
}

export async function status(cfg) {
  const [inference, daemon, publicEntry] = await Promise.all([
    probeHTTP(`http://127.0.0.1:${cfg.ports.inference}/health`),
    probeHTTP(`http://127.0.0.1:${cfg.ports.daemon}/api/health`),
    probeHTTP(`http://127.0.0.1:${cfg.ports.publicEntry}/`),
  ]);
  return {
    ports: cfg.ports,
    inference: { listening: inference.ok, status: inference.status ?? inference.error },
    daemon: { listening: daemon.ok, status: daemon.status ?? daemon.error },
    publicEntry: { listening: publicEntry.ok, status: publicEntry.status ?? publicEntry.error },
    dataDir: cfg.science.dataDir,
    loggedInTokens: fs.existsSync(path.join(cfg.science.dataDir, '.oauth-tokens'))
      ? fs.readdirSync(path.join(cfg.science.dataDir, '.oauth-tokens')).length
      : 0,
  };
}

// MARK: - CLI

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'status';
  let configArg = null;
  let from = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') configArg = argv[++i];
    else if (argv[i] === '--from') from = argv[++i];
  }
  const cfg = loadConfig(configArg);
  configureLogging({ level: cfg.logging.level, dir: cfg.logging.dir, fileName: 'control.log' });

  switch (command) {
    case 'status': {
      const s = await status(cfg);
      console.log(JSON.stringify(s, null, 2));
      const live = s.inference.listening || s.daemon.listening || s.publicEntry.listening;
      process.exit(live ? 0 : 1);
    }
    case 'url': {
      const minted = await mintLoginURL(cfg);
      if (!minted.ok) {
        console.error(`铸链接失败（CLI exit=${minted.code}）：${minted.stderr || minted.stdout}`);
        process.exit(1);
      }
      console.log('一次性登录链接（3 分钟内有效，点开即登录；仅本机可用）：');
      console.log(minted.url);
      break;
    }
    case 'backup': {
      const result = backupDataDir(cfg);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'restore': {
      if (!from) {
        console.error('用法：node src/science-control.mjs restore --from <备份目录>');
        process.exit(2);
      }
      const restored = restoreBackup(from, cfg);
      console.log(JSON.stringify({ restored }, null, 2));
      break;
    }
    case 'stop': {
      const result = await stopDaemon(cfg);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error(`未知子命令：${command}（可用：status / url / backup / restore / stop）`);
      process.exit(2);
  }
  log.close();
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`执行失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}

/**
 * 铸 nonce 并返回登录链接（带退避重试）。
 * 实测：daemon 刚启动的数秒内，`claude-science url` 会报
 * "couldn't mint a sign-in link for the running daemon"（控制通道尚未就绪），
 * 稍后重试即成功——因此一次失败不能让整条链启动失败。
 */
export async function mintLoginURLWithRetry(cfg, { attempts = 8, delayMs = 2000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const minted = await mintLoginURL(cfg);
    if (minted.ok) {
      if (i > 0) log.info(`第 ${i + 1} 次尝试铸 nonce 成功`);
      return minted;
    }
    last = minted;
    const hint = String(minted.stderr || minted.stdout || '').trim().slice(0, 160);
    log.warn(`铸 nonce 第 ${i + 1}/${attempts} 次失败：${hint}`);
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
