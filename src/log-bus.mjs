/**
 * 日志/事件总线（阶段 1 基础版）：把「同一进程里的 log.mjs」与「子进程 stdout/stderr」
 * 汇聚成结构化事件，供桌面控制台实时显示。
 *
 * 铁律：
 *  - 只做转发，绝不修改内容；脱敏在 log.mjs 的 emit 里已经完成（子进程行的脱敏见 redactLine）。
 *  - 环形缓冲有上限，长时间运行不会无限吃内存。
 *  - 订阅者抛错绝不冒泡（日志是旁路，不能拖垮主流程）。
 *
 * 阶段 3 会在本模块上扩展：JSON 行解析、调用记录（usage/cost）、按请求聚合。
 */
import { redact, setLogSink } from './log.mjs';

const DEFAULT_CAPACITY = 2000;

/** 子进程原始行也过一遍脱敏（例如 daemon 可能打印密钥前缀）。 */
function redactLine(text) {
  try {
    return redact(String(text ?? ''));
  } catch {
    return String(text ?? '');
  }
}

/**
 * @param {{capacity?: number}} options
 */
export function createLogBus({ capacity = DEFAULT_CAPACITY } = {}) {
  /** @type {Array<{seq:number,ts:string,level:string,source:string,text:string}>} */
  let entries = [];
  const subscribers = new Set();
  let seq = 0;
  let dropped = 0;

  function push({ level = 'info', source = 'app', text = '', ts = null } = {}) {
    const entry = {
      seq: (seq += 1),
      ts: ts ?? new Date().toISOString(),
      level: String(level),
      source: String(source),
      text: String(text),
    };
    entries.push(entry);
    if (entries.length > capacity) {
      dropped += entries.length - capacity;
      entries = entries.slice(-capacity);
    }
    for (const fn of subscribers) {
      try {
        fn(entry);
      } catch {
        /* 订阅者异常忽略 */
      }
    }
    return entry;
  }

  return {
    push,
    /** 最近 n 条（默认全部缓冲内容），按时间正序。 */
    recent(n = capacity) {
      const count = Math.max(1, Number(n) || capacity);
      return entries.slice(-count);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    subscriberCount: () => subscribers.size,
    size: () => entries.length,
    droppedCount: () => dropped,
    clear() {
      entries = [];
    },
  };
}

/** 把 log.mjs 的输出接到总线上（整个进程只应调用一次）。 */
export function attachProcessLogs(bus, { source = 'proxy' } = {}) {
  setLogSink(({ level, line }) => bus.push({ level, source, text: line }));
  return () => setLogSink(null);
}

/**
 * 把子进程（或任意可读流）的 stdout/stderr 按行接到总线上。
 * 返回 detach 函数。
 */
export function attachStreamLines(stream, bus, { source = 'child', level = 'info' } = {}) {
  if (!stream) return () => {};
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') bus.push({ level, source, text: redactLine(line) });
    }
    // 单行异常长时（例如 daemon 打印大 JSON）避免无界增长
    if (buffer.length > 64 * 1024) {
      bus.push({ level, source, text: redactLine(buffer) });
      buffer = '';
    }
  };
  const onEnd = () => {
    if (buffer.trim() !== '') {
      bus.push({ level, source, text: redactLine(buffer) });
      buffer = '';
    }
  };
  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}
