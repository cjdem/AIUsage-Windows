/**
 * 配置加载与校验（阶段 2：多上游 + 档位映射）。
 *
 * - 默认读取本目录上一级的 config.json（可用 --config 或 SCIENCE_PROXY_CONFIG 覆盖）。
 * - 支持 %VAR% 形式的环境变量展开（Windows 习惯写法）。
 * - 校验失败直接抛错退出，绝不带着半截配置启动；保存路径同样「先校验、再落盘」。
 * - apiKey 只存在于内存中，绝不写日志、绝不回显（只暴露 <set:长度> 之类摘要）。
 *
 * 上游写法（两种，都支持）：
 *   A) 旧写法（单上游）：{ "upstream": { "baseURL": …, "apiKey": … } }
 *   B) 新写法（多上游）：{ "upstreams": [ { "id": "cline", "label": "Cline Pass", … } ] }
 *   两种同时出现会直接报错（避免歧义）。
 *
 * 档位（tiers）：Science 会按用途发不同型号（主对话 opus / 子代理 sonnet / 辅助 haiku / 其它）。
 *   `tiers` 把「档位」映射到某个 models[].publishAs；默认四档全部指向默认模型
 *   （即「都指向同一个模型」），需要分流时改这一处即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = path.resolve(HERE, '..');

export const TIER_KEYS = ['opus', 'sonnet', 'haiku', 'default'];
export const TIER_LABELS = {
  opus: '主对话（opus）',
  sonnet: '子代理（sonnet）',
  haiku: '辅助调用（haiku）',
  default: '其它/未知型号',
};

const UPSTREAM_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;

export function expandEnv(input) {
  if (typeof input !== 'string') return input;
  return input.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
    const v = process.env[name];
    if (v == null) {
      // 未定义时保留原文，便于报错时人工看出是哪个变量
      return m;
    }
    return v;
  });
}

function deepExpand(value) {
  if (typeof value === 'string') return expandEnv(value);
  if (Array.isArray(value)) return value.map(deepExpand);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepExpand(v);
    return out;
  }
  return value;
}

export function resolveConfigPath(explicit) {
  const candidate = explicit || process.env.SCIENCE_PROXY_CONFIG || path.join(TOOL_ROOT, 'config.json');
  return path.resolve(expandEnv(candidate));
}

export class ConfigError extends Error {}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`缺少必填项：${label}`);
  }
  return value.trim();
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** 校验上游 baseURL 并归一化为“不含结尾斜杠、不含 /chat/completions 后缀”的形式。 */
export function normalizeUpstreamBaseURL(raw) {
  const trimmed = requireString(raw, 'upstream.baseURL');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`upstream.baseURL 不是合法 URL：${trimmed.replace(/\/\/.*@/, '//<redacted>@')}`);
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/completions', '/models']) {
    if (pathname.toLowerCase().endsWith(suffix)) pathname = pathname.slice(0, -suffix.length);
  }
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** 归一化单个上游对象（旧写法与数组写法共用）。 */
export function normalizeUpstream(raw, index, fallbackId = null) {
  const label = `upstreams[${index}]`;
  const id = String(raw?.id ?? fallbackId ?? '').trim() || `upstream${index + 1}`;
  if (!UPSTREAM_ID_RE.test(id)) {
    throw new ConfigError(`${label}.id 非法（只能是字母数字与 _ . -）：${id}`);
  }
  const baseURL = normalizeUpstreamBaseURL(raw?.baseURL);
  const apiKey = requireString(raw?.apiKey, `${label}.apiKey`);
  const apiMode = raw?.apiMode ?? 'chat_completions';
  if (apiMode !== 'chat_completions') {
    throw new ConfigError(`暂只支持 upstream.apiMode = "chat_completions"（当前：${id} → ${apiMode}）`);
  }
  const maxTokensField = raw?.maxTokensField ?? 'max_tokens';
  if (!['max_tokens', 'max_completion_tokens'].includes(maxTokensField)) {
    throw new ConfigError(`${label}.maxTokensField 只能是 max_tokens 或 max_completion_tokens`);
  }
  return {
    id,
    label: String(raw?.label ?? id),
    baseURL,
    apiKey,
    apiMode,
    maxTokensField,
    // 上游只走流式（实测网关非流式会静默返回空内容）；客户端要非流式时由本地聚合。
    sendStreamUsage: raw?.sendStreamUsage !== false,
    supportsTools: raw?.supportsTools !== false,
    supportsReasoningEffort: raw?.supportsReasoningEffort === true,
    supportsParallelTools: raw?.supportsParallelTools !== false,
    extraHeaders: raw?.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
    timeoutMs: Number(raw?.timeoutMs ?? 600_000),
    isLoopback: isLoopbackHost(new URL(baseURL).hostname),
  };
}

