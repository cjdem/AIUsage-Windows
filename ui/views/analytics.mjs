/**
 * 成本与用量（阶段 3）：读调用记录 JSONL 的聚合结果。
 *
 * 数据来源就是推理代理每次调用写下的那条 JSONL（含上游真实 cost / gateway_cost、token、耗时、TTFT）。
 * 不产出任何估算值：上游没返回成本就显示「—」。
 */
import { el, clear, append, card, kv } from '../dom.mjs';

const DAY_OPTIONS = [1, 7, 30];

function fmtCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function fmtInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

function fmtMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value)} ms`;
}

function fmtPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

function fmtClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 固定列数的表格（列数用 CSS 类控制，避免内联 style 被 CSP 拦掉）。 */
function table(columns, headers, rows) {
  const cls = `cols-${Math.min(7, Math.max(1, columns))}`;
  if (rows.length === 0) {
    return el('div', { class: 'empty', text: '该时间段没有记录' });
  }
  return el('div', { class: 'table' }, [
    el('div', { class: `table-head ${cls}` }, headers.map((h) => el('span', { text: h }))),
    ...rows.map((cells) => el('div', { class: `table-row ${cls}` }, cells.map((c) => el('span', {
      text: c === null || c === undefined || c === '' ? '—' : String(c),
      title: typeof c === 'string' ? c : undefined,
    })))),
  ]);
}

export default {
  id: 'analytics',
  label: '成本与用量',
  icon: '▦',

  mount(root, ctx) {
    let days = 7;
    let data = null;
    let error = null;
    let loading = false;

    async function load() {
      if (loading) return;
      loading = true;
      render();
      try {
        const res = await ctx.api.analytics({ days, recent: 60 });
        if (res.ok) {
          data = res.data;
          error = null;
        } else {
          error = res.error;
        }
      } catch (err) {
        error = { message: err.message };
      } finally {
        loading = false;
        render();
      }
    }

    const unsubscribe = ctx.onEvent((event) => {
      // 启停完成后刷新一次（链路刚跑过就可能产生新记录）
      if (event.type === 'done') load();
    });

    function render() {
      clear(root);

      const daySelector = el('div', { class: 'actions' }, DAY_OPTIONS.map((option) => el('button', {
        class: `btn ${option === days ? 'primary' : 'ghost'}`,
        type: 'button',
        text: option === 1 ? '今天' : `最近 ${option} 天`,
        onclick: () => { days = option; load(); },
      })));

      const toolbar = card('时间范围', '数据来自调用记录 JSONL；无需重启链路即可看到新记录', [
        daySelector,
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: loading ? '读取中…' : '刷新',
            disabled: loading,
            onclick: load,
          }),
          el('span', {
            class: 'muted small',
            text: data ? `生成于 ${fmtClock(data.summary.generatedAt)}` : '',
          }),
        ]),
      ]);

      if (error) {
        append(root, [toolbar, el('div', { class: 'banner banner-err', text: `读取统计失败：${error.message}` })]);
        return;
      }
      if (!data) {
        append(root, [toolbar, el('div', { class: 'hint-box', text: '正在读取调用记录…' })]);
        return;
      }

      const { summary, recent, dir } = data;
      const totals = summary.totals;

      const totalsCard = card('汇总', `${summary.from} ~ ${summary.to}`, [
        el('div', { class: 'stat-grid' }, [
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtInt(totals.calls) }),
            el('div', { class: 'stat-label', text: '调用次数' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: `stat-value ${totals.failed > 0 ? 'tone-err' : ''}`, text: `${fmtInt(totals.ok)} / ${fmtInt(totals.failed)}` }),
            el('div', { class: 'stat-label', text: '成功 / 失败' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtPercent(totals.failureRate) }),
            el('div', { class: 'stat-label', text: '失败率' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtCost(totals.cost) }),
            el('div', { class: 'stat-label', text: `上游成本（${fmtInt(totals.costedCalls)} 次有返回）` }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtCost(totals.gatewayCost) }),
            el('div', { class: 'stat-label', text: 'gateway_cost 合计' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtMs(totals.avgMs) }),
            el('div', { class: 'stat-label', text: `平均耗时（P95 ${totals.p95Ms === null ? '—' : `${Math.round(totals.p95Ms)} ms`}）` }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtMs(totals.ttftAvgMs) }),
            el('div', { class: 'stat-label', text: '首字延迟（平均）' }),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-value', text: fmtInt(totals.inTokens + totals.outTokens) }),
            el('div', { class: 'stat-label', text: `输入 ${fmtInt(totals.inTokens)} / 输出 ${fmtInt(totals.outTokens)}` }),
          ]),
        ]),
        kv('推理 token', fmtInt(totals.reasoningTokens)),
        kv('缓存读取 / 写入', `${fmtInt(totals.cacheReadTokens)} / ${fmtInt(totals.cacheWriteTokens)}`),
        kv('流式调用 / 工具调用', `${fmtInt(totals.streamCalls)} / ${fmtInt(totals.toolCalls)}`),
        kv('记录目录', dir, { mono: true }),
      ]);

      const byDayCard = card('按天', '成本与调用量趋势', [
        table(7, ['日期', '调用', '失败', '输入', '输出', '成本', '平均耗时'],
          summary.byDay.slice().reverse().map((day) => [
            day.date,
            fmtInt(day.calls),
            day.failed > 0 ? fmtInt(day.failed) : '',
            fmtInt(day.inTokens),
            fmtInt(day.outTokens),
            fmtCost(day.cost),
            fmtMs(day.avgMs),
          ])),
      ]);

      const byModelCard = card('按模型', 'Science 看到的发布型号', [
        table(6, ['模型', '调用', '失败', '输入', '输出', '成本'],
          summary.byModel.map((model) => [
            model.model,
            fmtInt(model.calls),
            model.failed > 0 ? fmtInt(model.failed) : '',
            fmtInt(model.inTokens),
            fmtInt(model.outTokens),
            fmtCost(model.cost),
          ])),
      ]);

      const byUpstreamCard = card('按上游', '请求实际打到了哪个上游', [
        table(4, ['上游', '调用', '失败', '成本'],
          summary.byUpstream.map((upstream) => [
            upstream.upstreamId,
            fmtInt(upstream.calls),
            upstream.failed > 0 ? fmtInt(upstream.failed) : '',
            fmtCost(upstream.cost),
          ])),
      ]);

      const recentCard = card('最近调用', '内存里的最近若干条（与磁盘 JSONL 一致）', [
        table(7, ['时间', '模型', '上游', '流式', '输入/输出', '耗时', '成本'],
          (recent ?? []).slice().reverse().map((entry) => [
            fmtClock(entry.ts),
            entry.model ?? '',
            entry.upstreamId ?? '',
            entry.stream ? '是' : '否',
            `${fmtInt(entry.inTokens)}/${fmtInt(entry.outTokens)}`,
            fmtMs(entry.ms),
            fmtCost(entry.cost),
          ])),
      ]);

      const errorsCard = card('错误摘要', `最近 ${summary.recentErrors.length} 条`, [
        summary.recentErrors.length === 0
          ? el('div', { class: 'empty', text: '该时间段没有失败记录' })
          : el('div', { class: 'error-list' }, summary.recentErrors.map((item) => el('div', { class: 'error-item' }, [
            el('span', { class: 'mono muted', text: fmtClock(item.ts) }),
            el('span', { class: 'tone-err', text: item.model ?? '' }),
            el('span', { text: item.message }),
          ]))),
      ]);

      append(root, [
        toolbar,
        totalsCard,
        el('div', { class: 'grid two' }, [byModelCard, byUpstreamCard]),
        byDayCard,
        recentCard,
        errorsCard,
      ]);
    }

    load();

    return {
      update() { /* 由显式刷新 / 事件驱动，不随状态轮询重建 */ },
      unmount: () => unsubscribe?.(),
    };
  },
};
