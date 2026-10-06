/**
 * doctor：把「对 Claude Science 0.1.56 的逆向假设」变成**可复现的断言**。
 *
 * 为什么需要它：这套工具依赖若干未公开的私有协议细节（nonce 端点、CSRF 机制、令牌加密格式、
 * 模型目录来源）。Science 一旦升级就可能悄悄变掉——与其在用户那里表现为「莫名其妙不能用了」，
 * 不如在这里一条条检查并明确报出哪一条不再成立。
 *
 * 约定：每个检查返回 { id, label, status: 'pass'|'fail'|'skip', detail }，
 * skip 表示「前提不满足（例如 daemon 没在跑）」，不是错误；绝不抛错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { probeHTTP, runScienceCli, parseLoginURL } from './science-control.mjs';
import { readOAuthKey, deriveOAuthKey, decryptTokenV2 } from './virtual-login.mjs';

const VIRTUAL_MARKER = 'aiusage_virtual';

function pass(id, label, detail) { return { id, label, status: 'pass', detail }; }
function fail(id, label, detail) { return { id, label, status: 'fail', detail }; }
function skip(id, label, detail) { return { id, label, status: 'skip', detail }; }

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} cfg 运行期配置
 * @param {{proxyPort?: number, daemonPort?: number}} [options] 端口覆盖（默认取 cfg.ports）
 * @returns {Promise<{ok:boolean, checks:Array, summary:{pass:number,fail:number,skip:number}, ranAt:string}>}
 */
