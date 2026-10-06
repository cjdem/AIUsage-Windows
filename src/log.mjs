/**
 * 结构化日志 + 脱敏。
 *
 * 铁律：任何密钥、令牌、Cookie、Authorization 头都不允许以明文进入日志或控制台。
 * 所有调用方要么只传非敏感字段，要么走 `redactHeaderValue()` 先打码。
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const SECRET_KEY_RE = /(api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|bearer|cookie|csrf|secret|password|nonce)/i;
const SECRET_VALUE_RE = /\b(sk[-_][A-Za-z0-9._-]{8,}|sk-ant-[A-Za-z0-9._-]{8,})\b/g;

let currentLevel = LEVELS.info;
let logStream = null;
let logSink = null;

export function configureLogging({ level = 'info', dir = null, fileName = 'science-proxy.log' } = {}) {
  currentLevel = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
      // 文件日志是旁路：目录被清理/文件被占用时绝不能让进程崩掉（只降级为仅 stdout）
      stream.on('error', (err) => {
        console.error(`[log] 日志文件不可写，已停用文件日志：${err.message}`);
        try { stream.destroy(); } catch { /* ignore */ }
        if (logStream === stream) logStream = null;
      });
      logStream = stream;
    } catch (err) {
      logStream = null;
      console.error(`[log] 无法打开日志文件：${err.message}`);
    }
  }
}

/**
 * 注册日志订阅者（桌面控制台的事件总线用）。传 null 取消订阅。
 * 订阅者只读收到「已脱敏」的行，绝不可能拿到原始密钥。
 */
export function setLogSink(fn) {
  logSink = typeof fn === 'function' ? fn : null;
}
/** 打码任意字符串中的疑似密钥与一次性 nonce。 */
export function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value.replace(SECRET_VALUE_RE, (m) => `${m.slice(0, 6)}…<redacted:${m.length}>`);
  // 长 base64/hex 串（32+ 连续字符）也视为潜在密钥
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => `${m.slice(0, 6)}…<redacted:${m.length}>`);
  // 一次性登录链接里的 nonce 绝不能落日志（长度通常不足 40，不会被上面的规则命中）
  out = out.replace(/([?&]nonce=)[^\s&"'<>]+/gi, '$1<redacted>');
  return out;
}

/** 摘要头部值：保留前 6 位便于对齐排查，其余打码。 */
export function redactHeaderValue(name, value) {
  if (value == null) return value;
  if (!SECRET_KEY_RE.test(String(name))) return String(value);
  const s = String(value);
  return `${s.slice(0, 6)}…<redacted:${s.length}>`;
}

/** 头部对象 -> 可安全打印的字符串（敏感值打码）。 */
export function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.map((x) => redactHeaderValue(k, x)) : redactHeaderValue(k, v);
  }
  return out;
}

function emit(level, message, extra) {
  if (LEVELS[level] > currentLevel) return;
  const stamp = new Date().toISOString();
  let line = `${stamp} [${level}] ${redact(String(message))}`;
  if (extra !== undefined) {
    try {
      line += ` ${redact(typeof extra === 'string' ? extra : JSON.stringify(extra))}`;
    } catch {
      line += ' <unserializable>';
    }
  }
  // stdout 供脚本捕获，文件留档
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  if (logStream) logStream.write(`${line}\n`);
  if (logSink) {
    // 旁路：订阅者抛错绝不能影响主流程
    try { logSink({ level, message: String(message), line }); } catch { /* ignore */ }
  }
}

export const log = {
  error: (msg, extra) => emit('error', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  debug: (msg, extra) => emit('debug', msg, extra),
  level: () => currentLevel,
  close: () => {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
  },
};