// MARK: - 解析

/**
 * 把原始 JSON 解析成运行期配置（不做文件 IO，便于单测与「保存前校验」复用）。
 * @param {object} raw 原始配置对象
 * @param {{configPath?: string}} [meta]
 */
export function parseConfig(raw, { configPath = null } = {}) {
  const cfg = deepExpand(raw);
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('配置根节点必须是对象');

  // ---- 上游 ----
  const hasPlural = Array.isArray(cfg.upstreams);
  const hasSingular = cfg.upstream && typeof cfg.upstream === 'object';
  if (hasPlural && hasSingular) {
    throw new ConfigError('不能同时写 upstream 与 upstreams：请二选一（upstreams 是新写法）');
  }
  let upstreams;
  if (hasPlural) {
    if (cfg.upstreams.length === 0) throw new ConfigError('upstreams 不能为空');
    upstreams = cfg.upstreams.map((item, index) => normalizeUpstream(item, index));
  } else if (hasSingular) {
    upstreams = [normalizeUpstream(cfg.upstream, 0, 'default')];
  } else {
    throw new ConfigError('缺少 upstream（单上游）或 upstreams（多上游）');
  }
  const duplicateUpstream = upstreams
    .map((u) => u.id)
    .find((id, index, list) => list.indexOf(id) !== index);
  if (duplicateUpstream) throw new ConfigError(`upstreams 里 id 重复：${duplicateUpstream}`);
  const upstreamById = new Map(upstreams.map((u) => [u.id, u]));
  const primaryUpstream = upstreams[0];

  // ---- 模型 ----
  const rawModels = Array.isArray(cfg.models) ? cfg.models : [];
  if (rawModels.length === 0) throw new ConfigError('models 不能为空');
  const models = rawModels.map((entry, index) => {
    const item = typeof entry === 'string' ? { id: entry } : entry;
    const id = requireString(item.id, `models[${index}].id`);
    const publishAs = typeof item.publishAs === 'string' && item.publishAs.trim() !== ''
      ? item.publishAs.trim()
      : id;
    if (publishAs.includes(' ')) {
      throw new ConfigError(`models[${index}].publishAs 不能含空格：${publishAs}`);
    }
    const upstreamId = String(item.upstream ?? primaryUpstream.id).trim();
    if (!upstreamById.has(upstreamId)) {
      throw new ConfigError(
        `models[${index}].upstream "${upstreamId}" 不在 upstreams 里（可用：${[...upstreamById.keys()].join(', ')}）`,
      );
    }
    return {
      id,
      publishAs,
      displayName: typeof item.displayName === 'string' && item.displayName.trim() !== ''
        ? item.displayName.trim()
        : id,
      upstreamId,
      upstream: upstreamById.get(upstreamId),
    };
  });

  const publishedIds = new Set(models.map((m) => m.publishAs));
  const upstreamModelIds = new Set(models.map((m) => m.id));
  if (publishedIds.size !== models.length) {
    throw new ConfigError('models 中 publishAs 重复，Science 选择器会出现同名条目');
  }

  const defaultModel = requireString(cfg.defaultModel ?? models[0].id, 'defaultModel');
  if (!upstreamModelIds.has(defaultModel)) {
    throw new ConfigError(`defaultModel "${defaultModel}" 不在 models 列表里`);
  }
  const defaultEntry = models.find((m) => m.id === defaultModel);

  // ---- 档位 ----
  const rawTiers = cfg.tiers && typeof cfg.tiers === 'object' ? cfg.tiers : {};
  for (const key of Object.keys(rawTiers)) {
    if (!TIER_KEYS.includes(key)) {
      throw new ConfigError(`tiers 里出现未知档位 "${key}"（只能是 ${TIER_KEYS.join(' / ')}）`);
    }
  }
  const tiers = {};
  for (const key of TIER_KEYS) {
    const target = rawTiers[key] === undefined ? defaultEntry.publishAs : String(rawTiers[key]).trim();
    if (!publishedIds.has(target)) {
      throw new ConfigError(`tiers.${key} = "${target}" 不是任何 models[].publishAs（可用：${[...publishedIds].join(', ')}）`);
    }
    tiers[key] = target;
  }

  const unknownModelPolicy = cfg.unknownModelPolicy ?? 'default';
  if (!['default', 'reject'].includes(unknownModelPolicy)) {
    throw new ConfigError(`unknownModelPolicy 只能是 "default" 或 "reject"（当前：${unknownModelPolicy}）`);
  }

  // ---- 端口 ----
  const ports = {
    inference: Number(cfg.ports?.inference ?? 14402),
    publicEntry: Number(cfg.ports?.publicEntry ?? 8000),
    daemon: Number(cfg.ports?.daemon ?? 8010),
    sandbox: Number(cfg.ports?.sandbox ?? 8001),
  };
  for (const [name, value] of Object.entries(ports)) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ConfigError(`ports.${name} 非法：${cfg.ports?.[name]}`);
    }
  }
  // 四个端口必须两两互不相同：任何两个相同都会让某条链路抢不到端口而半死
  const portValues = [ports.inference, ports.publicEntry, ports.daemon, ports.sandbox];
  if (new Set(portValues).size !== portValues.length) {
    throw new ConfigError(
      `ports 里的 inference(${ports.inference}) / publicEntry(${ports.publicEntry}) /`
      + ` daemon(${ports.daemon}) / sandbox(${ports.sandbox}) 必须两两互不相同`,
    );
  }

  const science = {
    dataDir: expandEnv(cfg.science?.dataDir ?? '%USERPROFILE%\\.claude-science'),
    binaryPath: expandEnv(
      cfg.science?.binaryPath
        ?? '%LOCALAPPDATA%\\Programs\\ClaudeScience\\claude-science.exe',
    ),
    configTomlPath: expandEnv(cfg.science?.configTomlPath ?? ''),
    writeExtraAllowedOrigins: cfg.science?.writeExtraAllowedOrigins !== false,
    noAutoUpdate: cfg.science?.noAutoUpdate !== false,
  };
  if (!science.configTomlPath) {
    science.configTomlPath = path.join(science.dataDir, 'config.toml');
  }

  const logging = {
    level: cfg.logging?.level ?? 'info',
    dir: expandEnv(cfg.logging?.dir ?? '%LOCALAPPDATA%\\ClaudeScience\\aiusage-proxy\\logs'),
  };

  // 未展开的 %VAR%（例如 %UPSTREAM_KEY% 但环境变量没设）会导致「能启动但每个请求都失败」，
  // 这里直接拒绝，避免把问题拖到运行期误判为密钥失效。
  const leftover = [];
  const scanForPlaceholders = (value, where) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) leftover.push(`${where}: ${m[0]}`);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => scanForPlaceholders(v, `${where}[${i}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) scanForPlaceholders(v, `${where}.${k}`);
    }
  };
  scanForPlaceholders(cfg, 'config');
  if (leftover.length > 0) {
    throw new ConfigError(
      `配置里存在未展开的环境变量占位符（请先设置对应环境变量）：\n  ${leftover.join('\n  ')}`,
    );
  }

  return {
    configPath,
    upstreams,
    upstreamById,
    /** 兼容别名：旧代码/探测默认用主上游（upstreams[0]）。 */
    upstream: primaryUpstream,
    models,
    defaultModel,
    tiers,
    unknownModelPolicy,
    ports,
    science,
    logging,
    /** 原始（已展开）对象，保存时作为合并基底。 */
    raw: cfg,
  };
}

export function loadConfig(explicitPath) {
  const configPath = resolveConfigPath(explicitPath);
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`找不到配置文件：${configPath}（可从 config.example.json 复制）`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`配置文件不是合法 JSON：${err.message}`);
  }
  return parseConfig(raw, { configPath });
}

// MARK: - 保存（先校验，再原子落盘）

/**
 * 把界面提交的补丁合并进原始配置对象（纯函数）。
 *
 * 支持字段：upstreams / tiers / models / defaultModel / unknownModelPolicy / ports / science / logging。
 * upstreams 是整表替换，但**apiKey 可省略表示「保持不变」**（界面永不回显真实密钥）。
 */
export function applyConfigPatch(raw, patch = {}) {
  const next = JSON.parse(JSON.stringify(raw ?? {}));
  const existingKeys = new Map();
  const existingList = Array.isArray(next.upstreams)
    ? next.upstreams
    : (next.upstream ? [next.upstream] : []);
  for (const item of existingList) {
    if (item?.id) existingKeys.set(String(item.id), item);
  }
  const legacyKey = next.upstream?.apiKey ?? null; // 仅旧写法才有「无 id 的主上游」

  if (Array.isArray(patch.upstreams)) {
    if (patch.upstreams.length === 0) throw new ConfigError('upstreams 不能为空');
    next.upstreams = patch.upstreams.map((item, index) => {
      const id = String(item?.id ?? '').trim() || `upstream${index + 1}`;
      const merged = { ...item, id };
      if (merged.apiKey === undefined || merged.apiKey === null || merged.apiKey === '') {
        // 保持原密钥：按 id 找回；单上游旧写法时回退到它的 apiKey
        const kept = existingKeys.get(id)?.apiKey ?? existingKeys.get('default')?.apiKey ?? legacyKey;
        if (!kept) {
          throw new ConfigError(`上游 "${id}" 缺少 apiKey（新上游必须提供密钥）`);
        }
        merged.apiKey = kept;
      }
      return merged;
    });
    delete next.upstream; // 统一到新写法
  }

  if (patch.tiers && typeof patch.tiers === 'object') {
    next.tiers = { ...(next.tiers ?? {}) };
    for (const key of Object.keys(patch.tiers)) {
      if (!TIER_KEYS.includes(key)) throw new ConfigError(`未知档位：${key}`);
      next.tiers[key] = patch.tiers[key];
    }
  }

  for (const key of ['models', 'defaultModel', 'unknownModelPolicy', 'ports']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.science && typeof patch.science === 'object') {
    next.science = { ...(next.science ?? {}), ...patch.science };
  }
  if (patch.logging && typeof patch.logging === 'object') {
    next.logging = { ...(next.logging ?? {}), ...patch.logging };
  }
  return next;
}

function atomicWriteJson(target, value) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 保存配置补丁：合并 → 校验 → 原子写入。
 * 校验不通过直接抛 ConfigError，磁盘上的原配置保持不变。
 * @returns {{path:string, config:object, cfg:object}} cfg 为校验后的运行期配置
 */
export function saveConfigPatch(explicitPath, patch) {
  const configPath = resolveConfigPath(explicitPath);
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`找不到配置文件：${configPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`配置文件不是合法 JSON：${err.message}`);
  }
  const merged = applyConfigPatch(raw, patch);
  const cfg = parseConfig(merged, { configPath }); // 校验失败在这里抛错，不落盘
  atomicWriteJson(configPath, merged);
  return { path: configPath, config: merged, cfg };
}

