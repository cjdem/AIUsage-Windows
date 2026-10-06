/**
 * 会话反代（公开入口，默认 127.0.0.1:8000 → daemon 127.0.0.1:8010）。
 *
 * 为什么需要它：daemon 的 Web 会话是 cookie 门（operon_auth + operon_csrf），
 * 官方只给一次性 nonce 链接（3 分钟、只登录一个标签页、daemon 重启即失效）。
 * 本反代自己铸 nonce → 换 cookie，然后给每个请求注入当前有效 cookie，
 * 于是浏览器直接打开 http://localhost:8000 就是已登录状态。
 *
 * 逆向要点（0.1.56 Windows）：
 *  - 改状态请求受同源校验：只接受 daemon 自身 origin（http://localhost:<daemonPort>），
 *    因此必须把浏览器带来的 Origin / Referer / Host 改写为 daemon 自己的 origin。
 *  - 写请求强制要求 Origin 头，缺失即 403 origin_required（脚本/非浏览器客户端需补）。
 *  - /api/csrf 返回 204，令牌以 Set-Cookie(operon_csrf) 下发，SPA 读出后放 x-operon-csrf 头。
 *  - /api/ws 是长连 WebSocket，需要原样双向隧道。
 *  - 上游 401 或 302→/login 说明 cookie 因 daemon 重启失效 → 重铸一次再重试。
 *
 * 安全边界（重要）：本反代会把会话身份注入每一个入站请求，因此**必须自己守住入口**：
 *  - 只监听回环；
 *  - 入站 Host 必须是本机回环 + 公开端口；
 *  - 写请求的 Origin 必须为空（同源导航/脚本）或本机回环同端口（浏览器同源请求）；
 *    否则 403 —— 防止恶意网页/DNS rebinding 借本反代驱动本地 agent。
 */
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.mjs';
import { configureLogging, log } from './log.mjs';
import { exchangeNonceForCookies, mintLoginURLWithRetry, probeHTTP } from './science-control.mjs';

/** 请求体缓冲上限（用于 401 重铸后重放）；超过则放弃重放并如实返回 401。 */
const MAX_REPLAY_BODY = 8 * 1024 * 1024;

function parseArgs(argv) {
  const out = { config: null, noRefresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--no-refresh') out.noRefresh = true;
  }
  return out;
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

/** cookie 罐：只保存 daemon 下发的 operon 会话 cookie（名字 → 值）。 */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /** 只吸收 operon_* ；返回是否发生了变化。 */
  absorb(setCookieHeaders = []) {
    let changed = false;
    for (const line of setCookieHeaders) {
      const [pair] = String(line).split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!/^operon_/i.test(name)) continue;
      this.cookies.set(name, value);
      changed = true;
    }
    return changed;
  }

  /** 整体替换（避免「clear() 与并发请求」之间的半套状态）。 */
  replace(map) {
    this.cookies = new Map(map);
  }

  snapshot() {
    return new Map(this.cookies);
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.cookies.get(name);
  }

  hasSessionCookie() {
    // 必须是真正的会话 cookie（operon_auth），仅有 csrf 不算已建会话
    return this.cookies.has('operon_auth');
  }

  clear() {
    this.cookies.clear();
  }

  names() {
    return [...this.cookies.keys()];
  }
}