export async function runDoctor(cfg, options = {}) {
  const checks = [];
  const dataDir = cfg.science.dataDir;
  const daemonPort = options.daemonPort ?? cfg.ports.daemon;
  const proxyPort = options.proxyPort ?? cfg.ports.inference;

  // 1) 二进制
  let binaryOk = false;
  try {
    binaryOk = fs.existsSync(cfg.science.binaryPath);
    checks.push(binaryOk
      ? pass('binary', '找到 Claude Science 可执行文件', cfg.science.binaryPath)
      : fail('binary', '找不到 Claude Science 可执行文件', `${cfg.science.binaryPath}（可在 config.json 改 science.binaryPath）`));
  } catch (err) {
    checks.push(fail('binary', '检查可执行文件失败', err.message));
  }

  // 2) 数据目录
  const dataDirOk = fs.existsSync(dataDir);
  checks.push(dataDirOk
    ? pass('dataDir', '数据目录存在', dataDir)
    : fail('dataDir', '数据目录不存在', `${dataDir}（先启动一次 Claude Science 桌面应用）`));

  // 3) encryption.key 里的 OAUTH_ENCRYPTION_KEY（令牌加密的根密钥）
  let derivedKey = null;
  try {
    const { keyPath, keyBytes } = readOAuthKey(dataDir);
    derivedKey = deriveOAuthKey(keyBytes);
    checks.push(pass('encryptionKey', 'encryption.key 含可用的 OAUTH_ENCRYPTION_KEY',
      `${keyPath}（base64 ${keyBytes.length} 字节 → HKDF 派生 32 字节 AES 密钥）`));
  } catch (err) {
    checks.push(fail('encryptionKey', '读不到 OAUTH_ENCRYPTION_KEY', err.message));
  }

  // 4) 令牌文件：数量、可解密性、字段完整性
  const tokensDir = path.join(dataDir, '.oauth-tokens');
  let tokenFiles = [];
  try {
    tokenFiles = fs.readdirSync(tokensDir).filter((name) => name.endsWith('.enc'));
  } catch {
    tokenFiles = [];
  }
  if (!dataDirOk) {
    checks.push(skip('tokenFiles', '令牌文件检查', '数据目录不存在'));
  } else if (tokenFiles.length === 0) {
    checks.push(fail('tokenFiles', '存在登录令牌', `目录里没有 .enc：${tokensDir}（需要写入虚拟登录）`));
  } else if (tokenFiles.length > 1) {
    checks.push(fail('tokenFiles', '令牌文件数量', `目录里有 ${tokenFiles.length} 个 .enc，daemon 只认单一账号（${tokenFiles.join(', ')}）`));
  } else {
    checks.push(pass('tokenFiles', '令牌文件数量符合 daemon 的单账号假设', tokenFiles[0]));
  }

  if (tokenFiles.length >= 1) {
    const file = tokenFiles[0];
    if (!derivedKey) {
      checks.push(skip('tokenFormat', '令牌格式与字段检查', '密钥不可用，无法解密验证'));
    } else {
      try {
        const text = fs.readFileSync(path.join(tokensDir, file), 'utf8');
        const parsed = JSON.parse(decryptTokenV2(text, derivedKey));
        const required = ['access_token', 'token_expires_at', 'provider', 'scopes', 'email', 'account_uuid', 'org_uuid'];
        const missing = required.filter((key) => !parsed[key]);
        const isVirtual = parsed[VIRTUAL_MARKER] === true;
        if (missing.length === 0) {
          checks.push(pass('tokenFormat', 'v2 AES-256-GCM 令牌格式与字段完整',
            `${isVirtual ? '本工具写入的虚拟令牌' : '非本工具写入'}；provider=${parsed.provider}；过期=${parsed.token_expires_at}`));
        } else {
          checks.push(fail('tokenFormat', '令牌字段缺失', `缺少 ${missing.join(', ')}`));
        }
      } catch (err) {
        checks.push(fail('tokenFormat', '令牌无法按 v2 格式解密', `${file}：${err.message}`));
      }
    }
  }

  // 5) daemon 是否在跑（后续几项依赖它）
  const health = await probeHTTP(`http://127.0.0.1:${daemonPort}/health`, { timeoutMs: 2000 });
  const daemonUp = health.ok;
  checks.push(daemonUp
    ? pass('daemonHealth', 'daemon 健康检查', `:${daemonPort}/health → HTTP ${health.status}`)
    : skip('daemonHealth', 'daemon 健康检查', `:${daemonPort} 未监听（先启动链路再跑 doctor 可覆盖更多检查）`));

  if (daemonUp) {
    // 6) CSRF 机制：GET /api/csrf → 204 + Set-Cookie(operon_csrf)
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${daemonPort}/api/csrf`, {
        headers: { origin: `http://localhost:${daemonPort}` },
        redirect: 'manual',
      });
      const cookies = (res.headers.getSetCookie?.() ?? []).map((line) => line.split('=')[0].trim());
      const hasCsrf = cookies.some((name) => /operon_csrf/i.test(name));
      checks.push(res.status === 204 && hasCsrf
        ? pass('csrfMechanism', 'CSRF 机制符合预期', `GET /api/csrf → 204，Set-Cookie: ${cookies.join(',')}`)
        : fail('csrfMechanism', 'CSRF 机制与预期不同',
          `GET /api/csrf → HTTP ${res.status}，Set-Cookie: ${cookies.join(',') || '(空)'}（预期 204 + operon_csrf）`));
    } catch (err) {
      checks.push(fail('csrfMechanism', 'CSRF 探测失败', err.message));
    }

    // 7) 写请求必须带 Origin（缺失 → 403 origin_required）
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${daemonPort}/api/auth/nonce`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'nonce=doctor-probe-invalid&dest=/',
      });
      let code = null;
      try { code = JSON.parse(await res.text())?.code ?? null; } catch { /* 正文非 JSON */ }
      checks.push(res.status === 403 && code === 'origin_required'
        ? pass('originRequired', '写请求强制校验 Origin', '缺 Origin 时返回 403 origin_required')
        : fail('originRequired', '写请求的 Origin 校验与预期不同',
          `POST /api/auth/nonce（无 Origin）→ HTTP ${res.status}${code ? ` code=${code}` : ''}（预期 403 origin_required）`));
    } catch (err) {
      checks.push(fail('originRequired', 'Origin 校验探测失败', err.message));
    }

    // 8) nonce 端点：官方 CLI 能铸出一次性登录链接
    try {
      const minted = await runScienceCli(cfg.science.binaryPath, ['url', '--data-dir', dataDir], { timeoutMs: 20_000 });
      const parsed = parseLoginURL(minted.stdout) ?? parseLoginURL(minted.stderr);
      checks.push(parsed
        ? pass('nonceEndpoint', '官方 CLI 能铸出一次性登录链接', `端口 ${parsed.port ?? '-'}（nonce 已隐去）`)
        : fail('nonceEndpoint', 'CLI 未能铸出登录链接',
          `exit=${minted.code}；输出片段：${(minted.stderr || minted.stdout || '').trim().slice(0, 160)}`));
    } catch (err) {
      checks.push(fail('nonceEndpoint', '铸链接失败', err.message));
    }
  } else {
    checks.push(skip('csrfMechanism', 'CSRF 机制检查', 'daemon 未在运行'));
    checks.push(skip('originRequired', 'Origin 校验检查', 'daemon 未在运行'));
    checks.push(skip('nonceEndpoint', 'nonce 端点检查', 'daemon 未在运行'));
  }

  // 9) 模型目录来源：推理代理以 Anthropic 形状发布模型
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/v1/models`, {}, 3000);
    if (!res.ok) {
      checks.push(skip('modelsSource', '推理代理模型目录', `:${proxyPort}/v1/models → HTTP ${res.status}（推理代理未运行？）`));
    } else {
      const body = await res.json();
      const ids = (body?.data ?? []).map((model) => model.id);
      const anthropicShaped = ids.every((id) => /^claude[-.]/i.test(id));
      checks.push(anthropicShaped && ids.length > 0
        ? pass('modelsSource', '推理代理按 Anthropic 形状发布模型目录', ids.join(', '))
        : fail('modelsSource', '发布的模型目录不是 Anthropic 形状', JSON.stringify(ids).slice(0, 200)));
    }
  } catch (err) {
    checks.push(skip('modelsSource', '推理代理模型目录', `:${proxyPort} 未监听（${err.message}）`));
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };
  return { ok: summary.fail === 0, checks, summary, ranAt: new Date().toISOString() };
}
