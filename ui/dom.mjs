/**
 * 极小 DOM 辅助（不引入任何框架/构建工具）。
 * 一律用 textContent 写入动态数据，绝不拼 innerHTML —— 日志与配置内容不参与 HTML 解析。
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(node, child);
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function card(title, subtitle, body, actions = null) {
  return el('section', { class: 'card' }, [
    el('header', { class: 'card-head' }, [
      el('div', {}, [
        el('h2', { class: 'card-title', text: title }),
        subtitle ? el('div', { class: 'card-sub', text: subtitle }) : null,
      ]),
      actions,
    ]),
    el('div', { class: 'card-body' }, body),
  ]);
}

/** 一行「键 → 值」。value 为空时显示占位符。 */
export function kv(label, value, { mono = false, tone = null } = {}) {
  const text = value === null || value === undefined || value === '' ? '—' : String(value);
  return el('div', { class: 'kv' }, [
    el('span', { class: 'kv-k', text: label }),
    el('span', {
      class: ['kv-v', mono ? 'mono' : '', tone ? `tone-${tone}` : ''].filter(Boolean).join(' '),
      text,
      title: text,
    }),
  ]);
}

export function badge(text, tone = 'idle') {
  return el('span', { class: `badge tone-${tone}`, text });
}

export function fmtClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDuration(fromIso, toMs = Date.now()) {
  if (!fromIso) return '—';
  const start = new Date(fromIso).getTime();
  if (Number.isNaN(start)) return '—';
  const sec = Math.max(0, Math.round((toMs - start) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function empty(text) {
  return el('div', { class: 'empty', text });
}
