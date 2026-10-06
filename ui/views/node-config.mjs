/**
 * 节点与模型映射（阶段 2：可编辑）。
 *
 * 三块：
 *   1. 档位映射：主对话 / 子代理 / 辅助调用 / 未知型号 分别指向哪个发布模型。
 *   2. 上游节点：增删改（密钥永不回显；留空 = 保持不变）、逐个「一键探测」（只走流式）。
 *   3. 模型映射：publishAs ⇄ 真实模型名 + 归属上游，以及默认模型。
 *
 * 保存由主进程做「先校验、再原子落盘」，校验失败时磁盘配置不变，这里只把错误显示出来。
 * 表单是本页的唯一真相：状态轮询不会重建表单，避免把正在输入的内容冲掉。
 */
import { el, clear, append, card, kv } from '../dom.mjs';

function textInput(value, oninput, { placeholder = '', width = null } = {}) {
  const input = el('input', {
    type: 'text',
    value: value ?? '',
    placeholder,
    oninput: (event) => oninput(event.target.value),
  });
  if (width) input.style.width = width;
  return input;
}

function numberInput(value, oninput, { width = '90px' } = {}) {
  const input = el('input', {
    type: 'text',
    value: String(value ?? ''),
    oninput: (event) => oninput(event.target.value),
  });
  input.style.width = width;
  return input;
}

function selectInput(options, value, onchange, { width = null } = {}) {
  const select = el('select', { onchange: (event) => onchange(event.target.value) },
    options.map((opt) => el('option', {
      value: opt.value,
      text: opt.label,
      ...(String(opt.value) === String(value) ? { selected: true } : {}),
    })));
  if (width) select.style.width = width;
  return select;
}

function checkbox(checked, onchange) {
  return el('input', {
    type: 'checkbox',
    ...(checked ? { checked: true } : {}),
    onchange: (event) => onchange(event.target.checked),
  });
}

function field(label, control, hint = null) {
  return el('div', { class: 'form-row' }, [
    el('label', { class: 'form-label', text: label }),
    el('div', { class: 'form-control' }, [control, hint ? el('div', { class: 'muted small', text: hint }) : null]),
  ]);
}

function button(label, onclick, { className = 'btn', disabled = false } = {}) {
  return el('button', { class: className, type: 'button', text: label, disabled, onclick });
}

