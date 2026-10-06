/**
 * daemon 侧诊断（Phase 0 的关键取证工具）：
 *   1) 探活内部 daemon（默认 8010，回退到公开入口）
 *   2) 用官方 CLI 铸一次性 nonce → 换成会话 cookie
 *   3) 带上 cookie 请求 /api/models 与 /api/health，报告登录态与模型目录来源
 *
 * 输出全部脱敏：只打印 cookie 名字、模型 id、错误字段，不打印任何 cookie/nonce 值。
 * 用法：node src/daemon-probe.mjs [--config <path>] [--port <daemon 端口>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.mjs';
import { configureLogging, log } from './log.mjs';
import {
  exchangeNonceForCookies,
  mintLoginURL,
  probeHTTP,
  runScienceCli,
} from './science-control.mjs';

function parseArgs(argv) {
  const out = { config: null, port: null, keepCookies: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--keep-cookies') out.keepCookies = true;
  }
  return out;
}

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function getJSON(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual' });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { status: res.status, location: res.headers.get('location'), body };
  } catch (err) {
    return { status: null, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cfg;
  try {
    cfg = loadConfig(args.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`配置错误：${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  configureLogging({ level: 'error', dir: null });
  const daemonPort = args.port ?? cfg.ports.daemon;

  const report = {
    dataDir: cfg.science.dataDir,
    binaryExists: fs.existsSync(cfg.science.binaryPath),
    daemonPort,
    steps: {},
  };

  console.log('=== Claude Science daemon 诊断 ===');
  console.log(`data-dir: ${cfg.science.dataDir}`);
  console.log(`binary  : ${cfg.science.binaryPath} (存在=${report.binaryExists})`);

  // 1) 探活
  const healthPaths = ['/api/health', '/health', '/'];
  report.steps.health = [];
  let reachable = false;
  for (const p of healthPaths) {
    const r = await probeHTTP(`http://127.0.0.1:${daemonPort}${p}`, { timeoutMs: 1500 });
    report.steps.health.push({ path: p, ...r });
    console.log(`health ${p} → ${r.ok ? `HTTP ${r.status}` : r.error}`);
    if (r.ok) reachable = true;
  }
  if (!reachable) {
    console.log(`\n✗ :${daemonPort} 上没有 daemon 在跑。请先用 start.ps1 或 serve 命令启动它。`);
    console.log('  提示：daemon 未启动时，官方 CLI 的 `url` 子命令通常会自己拉起一个。');
  }

  // 2) nonce
  const minted = await mintLoginURL(cfg);
  report.steps.mint = minted.ok
    ? { ok: true, port: minted.port, nonceLength: minted.nonce?.length ?? 0 }
    : { ok: false, code: minted.code, stderr: minted.stderr, stdout: minted.stdout };
  if (!minted.ok) {
    console.log(`\n✗ 铸 nonce 失败（CLI exit=${minted.code}）：${minted.stderr || minted.stdout}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(`\nnonce 铸取成功（长度 ${minted.nonce.length}，端口 ${minted.port ?? daemonPort}）——值不落盘、不打印`);

  // 3) 换 cookie
  const exchange = await exchangeNonceForCookies({ port: minted.port ?? daemonPort, nonce: minted.nonce });
  report.steps.exchange = { ok: exchange.ok, details: exchange.details, cookieNames: exchange.cookies.map((c) => c.name) };
  console.log(`cookie 交换：${exchange.details.join(' | ')}`);
  if (!exchange.ok) {
    console.log('✗ 未能拿到会话 cookie');
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(`✓ 会话 cookie：${exchange.cookies.map((c) => c.name).join(', ')}（值已隐藏）`);

  const headers = { cookie: cookieHeader(exchange.cookies) };
  const port = minted.port ?? daemonPort;

  // 4) 登录态与模型目录
  const account = await getJSON(`http://127.0.0.1:${port}/api/account`, headers);
  report.steps.account = { status: account.status, body: account.body };
  console.log(`\n/api/account → HTTP ${account.status}`);

  const models = await getJSON(`http://127.0.0.1:${port}/api/models`, headers);
  report.steps.models = { status: models.status, body: models.body };
  if (models.status === 200 && models.body && typeof models.body === 'object') {
    const flat = Object.values(models.body.models ?? {}).flat().map((m) => m.id);
    console.log('/api/models → HTTP 200');
    console.log(`  模型：${flat.length > 0 ? flat.join(', ') : '(空)'}`);
    console.log(`  default_model_id : ${models.body.default_model_id ?? '(无)'}`);
    console.log(`  models_source    : ${models.body.models_source ?? '(无)'}`);
    console.log(`  first_party_catalog: ${models.body.first_party_catalog ?? false}`);
    if (models.body.auth_error) console.log(`  ⚠ auth_error : ${models.body.auth_error}`);
    if (models.body.fetch_error) console.log(`  ⚠ fetch_error: ${models.body.fetch_error}`);
    const ours = cfg.models.map((m) => m.publishAs);
    const hit = flat.filter((id) => ours.includes(id));
    console.log(`  我们发布的型号命中：${hit.length > 0 ? hit.join(', ') : '无（说明目录不是来自本代理）'}`);
  } else {
    console.log(`/api/models → HTTP ${models.status} ${typeof models.body === 'string' ? models.body.slice(0, 200) : ''}`);
  }

  const daemonStatus = await getJSON(`http://127.0.0.1:${port}/daemon/status`, headers);
  report.steps.daemonStatus = { status: daemonStatus.status, body: daemonStatus.body };
  console.log(`/daemon/status → HTTP ${daemonStatus.status}`);

  // 5) 官方 CLI 版本与子命令（留档，便于对照）
  const version = await runScienceCli(cfg.science.binaryPath, ['--version'], { timeoutMs: 8000 });
  report.cliVersion = (version.stdout || version.stderr).trim().slice(0, 120);
  console.log(`\nCLI 版本输出：${report.cliVersion || '(空)'}`);

  const outPath = path.join(process.env.PI_SCRATCH_DIR ?? '.', 'daemon-probe-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n完整报告：${outPath}`);
}

main().catch((err) => {
  log.error(`诊断异常：${err.stack ?? err.message}`);
  process.exit(1);
});
