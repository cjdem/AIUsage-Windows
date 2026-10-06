/**
 * 仪表盘（阶段 1 主视图）：链路健康、一键启停、当前模型/上游、登录态、启动阶段进度、最近事件。
 */
import { el, clear, append, card, kv, badge, empty, fmtClock, fmtDuration } from '../dom.mjs';
import { logLine } from './logs.mjs';

const STAGE_ORDER = [
  'validate', 'backup', 'login', 'cleanup', 'inference',
  'daemon-start', 'daemon-health', 'session', 'probe', 'done',
];

function dot(listening) {
  return el('span', { class: `dot ${listening ? 'on' : 'off'}` });
}

function endpointRow(label, endpoint) {
  const listening = endpoint?.listening;
  return el('div', { class: 'port-row' }, [
    dot(listening),
    el('span', { text: label }),
    el('span', { class: 'mono muted', text: endpoint ? `127.0.0.1:${endpoint.port}` : '—' }),
    badge(
      listening ? '监听中' : (endpoint?.status === '由 daemon 管理' ? '由 daemon 管理' : '未监听'),
      listening ? 'ok' : 'idle',
    ),
    endpoint?.status !== undefined && endpoint?.status !== true
      ? el('span', { class: 'muted small', text: `HTTP ${endpoint.status}` })
      : null,
  ]);
}