export default {
  id: 'node-config',
  label: '节点与模型映射',
  icon: '⇄',

  mount(root, ctx) {
    /** 表单草稿：本页唯一真相。 */
    let draft = null;
    let probeResult = null;
    let probingId = null;
    let error = null;
    let notice = null;
    let saving = false;

    function editingView() {
      const editing = ctx.config?.editing;
      return editing?.ok ? editing : null;
    }

    function loadDraft() {
      const editing = editingView();
      if (!editing) return false;
      draft = {
        configPath: editing.configPath,
        tierKeys: editing.tierKeys ?? ['opus', 'sonnet', 'haiku', 'default'],
        tierLabels: editing.tierLabels ?? {},
        tiers: { ...editing.tiers },
        defaultModel: editing.defaultModel,
        unknownModelPolicy: editing.unknownModelPolicy,
        upstreams: editing.upstreams.map((u) => ({ ...u, apiKeyInput: '' })),
        models: editing.models.map((m) => ({ ...m })),
      };
      return true;
    }

    // ---- 探测 ----

    async function runProbe(upstream) {
      if (probingId) return;
      probingId = upstream.id;
      error = null;
      notice = null;
      probeResult = null;
      render();
      try {
        const res = await ctx.api.probeUpstream({
          upstreamId: upstream.id,
          baseURL: upstream.baseURL,
          // 只有用户新填了密钥才传（否则用服务端保存的密钥）
          ...(upstream.apiKeyInput ? { apiKey: upstream.apiKeyInput } : {}),
          ...(draft.defaultModel ? { model: draft.defaultModel } : {}),
        });
        if (res.ok) probeResult = res.data;
        else error = res.error;
      } catch (err) {
        error = { message: err.message };
      } finally {
        probingId = null;
        render();
      }
    }

    // ---- 保存 ----

    function buildPatch() {
      return {
        upstreams: draft.upstreams.map((u) => {
          const item = {
            id: u.id,
            label: u.label,
            baseURL: u.baseURL,
            apiMode: u.apiMode ?? 'chat_completions',
            maxTokensField: u.maxTokensField ?? 'max_tokens',
            sendStreamUsage: u.sendStreamUsage !== false,
            supportsTools: u.supportsTools !== false,
            supportsReasoningEffort: u.supportsReasoningEffort === true,
            supportsParallelTools: u.supportsParallelTools !== false,
            timeoutMs: Number(u.timeoutMs ?? 600_000),
          };
          // 留空 = 保持原密钥（主进程按 id 找回；新上游必须填）
          if (u.apiKeyInput) item.apiKey = u.apiKeyInput;
          return item;
        }),
        models: draft.models.map((m) => ({
          id: m.id,
          publishAs: m.publishAs,
          displayName: m.displayName,
          upstream: m.upstream,
        })),
        tiers: { ...draft.tiers },
        defaultModel: draft.defaultModel,
      };
    }

    async function save() {
      if (saving) return;
      saving = true;
      error = null;
      notice = null;
      render();
      try {
        const res = await ctx.api.saveConfig(buildPatch());
        if (!res.ok) {
          error = res.error;
        } else {
          notice = `已保存到 ${res.data.path}${res.data.needRestart ? '；运行中的链路需点「重启」后生效' : ''}`;
          await ctx.reloadConfig();
          loadDraft();
        }
      } catch (err) {
        error = { message: err.message };
      } finally {
        saving = false;
        render();
      }
    }

    // ---- 渲染 ----

    function renderUpstream(upstream, index) {
      const probing = probingId === upstream.id;
      return card(
        upstream.label || upstream.id,
        `${upstream.apiKey ? `密钥 ${upstream.apiKey}` : '密钥未设置'}${upstream.isLoopback ? ' · 回环地址' : ''}`,
        [
          field('ID', textInput(upstream.id, (v) => { upstream.id = v; }, { width: '160px' }),
            '英文/数字，用于 models 里引用；改动后记得同步模型的归属'),
          field('名称', textInput(upstream.label, (v) => { upstream.label = v; })),
          field('Base URL', textInput(upstream.baseURL, (v) => { upstream.baseURL = v; }), '不含 /chat/completions'),
          field('API Key', textInput(upstream.apiKeyInput, (v) => { upstream.apiKeyInput = v; }, {
            placeholder: `当前 ${upstream.apiKey}（留空表示不改）`,
            width: '320px',
          })),
          field('max tokens 字段', selectInput([
            { value: 'max_tokens', label: 'max_tokens（默认）' },
            { value: 'max_completion_tokens', label: 'max_completion_tokens' },
          ], upstream.maxTokensField, (v) => { upstream.maxTokensField = v; })),
          field('超时', numberInput(upstream.timeoutMs, (v) => { upstream.timeoutMs = Number(v) || 600_000; }),
            '毫秒；长会话/大 artifact 可调大'),
          el('div', { class: 'form-row' }, [
            el('label', { class: 'form-label', text: '能力标记' }),
            el('div', { class: 'form-control capability-row' }, [
              el('label', {}, [checkbox(upstream.supportsTools !== false, (v) => { upstream.supportsTools = v; }), ' 支持工具调用']),
              el('label', {}, [checkbox(upstream.supportsReasoningEffort === true, (v) => { upstream.supportsReasoningEffort = v; }), ' 支持 reasoning_effort']),
              el('label', {}, [checkbox(upstream.sendStreamUsage !== false, (v) => { upstream.sendStreamUsage = v; }), ' 流式返回 usage']),
              el('label', {}, [checkbox(upstream.supportsParallelTools !== false, (v) => { upstream.supportsParallelTools = v; }), ' 支持并行工具']),
            ]),
          ]),
        ],
        el('div', { class: 'actions' }, [
          button(probing ? '探测中…' : '一键探测', () => runProbe(upstream), { className: 'btn primary', disabled: !!probingId }),
          draft.upstreams.length > 1
            ? button('删除', () => {
              draft.upstreams.splice(index, 1);
              render();
            }, { className: 'btn ghost' })
            : null,
        ]),
      );
    }

    function renderModel(model, index) {
      const upstreamOptions = draft.upstreams.map((u) => ({ value: u.id, label: `${u.label || u.id}（${u.id}）` }));
      return el('div', { class: 'model-row' }, [
        textInput(model.publishAs, (v) => { model.publishAs = v; }, { placeholder: '对 Science 发布的型号' }),
        textInput(model.id, (v) => { model.id = v; }, { placeholder: '上游真实模型名' }),
        textInput(model.displayName, (v) => { model.displayName = v; }, { placeholder: '显示名' }),
        selectInput(
          upstreamOptions.length > 0 ? upstreamOptions : [{ value: '', label: '（无上游）' }],
          model.upstream,
          (v) => { model.upstream = v; },
        ),
        button('删除', () => { draft.models.splice(index, 1); render(); }, { className: 'btn ghost' }),
      ]);
    }

    function renderProbe() {
      if (probingId) return el('div', { class: 'hint-box', text: `正在探测上游 ${probingId}（只走流式，约 5–30 秒）…` });
      if (!probeResult) return null;
      const r = probeResult;
      const lines = [
        kv('上游', `${r.upstreamId ?? '-'} · ${r.origin}`, { mono: true }),
        kv('模型列表', r.modelsEndpoint?.ok ? `OK（${r.modelsEndpoint.ids.length} 个）` : `失败：${r.modelsEndpoint?.status ?? ''} ${r.modelsEndpoint?.error ?? ''}`),
        kv('流式对话', r.stream?.ok ? `OK（${r.stream.chunks} 片，usage=${r.stream.sawUsage}` + `，think ${r.stream.reasoningChars} 字）` : `失败：${r.stream?.status ?? ''} ${r.stream?.error ?? ''}`),
        r.tools ? kv('工具调用', (r.tools.toolCalls ?? []).length > 0
          ? `OK：${(r.tools.toolCalls ?? []).map((t) => `${t.name}(${t.arguments})`).join(' / ')}`
          : `未观察到（finish=${r.tools.finishReason ?? '-'}）`) : null,
        r.reasoningEffort ? kv('reasoning_effort', r.reasoningEffort.ok ? '上游接受' : `不支持：${r.reasoningEffort.status ?? ''}`) : null,
      ];
      const suggestions = r.suggestions ?? {};
      return card('探测结果', `模型 ${r.model}`, [
        ...lines,
        Object.keys(suggestions).length > 0
          ? el('div', { class: 'hint-box' }, [
            el('div', { text: '建议把下面这些能力标记改成（点上方「保存」生效）：' }),
            el('pre', { class: 'json', text: JSON.stringify(suggestions, null, 2) }),
          ])
          : el('div', { class: 'hint-box', text: '默认能力标记与该上游实测一致，无需调整。' }),
      ]);
    }

    function render() {
      clear(root);

      const editing = editingView();
      if (!editing) {
        const err = ctx.config?.editing?.error ?? ctx.status?.configError;
        root.append(el('div', { class: 'hint-box', text: `配置当前不合法，无法编辑：${err ?? '未知错误'}` }));
        return;
      }
      if (!draft) loadDraft();

      if (error) {
        root.append(el('div', { class: 'banner banner-err' }, [
          el('div', { text: `保存/探测失败${error.stage ? `［${error.stage}］` : ''}：${error.message}` }),
          error.hint ? el('div', { class: 'banner-hint', text: `提示：${error.hint}` }) : null,
        ]));
      }
      if (notice) root.append(el('div', { class: 'banner banner-ok', text: notice }));

      const tierCard = card('档位映射', 'Science 按用途发不同型号；这里决定每一档打到哪个模型', [
        ...draft.tierKeys.map((key) => field(
          draft.tierLabels[key] ?? key,
          selectInput(
            editing.models.map((m) => ({ value: m.publishAs, label: `${m.publishAs}（${m.displayName}）` })),
            draft.tiers[key],
            (v) => { draft.tiers[key] = v; },
          ),
          null,
        )),
        el('div', {
          class: 'hint-box',
          text: '当前四档都指向同一个模型（你的选择）。以后想让「辅助调用」用更便宜/更快的模型，'
            + '先在上面「模型映射」加一个模型，再把 haiku 那一档指过去即可。',
        }),
      ]);

      const upstreamCards = draft.upstreams.map((u, i) => renderUpstream(u, i));

      const upstreamCard = card('上游节点', `${draft.upstreams.length} 个上游；每个上游独立密钥与能力标记`, [
        el('div', { class: 'grid two' }, upstreamCards),
        el('div', { class: 'actions' }, [
          button('新增上游', () => {
            draft.upstreams.push({
              id: `upstream${draft.upstreams.length + 1}`,
              label: '新上游',
              baseURL: 'https://',
              apiKey: '<missing>',
              hasApiKey: false,
              apiKeyInput: '',
              apiMode: 'chat_completions',
              maxTokensField: 'max_tokens',
              sendStreamUsage: true,
              supportsTools: true,
              supportsReasoningEffort: false,
              supportsParallelTools: true,
              timeoutMs: 600_000,
              isLoopback: false,
            });
            render();
          }, { className: 'btn ghost' }),
        ]),
      ]);

      const modelCard = card('模型映射', 'Science 选择器看到的型号 → 上游真实模型名 + 归属上游', [
        el('div', { class: 'model-head' }, [
          el('span', { text: '发布型号（publishAs）' }),
          el('span', { text: '上游模型 id' }),
          el('span', { text: '显示名' }),
          el('span', { text: '归属上游' }),
          el('span', { text: '' }),
        ]),
        ...draft.models.map((m, i) => renderModel(m, i)),
        el('div', { class: 'actions' }, [
          button('新增模型', () => {
            draft.models.push({
              publishAs: `claude-opus-5-v${draft.models.length + 1}`,
              id: '',
              displayName: '新模型',
              upstream: draft.upstreams[0]?.id ?? 'default',
            });
            render();
          }, { className: 'btn ghost' }),
        ]),
        field('默认模型', selectInput(
          draft.models.map((m) => ({ value: m.id, label: `${m.id}（${m.publishAs}）` })),
          draft.defaultModel,
          (v) => { draft.defaultModel = v; },
        ), '档位与回退都指向它；即 tiers 里没有单独指定时的落点'),
      ]);

      const actions = card('保存', draft.configPath, [
        el('div', { class: 'actions' }, [
          button(saving ? '保存中…' : '保存配置', save, { className: 'btn primary', disabled: saving }),
          button('放弃修改', () => {
            probeResult = null;
            error = null;
            notice = null;
            loadDraft();
            render();
          }, { className: 'btn ghost' }),
        ]),
        el('div', {
          class: 'hint-box',
          text: '保存前会完整校验（端口互斥、publishAs 唯一、档位目标存在、密钥齐全、%VAR% 已展开）；'
            + '校验不通过则磁盘配置原样不动。运行中的链路需要点顶栏「重启」才会用上新配置。',
        }),
        renderProbe(),
      ]);

      append(root, [tierCard, upstreamCard, modelCard, actions]);
    }

    loadDraft();
    render();

    return {
      // 状态轮询不重建表单；只有保存/放弃修改/增删项时才 render()
      update() {
        if (!draft) render();
      },
    };
  },
};