// MARK: - 展示用视图（绝不回显密钥）

/** 供日志使用的安全摘要（不含密钥）。 */
export function describeConfig(cfg) {
  return {
    configPath: cfg.configPath,
    upstreams: cfg.upstreams.map((u) => ({
      id: u.id,
      baseURL: u.baseURL.replace(/^(https?:\/\/[^/]*).*$/, '$1'),
      apiKey: u.apiKey ? '<set>' : '<missing>',
      supportsTools: u.supportsTools,
      supportsReasoningEffort: u.supportsReasoningEffort,
    })),
    models: cfg.models.map((m) => `${m.publishAs} -> ${m.id} @${m.upstreamId}`),
    tiers: cfg.tiers,
    defaultModel: cfg.defaultModel,
    ports: cfg.ports,
    science: {
      dataDir: cfg.science.dataDir,
      binaryPath: cfg.science.binaryPath,
    },
  };
}

/** 供界面编辑用的归一化视图：密钥只显示为 <set:长度>。 */
export function configForEditing(cfg) {
  return {
    configPath: cfg.configPath,
    upstreams: cfg.upstreams.map((u) => ({
      id: u.id,
      label: u.label,
      baseURL: u.baseURL,
      apiKey: u.apiKey ? `<set:${u.apiKey.length}>` : '<missing>',
      hasApiKey: !!u.apiKey,
      apiMode: u.apiMode,
      maxTokensField: u.maxTokensField,
      sendStreamUsage: u.sendStreamUsage,
      supportsTools: u.supportsTools,
      supportsReasoningEffort: u.supportsReasoningEffort,
      supportsParallelTools: u.supportsParallelTools,
      timeoutMs: u.timeoutMs,
      extraHeaders: u.extraHeaders,
      isLoopback: u.isLoopback,
    })),
    models: cfg.models.map((m) => ({
      id: m.id,
      publishAs: m.publishAs,
      displayName: m.displayName,
      upstream: m.upstreamId,
    })),
    tiers: cfg.tiers,
    tierKeys: TIER_KEYS,
    tierLabels: TIER_LABELS,
    defaultModel: cfg.defaultModel,
    unknownModelPolicy: cfg.unknownModelPolicy,
    ports: cfg.ports,
    science: {
      dataDir: cfg.science.dataDir,
      binaryPath: cfg.science.binaryPath,
      noAutoUpdate: cfg.science.noAutoUpdate,
      writeExtraAllowedOrigins: cfg.science.writeExtraAllowedOrigins,
    },
    logging: cfg.logging,
  };
}