export default {
  id: 'dashboard',
  label: '状态与启停',
  icon: '◉',

  mount(root, ctx) {
    const logBox = el('div', { class: 'log-console' });

    const unsubscribeLog = ctx.onLog(() => {
      renderLogTail();
    });

    function renderLogTail() {
      clear(logBox);
      const tail = ctx.logs().slice(-40);
      if (tail.length === 0) logBox.append(empty('暂无日志（启动链路后这里会实时滚动）'));
      for (const entry of tail) logBox.append(logLine(entry));
      logBox.scrollTop = logBox.scrollHeight;
    }

    function render() {
      const status = ctx.status;
      const stages = ctx.config?.stages ?? {};
      clear(root);

      if (!status) {
        root.append(el('div', { class: 'hint-box', text: '正在读取链路状态…' }));
        return;
      }

      if (status.configError) {
        root.append(el('div', { class: 'hint-box', text: `配置有问题，链路无法启动：${status.configError}` }));
      }

      // ---- 链路健康 ----
      const health = card('链路健康', `阶段：${status.phase}`, [
        endpointRow('推理代理', status.endpoints?.inference),
        endpointRow('Claude Science daemon', status.endpoints?.daemon),
        endpointRow('公开入口（浏览器打开）', status.endpoints?.publicEntry),
        endpointRow('沙箱内容服务', status.endpoints?.sandbox),
        el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: '运行时长' }),
          el('span', { class: 'kv-v', text: status.startedAt ? fmtDuration(status.startedAt) : '—' }),
        ]),
        el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: '进程' }),
          el('span', {
            class: 'kv-v mono',
            text: `控制台 pid ${status.hostPid}${status.daemonPid ? ` · daemon 启动器 pid ${status.daemonPid}` : ''}`,
          }),
        ]),
        el('div', {
          class: 'hint-box',
          text: '两个代理运行在本控制台进程内（不会留孤儿进程）：关闭窗口会收进托盘继续运行，'
            + '托盘菜单「退出」才会停止链路并退出。',
        }),
      ], el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn ghost',
          type: 'button',
          text: '打开浏览器界面',
          disabled: !status.entryUrl,
          onclick: () => ctx.api.openEntry(),
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: '打开桌面 app',
          disabled: !status.science?.binaryExists,
          onclick: async () => {
            const res = await ctx.api.openDesktopApp();
            if (!res.ok) ctx.setBanner('err', `打开桌面 app 失败：${res.error.message}`);
          },
        }),
      ]));

      // ---- 启动阶段进度 ----
      const currentStage = status.stage;
      const stageIndex = STAGE_ORDER.indexOf(currentStage);
      const progress = card('启动阶段', status.phase === 'starting' ? `正在执行：${status.stageLabel ?? currentStage}` : '仅在启动过程中显示进度', [
        el('div', { class: 'stages' }, STAGE_ORDER.map((stage, index) => el('span', {
          class: [
            'stage-chip',
            status.phase === 'running' || (stageIndex >= 0 && index < stageIndex) ? 'done' : '',
            stage === currentStage && status.phase !== 'running' ? 'current' : '',
          ].filter(Boolean).join(' '),
          text: stages[stage] ?? stage,
        }))),
      ]);

      // ---- 当前模型与上游 ----
      const models = card('模型与上游', 'Science 选择器看到的模型 → 实际请求的上游模型', [
        ...(status.models ?? []).map((model) => el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: model.publishAs }),
          el('span', { class: 'kv-v mono', text: `→ ${model.id}` }),
        ])),
        (status.models ?? []).length === 0 ? empty('未配置模型') : null,
        kv('显示名', (status.models ?? []).map((m) => m.displayName).join(' / ')),
        kv('默认模型', status.defaultModel, { mono: true }),
        kv('未知模型策略', status.unknownModelPolicy === 'reject' ? '拒绝（404）' : '回退到默认模型'),
        kv('上游地址', status.upstream?.baseURL, { mono: true }),
        kv('上游密钥', status.upstream?.apiKey === '<set>' ? '已设置（不回显）' : '未设置', {
          tone: status.upstream?.apiKey === '<set>' ? 'ok' : 'err',
        }),
        el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: '上游能力' }),
          el('span', { class: 'kv-v' }, [
            badge(`工具 ${status.upstream?.supportsTools ? '支持' : '不支持'}`, status.upstream?.supportsTools ? 'ok' : 'warn'),
            ' ',
            badge(`推理强度 ${status.upstream?.supportsReasoningEffort ? '支持' : '不支持'}`, status.upstream?.supportsReasoningEffort ? 'ok' : 'idle'),
            ' ',
            badge(`流式用量 ${status.upstream?.sendStreamUsage ? '开' : '关'}`, status.upstream?.sendStreamUsage ? 'ok' : 'warn'),
          ]),
        ]),
        el('div', { class: 'hint-box', text: '上游一律以流式请求；客户端要非流式时由本地聚合返回。模型映射的编辑在「节点与模型映射」（阶段 2）。' }),
      ]);

      // ---- 登录态 ----
      const login = status.login ?? {};
      const virtualTokens = (login.tokens ?? []).filter((t) => t.virtual);
      const loginCard = card('登录态', '虚拟凭证让 Science 认为已登录；真实登录会被保留', [
        el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: '状态' }),
          el('span', { class: 'kv-v' }, [
            login.hasRealLogin
              ? badge('真实 Claude 登录', 'info')
              : (virtualTokens.length > 0 ? badge('虚拟登录（本工具写入）', 'ok') : badge('无凭证', 'warn')),
          ]),
        ]),
        kv('密钥文件', login.keyAvailable ? 'encryption.key 可用' : `不可用：${login.keyError ?? '未知'}`, {
          tone: login.keyAvailable ? 'ok' : 'err',
        }),
        kv('令牌文件', (login.files ?? []).join(', '), { mono: true }),
        ...(login.tokens ?? []).map((token) => kv(
          `账号 ${token.userId}`,
          `${token.email ?? '—'}${token.virtual ? '（虚拟）' : ''}`,
        )),
        kv('数据目录', status.science?.dataDir, { mono: true }),
      ]);

      // ---- 最近事件 ----
      const ops = status.recentOps ?? [];
      const events = card('最近事件', '本次会话里的警告与错误', ops.length === 0
        ? [empty('没有警告或错误')]
        : ops.slice().reverse().map((op) => el('div', { class: 'kv' }, [
          el('span', { class: 'kv-k', text: fmtClock(op.ts) }),
          el('span', {
            class: `kv-v ${op.type === 'error' ? 'tone-err' : 'tone-warn'}`,
            text: op.message,
          }),
        ])));

      const logCard = card('日志尾部', '最近 40 行（完整视图见「实时日志」）', [logBox], el('button', {
        class: 'btn ghost',
        type: 'button',
        text: '查看全部',
        onclick: () => ctx.navigate('logs'),
      }));

      append(root, [
        el('div', { class: 'grid two' }, [health, models]),
        status.phase === 'starting' || status.phase === 'error' ? progress : null,
        el('div', { class: 'grid two' }, [loginCard, events]),
        logCard,
        card('路径', '配置文件与运行产物位置', [
          kv('配置文件', status.configPath, { mono: true }),
          kv('Science 可执行文件', `${status.science?.binaryPath ?? '—'}${status.science?.binaryExists ? '' : '（不存在）'}`, {
            mono: true,
            tone: status.science?.binaryExists ? null : 'err',
          }),
          kv('日志目录', status.logging?.dir, { mono: true }),
          kv('日志级别', status.logging?.level),
        ]),
      ]);

      renderLogTail();
    }

    render();

    return {
      update: render,
      unmount: () => unsubscribeLog?.(),
    };
  },
};
