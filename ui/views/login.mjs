/**
 * 登录态与备份（阶段 5）：查看 / 写入 / 移除虚拟登录 + 备份列表与一键还原 + doctor。
 *
 * 危险操作（移除虚拟登录、从备份还原）一律走「两步确认」：按钮先变成「确认…」，
 * 再点一次才真正执行——不用 window.confirm（阻塞式弹窗在 Electron 里体验很差）。
 */
import { el, clear, append, card, kv, badge } from '../dom.mjs';

function fmtClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const STATUS_TONE = { pass: 'ok', fail: 'err', skip: 'warn' };
const STATUS_LABEL = { pass: '通过', fail: '失败', skip: '跳过' };

function button(label, onclick, { className = 'btn', disabled = false } = {}) {
  return el('button', { class: className, type: 'button', text: label, disabled, onclick });
}

export default {
  id: 'login',
  label: '登录态与备份',
  icon: '⚿',

  mount(root, ctx) {
    let backups = null;
    let doctorReport = null;
    let busy = null;
    let error = null;
    let notice = null;
    let forceOn = false;
    let confirmPending = null;

    async function run(label, fn) {
      if (busy) return;
      busy = label;
      error = null;
      notice = null;
      confirmPending = null;
      render();
      try {
        const res = await fn();
        if (res?.ok === false) error = res.error;
        else notice = `${label}完成`;
      } catch (err) {
        error = { message: err.message };
      } finally {
        busy = null;
        render();
      }
    }

    const loadBackups = () => run('读取备份列表', async () => {
      const res = await ctx.api.backupsList();
      if (res.ok) backups = res.data;
      return res;
    });

    function renderLogin() {
      const login = ctx.status?.login;
      if (!login) {
        return card('登录态', '正在读取登录态…', [el('div', { class: 'hint-box', text: '正在读取登录态…' })]);
      }
      if (login.error) {
        return card('登录态', '读取失败', [el('div', { class: 'hint-box', text: `读取登录态失败：${login.error}` })]);
      }
      const tokens = login.tokens ?? [];
      const hasVirtual = tokens.some((token) => token.virtual);
      return card('登录态', '真实登录会被原样保留；本工具只写带标记的虚拟凭证', [
        el('div', { class: 'form-row' }, [
          el('label', { class: 'form-label', text: '判定' }),
          el('div', { class: 'form-control' }, [
            login.hasRealLogin
              ? badge('真实 Claude 登录', 'info')
              : (hasVirtual ? badge('虚拟登录（本工具写入）', 'ok') : badge('无凭证', 'warn')),
          ]),
        ]),
        kv('encryption.key', login.keyAvailable ? '可用' : `不可用：${login.keyError ?? '未知'}`, {
          tone: login.keyAvailable ? 'ok' : 'err',
        }),
        kv('数据目录', login.dataDir, { mono: true }),
        kv('令牌文件', (login.files ?? []).join(', ') || '（无）', { mono: true }),
        ...tokens.map((token) => el('div', { class: 'token-row' }, [
          el('span', { class: 'mono', text: token.file }),
          el('span', { text: token.email ?? '—' }),
          el('span', { class: 'muted', text: token.provider ?? '—' }),
          el('span', { class: 'muted', text: token.expiresAt ?? '—' }),
          token.virtual ? badge('虚拟', 'ok') : badge('非本工具写入', 'warn'),
          token.decryptError ? badge(`解密失败：${token.decryptError}`, 'err') : null,
        ])),
        el('div', {
          class: 'hint-box',
          text: '写入护栏：若目录里存在「非本工具写入」的凭证，默认拒绝覆盖（需要显式勾选强制）。'
            + '移除只删带 aiusage_virtual 标记的文件。',
        }),
      ]);
    }

    function renderActions() {
      const login = ctx.status?.login ?? {};
      const tokens = login.tokens ?? [];
      const hasVirtual = tokens.some((token) => token.virtual);
      const hasForeign = tokens.some((token) => !token.virtual);

      const writeLabel = busy === '写入虚拟登录' ? '写入中…' : '写入虚拟登录';
      const removeLabel = busy === '移除虚拟登录' ? '移除中…' : '移除虚拟登录';

      return card('操作', '写入 / 移除虚拟登录', [
        el('label', { class: 'form-row' }, [
          el('span', { class: 'form-label', text: '强制覆盖' }),
          el('div', { class: 'form-control' }, [
            el('label', {}, [
              el('input', {
                type: 'checkbox',
                ...(forceOn ? { checked: true } : {}),
                onchange: (event) => { forceOn = event.target.checked; },
              }),
              ' 允许覆盖非本工具写入的凭证（危险：会删掉真实登录令牌）',
            ]),
          ]),
        ]),
        el('div', { class: 'actions' }, [
          button(writeLabel, () => run('写入虚拟登录', () => ctx.api.loginWrite({ force: forceOn })), {
            className: 'btn primary',
            disabled: !!busy,
          }),
          hasVirtual
            ? button(
              confirmPending === 'remove' ? '确认移除（再点一次）' : removeLabel,
              () => {
                if (confirmPending !== 'remove') {
                  confirmPending = 'remove';
                  render();
                  return;
                }
                run('移除虚拟登录', () => ctx.api.loginRemove());
              },
              { className: 'btn danger', disabled: !!busy },
            )
            : null,
        ]),
        hasForeign && !forceOn
          ? el('div', { class: 'hint-box', text: '检测到非本工具写入的凭证：不勾选「强制覆盖」时写入会被拒绝，这是有意的护栏。' })
          : null,
        hasVirtual
          ? el('div', { class: 'hint-box', text: '移除后 Science 会回到未登录状态；想恢复只需重新写入。' })
          : null,
      ]);
    }

    function renderBackups() {
      const entries = backups?.entries ?? [];
      return card('备份', backups?.root ? `目录：${backups.root}` : '真实 data-dir 的凭据与状态文件', [
        el('div', { class: 'actions' }, [
          button(busy === '读取备份列表' ? '读取中…' : '刷新列表', loadBackups, { disabled: !!busy }),
          button(busy === '立即备份' ? '备份中…' : '立即备份', () => run('立即备份', async () => {
            const res = await ctx.api.backupCreate();
            await loadBackups();
            return res;
          }), { className: 'btn primary', disabled: !!busy }),
        ]),
        entries.length === 0
          ? el('div', { class: 'empty', text: '还没有备份（启动链路时会自动备份一次，也可以点「立即备份」）' })
          : el('div', { class: 'table' }, [
            el('div', { class: 'table-head cols-5' }, [
              el('span', { text: '时间' }), el('span', { text: '名称' }),
              el('span', { text: '备份项' }), el('span', { text: '缺失项' }), el('span', { text: '操作' }),
            ]),
            ...entries.map((entry) => el('div', { class: 'table-row cols-5' }, [
              el('span', { text: fmtClock(entry.createdAt) }),
              el('span', { class: 'mono', text: entry.name, title: entry.dir }),
              el('span', { text: entry.copied === null ? '—' : `${entry.copied.length}` }),
              el('span', { text: entry.missing === null ? '—' : `${entry.missing.length}` }),
              el('span', {}, [
                button(
                  confirmPending === entry.dir ? '确认还原' : '还原',
                  () => {
                    if (confirmPending !== entry.dir) {
                      confirmPending = entry.dir;
                      render();
                      return;
                    }
                    run('从备份还原', () => ctx.api.backupRestore(entry.dir));
                  },
                  { className: 'btn ghost', disabled: !!busy },
                ),
              ]),
            ])),
          ]),
        el('div', {
          class: 'hint-box',
          text: '还原会覆盖当前 data-dir 里的凭据/状态文件（只覆盖备份清单里列出的项）。'
            + '建议还原后点顶栏「重启」让 daemon 重新读取。',
        }),
      ]);
    }

    function renderDoctor() {
      const report = doctorReport;
      return card('doctor', '把对 Claude Science 0.1.56 私有协议的假设变成可复现断言', [
        el('div', { class: 'actions' }, [
          button(busy === '运行 doctor' ? '检查中…' : '运行 doctor', () => run('运行 doctor', async () => {
            const res = await ctx.api.doctor();
            if (res.ok) doctorReport = res.data;
            return res;
          }), { className: 'btn primary', disabled: !!busy }),
          report
            ? el('span', {
              class: 'muted small',
              text: `通过 ${report.summary.pass} · 失败 ${report.summary.fail} · 跳过 ${report.summary.skip}`,
            })
            : el('span', { class: 'muted small', text: '链路在运行时执行可覆盖更多检查（CSRF / Origin / nonce）' }),
        ]),
        report
          ? el('div', { class: 'doctor-list' }, report.checks.map((check) => el('div', { class: 'doctor-item' }, [
            badge(STATUS_LABEL[check.status] ?? check.status, STATUS_TONE[check.status] ?? 'idle'),
            el('span', { class: 'doctor-label', text: check.label }),
            el('span', { class: 'muted small', text: check.detail ?? '' }),
          ])))
          : el('div', { class: 'empty', text: '尚未运行' }),
      ]);
    }

    function render() {
      clear(root);
      if (error) {
        root.append(el('div', { class: 'banner banner-err' }, [
          el('div', { text: `操作失败：${error.message}` }),
          error.hint ? el('div', { class: 'banner-hint', text: `提示：${error.hint}` }) : null,
        ]));
      }
      if (notice) root.append(el('div', { class: 'banner banner-ok', text: notice }));
      if (busy) root.append(el('div', { class: 'hint-box', text: `正在执行：${busy}…` }));

      append(root, [
        el('div', { class: 'grid two' }, [renderLogin(), renderActions()]),
        renderBackups(),
        renderDoctor(),
      ]);
    }

    render();
    if (!backups) loadBackups();

    return {
      update() { render(); },
    };
  },
};
