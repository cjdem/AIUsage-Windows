/**
 * 实时日志（阶段 1 基础版：级别/来源过滤 + 跟随滚动）。
 * 阶段 3 会在此基础上加：结构化调用记录、搜索、按请求聚合。
 */
import { el, clear, card, empty, fmtClock } from '../dom.mjs';

export function logLine(entry) {
  return el('div', { class: `log-line level-${entry.level}` }, [
    el('span', { class: 'log-ts', text: fmtClock(entry.ts) }),
    el('span', { class: 'log-src', text: entry.source }),
    el('span', { class: 'log-text', text: entry.text }),
  ]);
}

export default {
  id: 'logs',
  label: '实时日志',
  icon: '≡',
  tag: '基础版',

  mount(root, ctx) {
    const filters = { level: 'all', source: 'all', follow: true };
    const box = el('div', { class: 'log-console tall' });
    const countEl = el('span', { class: 'muted small' });

    const levelSelect = el('select', {
      onchange: (event) => { filters.level = event.target.value; renderAll(); },
    }, [
      el('option', { value: 'all', text: '全部级别' }),
      el('option', { value: 'info', text: 'info' }),
      el('option', { value: 'warn', text: 'warn' }),
      el('option', { value: 'error', text: 'error' }),
    ]);

    const sourceSelect = el('select', {
      onchange: (event) => { filters.source = event.target.value; renderAll(); },
    }, [
      el('option', { value: 'all', text: '全部来源' }),
      el('option', { value: 'proxy', text: 'proxy（代理）' }),
      el('option', { value: 'daemon', text: 'daemon（Science）' }),
    ]);

    const followToggle = el('input', {
      type: 'checkbox',
      checked: true,
      onchange: (event) => { filters.follow = event.target.checked; },
    });

    function pass(entry) {
      if (filters.level !== 'all' && entry.level !== filters.level) return false;
      if (filters.source !== 'all' && entry.source !== filters.source) return false;
      return true;
    }

    function renderAll() {
      clear(box);
      const list = ctx.logs().filter(pass);
      if (list.length === 0) box.append(empty('暂无匹配日志'));
      for (const entry of list) box.append(logLine(entry));
      countEl.textContent = `显示 ${list.length} / 缓冲 ${ctx.logs().length} 行`;
      box.scrollTop = box.scrollHeight;
    }

    const unsubscribe = ctx.onLog((entry) => {
      if (!pass(entry)) return;
      if (box.querySelector('.empty')) clear(box);
      box.append(logLine(entry));
      countEl.textContent = `缓冲 ${ctx.logs().length} 行`;
      if (filters.follow) box.scrollTop = box.scrollHeight;
    });

    root.append(
      card('实时日志', '推理代理 / 会话反代 / Science daemon 的输出汇聚（已脱敏）', [
        el('div', { class: 'toolbar' }, [
          el('label', {}, ['级别 ', levelSelect]),
          el('label', {}, ['来源 ', sourceSelect]),
          el('label', {}, [followToggle, '跟随滚动']),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: '清空视图',
            onclick: () => { ctx.clearLogs(); renderAll(); },
          }),
          countEl,
        ]),
        box,
        el('div', {
          class: 'muted small',
          text: '日志文件：配置里的 logging.dir/app.log（daemon 另有 daemon-serve.log / daemon-serve.err.log）',
        }),
      ]),
    );

    renderAll();

    return {
      update: renderAll,
      unmount: () => unsubscribe?.(),
    };
  },
};
