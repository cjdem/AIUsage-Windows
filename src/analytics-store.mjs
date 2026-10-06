/**
 * 调用记录与成本统计（阶段 3）。
 *
 * 形态：**每次上游调用一条 JSONL**，按天分文件（<logging.dir>/analytics/calls-YYYY-MM-DD.jsonl），
 * 天然轮转、可 grep、可外部分析；同时内存里保留最近若干条供界面实时显示。
 *
 * 铁律：
 *  - 记录里绝不出现密钥/Cookie（只有模型名、上游 id、token 数、成本、耗时、错误摘要）。
 *  - 写盘失败只降级（打一条 warn），绝不影响推理主流程。
 *  - 聚合只读当天需要的文件，内存里不进大对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';

const RECENT_CAPACITY = 500;
const DAY_MS = 86_400_000;

/** 本地日期 YYYY-MM-DD（按本机时区，和用户看到的「今天」一致）。 */
export function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 从上游 usage 里取出成本（不同网关字段名不同，都兼容）。 */
export function extractCost(usage) {
  if (!usage || typeof usage !== 'object') return { cost: null, gatewayCost: null };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    cost: num(usage.cost) ?? num(usage.total_cost) ?? null,
    gatewayCost: num(usage.gateway_cost) ?? null,
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function createAnalyticsStore({ dir = null, clock = () => new Date(), recentCapacity = RECENT_CAPACITY } = {}) {
  const baseDir = dir ? path.join(dir, 'analytics') : null;
  const recent = [];
  let written = 0;
  let writeFailures = 0;

  function fileFor(date) {
    return path.join(baseDir, `calls-${localDateKey(date)}.jsonl`);
  }

  /** 追加一条调用记录；写失败只降级，绝不抛给调用方。 */
  function record(entry) {
    const record_ = { ts: new Date(clock()).toISOString(), ...entry };
    recent.push(record_);
    if (recent.length > recentCapacity) recent.splice(0, recent.length - recentCapacity);
    if (!baseDir) return record_;
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.appendFileSync(fileFor(new Date(record_.ts)), `${JSON.stringify(record_)}\n`, 'utf8');
      written += 1;
    } catch (err) {
      writeFailures += 1;
      if (writeFailures <= 3) log.warn(`调用记录写入失败（已降级为仅内存）：${err.message}`);
    }
    return record_;
  }

  /** 读取某天的记录（文件不存在或损坏行都安全跳过）。 */
  function readDay(dateKey) {
    if (!baseDir) return [];
    const file = path.join(baseDir, `calls-${dateKey}.jsonl`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* 跳过损坏行 */ }
    }
    return out;
  }

  /** 最近 n 天的聚合。 */
  function summarize({ days = 7 } = {}) {
    const span = Math.max(1, Math.min(90, Number(days) || 7));
    const now = new Date(clock());
    const dayKeys = [];
    for (let i = span - 1; i >= 0; i -= 1) {
      dayKeys.push(localDateKey(new Date(now.getTime() - i * DAY_MS)));
    }

    const totals = {
      calls: 0, ok: 0, failed: 0,
      inTokens: 0, outTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cost: 0, gatewayCost: 0, costedCalls: 0,
      streamCalls: 0, toolCalls: 0,
    };
    const durations = [];
    const ttfts = [];
    const byDayMap = new Map();
    const byModelMap = new Map();
    const byUpstreamMap = new Map();
    const errors = [];

    for (const dayKey of dayKeys) {
      const entries = readDay(dayKey);
      const day = {
        date: dayKey, calls: 0, failed: 0, inTokens: 0, outTokens: 0, cost: 0, durations: [],
      };
      for (const entry of entries) {
        totals.calls += 1;
        const ok = entry.ok !== false;
        if (ok) totals.ok += 1;
        else {
          totals.failed += 1;
          if (errors.length < 50 && entry.error) {
            errors.push({ ts: entry.ts, model: entry.model ?? null, upstreamId: entry.upstreamId ?? null, message: String(entry.error).slice(0, 300) });
          }
        }
        day.calls += 1;
        if (!ok) day.failed += 1;

        const inTokens = Number(entry.inTokens) || 0;
        const outTokens = Number(entry.outTokens) || 0;
        totals.inTokens += inTokens;
        totals.outTokens += outTokens;
        totals.reasoningTokens += Number(entry.reasoningTokens) || 0;
        totals.cacheReadTokens += Number(entry.cacheReadTokens) || 0;
        totals.cacheWriteTokens += Number(entry.cacheWriteTokens) || 0;
        day.inTokens += inTokens;
        day.outTokens += outTokens;

        if (typeof entry.cost === 'number') { totals.cost += entry.cost; totals.costedCalls += 1; day.cost += entry.cost; }
        if (typeof entry.gatewayCost === 'number') totals.gatewayCost += entry.gatewayCost;
        if (entry.stream) totals.streamCalls += 1;
        totals.toolCalls += Number(entry.toolCallCount) || 0;

        if (typeof entry.ms === 'number') { durations.push(entry.ms); day.durations.push(entry.ms); }
        if (typeof entry.ttftMs === 'number') ttfts.push(entry.ttftMs);

        const modelKey = entry.model ?? '(未知)';
        const model = byModelMap.get(modelKey) ?? {
          model: modelKey, calls: 0, failed: 0, inTokens: 0, outTokens: 0, cost: 0, gatewayCost: 0, durations: [],
        };
        model.calls += 1;
        if (!ok) model.failed += 1;
        model.inTokens += inTokens;
        model.outTokens += outTokens;
        model.cost += Number(entry.cost) || 0;
        model.gatewayCost += Number(entry.gatewayCost) || 0;
        if (typeof entry.ms === 'number') model.durations.push(entry.ms);
        byModelMap.set(modelKey, model);

        const upKey = entry.upstreamId ?? '(未知)';
        const upstream = byUpstreamMap.get(upKey) ?? { upstreamId: upKey, calls: 0, failed: 0, cost: 0 };
        upstream.calls += 1;
        if (!ok) upstream.failed += 1;
        upstream.cost += Number(entry.cost) || 0;
        byUpstreamMap.set(upKey, upstream);
      }
      byDayMap.set(dayKey, day);
    }

    const packDurations = (list) => ({ avgMs: average(list), p95Ms: percentile(list, 95) });

    return {
      days: span,
      from: dayKeys[0],
      to: dayKeys[dayKeys.length - 1],
      generatedAt: new Date(clock()).toISOString(),
      totals: {
        ...totals,
        ...packDurations(durations),
        ttftAvgMs: average(ttfts),
        failureRate: totals.calls > 0 ? totals.failed / totals.calls : 0,
      },
      byDay: dayKeys.map((key) => {
        const day = byDayMap.get(key);
        return {
          date: key,
          calls: day.calls,
          failed: day.failed,
          inTokens: day.inTokens,
          outTokens: day.outTokens,
          cost: day.cost,
          ...packDurations(day.durations),
        };
      }),
      byModel: [...byModelMap.values()]
        .map((model) => ({ ...model, ...packDurations(model.durations), durations: undefined }))
        .sort((a, b) => b.calls - a.calls),
      byUpstream: [...byUpstreamMap.values()].sort((a, b) => b.calls - a.calls),
      recentErrors: errors.reverse(),
      storedFiles: baseDir ? dayKeys.map((key) => path.join(baseDir, `calls-${key}.jsonl`)) : [],
    };
  }

  return {
    get dir() { return baseDir; },
    record,
    recent: (n = 100) => recent.slice(-Math.max(1, Number(n) || 100)),
    summarize,
    /** 供诊断/UI 显示。 */
    stats: () => ({ written, writeFailures, recent: recent.length }),
  };
}