export function createSessionProxy(cfg, { noRefresh = false } = {}) {
  const jar = new CookieJar();
  const upstreamOrigin = `http://localhost:${cfg.ports.daemon}`;
  const publicPort = cfg.ports.publicEntry;
  let listener = null;
  let lastError = null;
  let retryTimer = null;
  let inflightSession = null;
  const sockets = new Set();

  /** 铸 nonce → 换 cookie → 取 csrf。先攒进新 Map，成功后再整体替换罐内容。 */
  async function bootstrapSession() {
    const minted = await mintLoginURLWithRetry(cfg);
    if (!minted.ok) {
      lastError = `铸 nonce 失败：${String(minted.stderr || minted.stdout || '').slice(0, 200)}`;
      log.error(lastError);
      return false;
    }
    const exchanged = await exchangeNonceForCookies({
      port: minted.port ?? cfg.ports.daemon,
      nonce: minted.nonce,
    });
    if (!exchanged.ok) {
      lastError = `nonce→cookie 失败：${exchanged.details.join(' | ')}`;
      log.error(lastError);
      return false;
    }

    const fresh = new Map();
    for (const cookie of exchanged.cookies) {
      const raw = cookie.raw ?? `${cookie.name}=${cookie.value}`;
      jar.absorb([raw]);
    }
    for (const [k, v] of jar.snapshot()) fresh.set(k, v);
    log.info(`会话 cookie 就绪：[${[...fresh.keys()].join(',')}]（值不落盘）`);

    // /api/csrf 需要 daemon 自身 Origin，且令牌以 Set-Cookie 下发
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.ports.daemon}/api/csrf`, {
        headers: { cookie: [...fresh.entries()].map(([k, v]) => `${k}=${v}`).join('; '), origin: upstreamOrigin },
        redirect: 'manual',
      });
      jar.absorb(res.headers.getSetCookie?.() ?? []);
    } catch (err) {
      log.warn(`获取 csrf 失败（浏览器稍后会自动重试）：${err.message}`);
    }

    // 只有拿到会话 cookie 才整体替换，避免把罐搞成半套
    if (!jar.hasSessionCookie()) {
      lastError = '未能取得 operon_auth 会话 cookie';
      log.error(lastError);
      return false;
    }
    lastError = null;
    log.info(`会话建立完成：[${jar.names().join(',')}]`);
    return true;
  }

  /** 单飞会话建立：并发调用共享同一次铸 nonce / 换 cookie 过程。 */
  function ensureSession({ force = false } = {}) {
    if (!force && jar.hasSessionCookie()) return Promise.resolve(true);
    if (!inflightSession) {
      inflightSession = bootstrapSession()
        .catch((err) => {
          lastError = err.message;
          log.error(`会话初始化异常：${err.message}`);
          return false;
        })
        .finally(() => {
          inflightSession = null;
        });
    }
    return inflightSession;
  }

  /** 入口校验：只有「本机回环 + 公开端口」的 Host，以及空/同源 Origin 才放行。 */
  function checkOrigin(req) {
    const host = String(req.headers.host ?? '');
    const hostMatch = /^(?:\[?::1\]?|127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(host);
    if (!hostMatch || (hostMatch[1] && Number(hostMatch[1]) !== publicPort)) {
      return { ok: false, reason: `Host 不被接受：${host || '(缺少)'}` };
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const origin = req.headers.origin;
    if (isWrite && origin) {
      let parsed;
      try {
        parsed = new URL(String(origin));
      } catch {
        return { ok: false, reason: `Origin 无法解析：${origin}` };
      }
      const originPort = parsed.port === '' ? 80 : Number(parsed.port);
      if (!isLoopbackHostname(parsed.hostname) || originPort !== publicPort) {
        return { ok: false, reason: `跨站写请求被拒：Origin=${origin}` };
      }
    }
    return { ok: true };
  }

  function buildUpstreamHeaders(req, { websocket = false } = {}) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (['host', 'origin', 'referer', 'cookie', 'connection', 'upgrade', 'keep-alive',
        'proxy-connection', 'transfer-encoding', 'content-length', 'x-operon-csrf'].includes(lower)) continue;
      headers[name] = value;
    }
    headers.host = `localhost:${cfg.ports.daemon}`;
    // 同源校验：一律改写成 daemon 自己的 origin
    headers.origin = upstreamOrigin;
    if (req.headers.referer) {
      try {
        const ref = new URL(req.headers.referer);
        headers.referer = `${upstreamOrigin}${ref.pathname}${ref.search}`;
      } catch {
        headers.referer = `${upstreamOrigin}/`;
      }
    } else {
      headers.referer = `${upstreamOrigin}/`;
    }
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const csrf = jar.get('operon_csrf');
    if (csrf) headers['x-operon-csrf'] = csrf;
    return headers;
  }

  /** 只把 operon_* 的 Set-Cookie 与改写后的 Location 回给浏览器。 */
  function buildClientHeaders(upstreamHeaders) {
    const out = {};
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      const lower = name.toLowerCase();
      if (lower === 'content-length' || lower === 'connection' || lower === 'set-cookie') continue;
      out[name] = value;
    }
    out.connection = 'close';

    const setCookies = upstreamHeaders['set-cookie'];
    if (setCookies) {
      const kept = (Array.isArray(setCookies) ? setCookies : [setCookies])
        .filter((line) => /^operon_/i.test(String(line).trim()));
      if (kept.length > 0) out['set-cookie'] = kept;
    }

    const location = upstreamHeaders.location;
    if (typeof location === 'string' && location.startsWith('http')) {
      try {
        const parsed = new URL(location);
        out.location = `http://localhost:${publicPort}${parsed.pathname}${parsed.search}`;
      } catch {
        out.location = location;
      }
    }
    return out;
  }

  async function handleRequest(req, res) {
    const verdict = checkOrigin(req);
    if (!verdict.ok) {
      log.warn(`拒绝请求 ${req.method} ${req.url}：${verdict.reason}`);
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: verdict.reason, code: 'origin_rejected_by_proxy' }));
      return;
    }

    if (!jar.hasSessionCookie()) {
      const ok = await ensureSession();
      if (!ok) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`会话尚不可用（正在后台重试建立）：${lastError ?? '未知错误'}`);
        return;
      }
    }

    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/login' || pathname.startsWith('/login/')) {
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const canHaveBody = !['GET', 'HEAD'].includes(method);

    // 先把请求体读进内存（带上限）：401 重铸后需要重放，也避免 pipe 后不可回退
    let bodyChunks = [];
    let bodyBytes = 0;
    let bodyOverflow = false;
    if (canHaveBody) {
      for await (const chunk of req) {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_REPLAY_BODY) {
          bodyOverflow = true;
          break;
        }
        bodyChunks.push(chunk);
      }
    }
    const bodyBuffer = bodyOverflow ? null : Buffer.concat(bodyChunks);
    if (bodyOverflow) req.resume();

    const attempt = (retry) => new Promise((resolve) => {
      const headers = buildUpstreamHeaders(req);
      if (bodyBuffer && bodyBuffer.length > 0) {
        headers['content-length'] = String(bodyBuffer.length);
      }
      const upstream = http.request({
        host: '127.0.0.1',
        port: cfg.ports.daemon,
        method: req.method,
        path: req.url,
        headers,
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const location = String(upstreamRes.headers.location ?? '');
        const sessionInvalid = status === 401
          || ((status >= 300 && status < 400) && location.includes('/login'));

        if (sessionInvalid && retry && !noRefresh) {
          upstreamRes.resume();
          if (!bodyBuffer) {
            log.warn('会话失效但请求体过大无法重放，如实返回 401');
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'session expired (body too large to replay)' }));
            resolve(false);
            return;
          }
          log.warn(`上游判定会话失效（HTTP ${status}），重铸 cookie 后重试一次`);
          ensureSession({ force: true })
            .then((ok) => {
              if (!ok) {
                res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(`会话重铸失败：${lastError ?? '未知错误'}`);
                resolve(false);
                return;
              }
              attempt(false).then(resolve);
            })
            .catch((err) => {
              res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
              res.end(`会话重铸异常：${err.message}`);
              resolve(false);
            });
          return;
        }

        jar.absorb(upstreamRes.headers['set-cookie'] ?? []);
        res.writeHead(status, buildClientHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => resolve(true));
        upstreamRes.on('error', () => resolve(false));
      });

      upstream.on('error', (err) => {
        log.error(`转发到 daemon 失败：${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`无法连接 daemon：${err.message}`);
        }
        resolve(false);
      });

      if (bodyBuffer && bodyBuffer.length > 0) upstream.write(bodyBuffer);
      upstream.end();
    });

    await attempt(true);
  }

  /** WebSocket：原样隧道（注入 cookie + 改写 Origin）。 */
  function handleUpgrade(req, clientSocket, head) {
    const verdict = checkOrigin(req);
    if (!verdict.ok) {
      log.warn(`拒绝 WS 升级：${verdict.reason}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    if (!jar.hasSessionCookie()) {
      ensureSession().then((ok) => {
        if (!ok) {
          clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          clientSocket.destroy();
          return;
        }
        openUpgrade(req, clientSocket, head);
      }).catch(() => clientSocket.destroy());
      return;
    }
    openUpgrade(req, clientSocket, head);
  }

  function openUpgrade(req, clientSocket, head) {
    const headers = buildUpstreamHeaders(req, { websocket: true });
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';

    const upstream = http.request({
      host: '127.0.0.1',
      port: cfg.ports.daemon,
      method: 'GET',
      path: req.url,
      headers,
    });
    // 防止 daemon 接受连接却不响应导致两侧 socket 永久滞留
    upstream.setTimeout(15_000, () => {
      log.warn('WS 升级上游超时，断开');
      upstream.destroy();
      clientSocket.destroy();
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const close = () => { upstreamSocket.destroy(); clientSocket.destroy(); };
      upstreamSocket.on('error', close);
      clientSocket.on('error', close);
      upstreamSocket.on('close', close);
      clientSocket.on('close', close);
      log.info('WebSocket 隧道已建立 /api/ws');
    });

    upstream.on('response', (upstreamRes) => {
      // 非 101：把普通响应回给客户端（例如未授权）
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const lower = name.toLowerCase();
        if (lower === 'content-length' || lower === 'connection' || lower === 'set-cookie') continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      lines.push('Connection: close');
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstreamRes.write?.(head);
      upstreamRes.pipe(clientSocket);
      upstreamRes.on('end', () => clientSocket.end());
    });

    upstream.on('error', (err) => {
      log.error(`WebSocket 上游失败：${err.message}`);
      clientSocket.destroy();
    });

    upstream.end();
  }

  return {
    bootstrapSession,
    ensureSession,
    cookieNames: () => jar.names(),
    async start() {
      const ready = await bootstrapSession();

      // 会话初始化失败不再阻止监听：daemon 刚启动时 nonce 铸取存在竞态，
      // 这里改为后台持续重试，浏览器刷新即可用。
      if (!ready) {
        log.warn(`首次会话初始化未成功（${lastError ?? '未知错误'}），将在后台重试`);
        if (!retryTimer) {
          retryTimer = setInterval(() => {
            if (jar.hasSessionCookie()) {
              clearInterval(retryTimer);
              retryTimer = null;
              return;
            }
            ensureSession().catch(() => {});
          }, 5000);
          retryTimer.unref?.();
        }
      }
      listener = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          log.error(`处理 ${req.method} ${req.url} 失败：${err.message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      listener.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      listener.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

      listener.listen(publicPort, '127.0.0.1');
      await once(listener, 'listening');
      log.info(`会话反代已监听 http://localhost:${publicPort} → daemon :${cfg.ports.daemon}`);
    },
    async stop() {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      if (!listener) return;
      const closing = once(listener, 'close').catch(() => {});
      listener.close();
      // WebSocket 长连不会让 'close' 触发，主动断开所有连接并加超时兜底
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      listener.closeAllConnections?.();
      await Promise.race([closing, new Promise((r) => setTimeout(r, 1500))]);
      listener = null;
    },
    /** 自探：公开入口 GET / 应直接返回已登录页面（200 + HTML）。 */
    async probe() {
      const direct = await probeHTTP(`http://127.0.0.1:${publicPort}/`, { timeoutMs: 5000 });
      return {
        ok: direct.ok && direct.status === 200,
        status: direct.status ?? null,
        error: direct.error ?? null,
      };
    },
  };
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
  configureLogging({ level: cfg.logging.level, dir: cfg.logging.dir, fileName: 'session.log' });

  const proxy = createSessionProxy(cfg, { noRefresh: args.noRefresh });
  try {
    await proxy.start();
  } catch (err) {
    log.error(`会话反代启动失败：${err.message}`);
    process.exit(1);
  }
  log.info(`浏览器打开 http://localhost:${cfg.ports.publicEntry}/ 即为已登录状态`);

  const shutdown = async () => {
    log.info('收到退出信号，关闭会话反代');
    await proxy.stop();
    log.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`执行失败：${err.stack ?? err.message}`);
    process.exit(1);
  });
}