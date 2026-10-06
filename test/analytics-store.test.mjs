/**
 * 阶段 3 单测：调用记录（JSONL）与聚合。
 * 全部用临时目录与可控时钟，不碰真实日志目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalyticsStore, localDateKey, extractCost } from '../src/analytics-store.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sci-analytics-'));
}

test('localDateKey 用本机时区生成 YYYY-MM-DD', () => {
  assert.equal(localDateKey(new Date(2026, 9, 7, 23, 30)), '2026-10-07');
});

test('extractCost 兼容 cost / total_cost / gateway_cost，缺失返回 null', () => {
  assert.deepEqual(extractCost({ cost: 0.5, gateway_cost: 1 }), { cost: 0.5, gatewayCost: 1 });
  assert.deepEqual(extractCost({ total_cost: 0.25 }), { cost: 0.25, gatewayCost: null });
  assert.deepEqual(extractCost(null), { cost: null, gatewayCost: null });
  assert.deepEqual(extractCost({ cost: 'x' }), { cost: null, gatewayCost: null });
});

test('record 落盘为按天的 JSONL，且聚合一致', () => {
  const dir = tmpDir();
  const now = new Date(2026, 9, 7, 12, 0, 0);
  const store = createAnalyticsStore({ dir, clock: () => now });

  store.record({ model: 'claude-opus-5', upstreamModel: 'm', upstreamId: 'main', ok: true, stream: true, ms: 1200, ttftMs: 300, inTokens: 100, outTokens: 50, cost: 0.002, gatewayCost: 0.004, toolCallCount: 2 });
  store.record({ model: 'claude-opus-5', upstreamModel: 'm', upstreamId: 'main', ok: false, stream: true, ms: 800, error: '上游 500' });
  store.record({ model: 'claude-haiku-4-5-fast', upstreamModel: 'm2', upstreamId: 'fast', ok: true, stream: false, aggregated: true, ms: 400, inTokens: 10, outTokens: 5, cost: 0.001 });

  const file = path.join(dir, 'analytics', `calls-${localDateKey(now)}.jsonl`);
  assert.ok(fs.existsSync(file), '应按天生成 JSONL 文件');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line); // 每行都是合法 JSON

  assert.equal(store.stats().written, 3);

  const summary = store.summarize({ days: 1 });
  assert.equal(summary.totals.calls, 3);
  assert.equal(summary.totals.ok, 2);
  assert.equal(summary.totals.failed, 1);
  assert.equal(Math.round(summary.totals.failureRate * 100), 33);
  assert.equal(summary.totals.inTokens, 110);
  assert.equal(summary.totals.outTokens, 55);
  assert.equal(Number(summary.totals.cost.toFixed(6)), 0.003);
  assert.equal(Number(summary.totals.gatewayCost.toFixed(6)), 0.004);
  assert.equal(summary.totals.costedCalls, 2);
  assert.equal(summary.totals.toolCalls, 2);
  assert.equal(summary.totals.streamCalls, 2);
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel[0].model, 'claude-opus-5');
  assert.equal(summary.byModel[0].calls, 2);
  assert.equal(summary.byUpstream.length, 2);
  assert.equal(summary.byUpstream[0].upstreamId, 'main');
  assert.equal(summary.recentErrors.length, 1);
  assert.match(summary.recentErrors[0].message, /上游 500/);
});

test('聚合按天分组，跨天记录分开统计', () => {
  const dir = tmpDir();
  const day1 = new Date(2026, 9, 6, 10, 0, 0);
  const day2 = new Date(2026, 9, 7, 10, 0, 0);

  const store1 = createAnalyticsStore({ dir, clock: () => day1 });
  store1.record({ model: 'A', ok: true, ms: 100, cost: 0.01 });
  const store2 = createAnalyticsStore({ dir, clock: () => day2 });
  store2.record({ model: 'A', ok: true, ms: 300, cost: 0.02 });
  store2.record({ model: 'A', ok: true, ms: 500, cost: 0.03 });

  const summary = store2.summarize({ days: 2 });
  assert.equal(summary.from, '2026-10-06');
  assert.equal(summary.to, '2026-10-07');
  assert.equal(summary.byDay[0].date, '2026-10-06');
  assert.equal(summary.byDay[0].calls, 1);
  assert.equal(summary.byDay[1].calls, 2);
  assert.equal(summary.byDay[1].avgMs, 400);
  assert.equal(Number(summary.totals.cost.toFixed(4)), 0.06);
  // P95 只由当天数据决定
  assert.equal(summary.byDay[1].p95Ms, 500);
});

test('损坏行被跳过，不影响其余记录', () => {
  const dir = tmpDir();
  const now = new Date(2026, 9, 7, 10, 0, 0);
  const store = createAnalyticsStore({ dir, clock: () => now });
  store.record({ model: 'A', ok: true, ms: 100 });
  const file = path.join(dir, 'analytics', `calls-${localDateKey(now)}.jsonl`);
  fs.appendFileSync(file, '{这不是 JSON}\n', 'utf8');

  const summary = store.summarize({ days: 1 });
  assert.equal(summary.totals.calls, 1);
  assert.equal(summary.byDay[0].calls, 1);
});

test('内存保留上限生效（不会无限增长）', () => {
  const dir = tmpDir();
  const store = createAnalyticsStore({ dir, clock: () => new Date(2026, 9, 7), recentCapacity: 3 });
  for (let i = 0; i < 10; i += 1) store.record({ model: `m${i}`, ok: true });
  const recent = store.recent(100);
  assert.equal(recent.length, 3);
  assert.equal(recent.at(-1).model, 'm9');
  assert.equal(store.stats().recent, 3);
});

test('没有日志目录时只进内存，不抛错', () => {
  const store = createAnalyticsStore({ dir: null, clock: () => new Date(2026, 9, 7) });
  store.record({ model: 'A', ok: true });
  assert.equal(store.recent(10).length, 1);
  const summary = store.summarize({ days: 7 });
  assert.equal(summary.totals.calls, 0, '没有目录就不该有磁盘记录');
  assert.equal(summary.dir, undefined);
});

test('目录不可写时降级且不抛错', () => {
  // 用一个「文件」冒充目录，制造写入失败
  const fileAsDir = path.join(tmpDir(), 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');
  const store = createAnalyticsStore({ dir: fileAsDir, clock: () => new Date(2026, 9, 7) });
  assert.doesNotThrow(() => store.record({ model: 'A', ok: true }));
  assert.equal(store.stats().writeFailures >= 1, true);
  assert.equal(store.recent(10).length, 1, '写盘失败也必须保留内存记录');
});
