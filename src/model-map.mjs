/**
 * 模型身份映射（阶段 2：多上游 + 档位）。
 *
 * 三个方向：
 *  - 对外（`/v1/models`、`/api/models`）：发布 `publishAs`（Claude 形状的型号名），
 *    真实上游模型名与上游地址都不对外暴露。
 *  - 对内（`/v1/messages`）：把 Science 发来的型号还原为「真实上游模型 + 该用哪个上游」。
 *  - 档位（tiers）：Science 会按用途发不同型号（主对话 opus / 子代理 sonnet / 辅助 haiku）。
 *    型号精确命中不了时，先按型号里的家族词判断档位，再查 `tiers` 得到 publishAs；
 *    因此「四档都指向同一个模型」时行为等价于原来的「回退到默认模型」，而需要分流时只改配置。
 */

/** Claude 形状的型号名（Science/Claude Code 会发这些）。 */
const CLAUDE_SHAPED_RE = /^(?:anthropic\/)?claude[-.]/i;

/** 上下文标记后缀：`model[1m]` 表示 100 万上下文变体。 */
export function stripContextSuffix(model) {
  const m = /^(.*?)\[1m\]$/i.exec(String(model ?? ''));
  return m ? m[1] : String(model ?? '');
}

/** 按型号名里的家族词判断档位；非 Claude 形状返回 null（不该被分档）。 */
export function classifyTier(modelId) {
  const base = stripContextSuffix(String(modelId ?? '')).toLowerCase();
  if (!CLAUDE_SHAPED_RE.test(base)) return null;
  if (base.includes('opus')) return 'opus';
  if (base.includes('sonnet')) return 'sonnet';
  if (base.includes('haiku')) return 'haiku';
  return 'default';
}

/**
 * @param {object|Array} cfgOrModels 运行期配置（推荐）或旧的 models 数组（向后兼容）
 * @param {string} [defaultModel]
 * @param {string} [unknownModelPolicy]
 */
export function createModelMap(cfgOrModels, defaultModel, unknownModelPolicy = 'default') {
  const cfg = Array.isArray(cfgOrModels)
    ? { models: cfgOrModels, defaultModel, unknownModelPolicy, tiers: null, upstream: null }
    : (cfgOrModels ?? {});
  const models = cfg.models ?? [];
  if (models.length === 0) throw new Error('createModelMap：models 不能为空');

  const byPublished = new Map();
  const byUpstreamModel = new Map();
  for (const entry of models) {
    byPublished.set(entry.publishAs, entry);
    if (!byUpstreamModel.has(entry.id)) byUpstreamModel.set(entry.id, entry);
  }
  const defaultEntry = byUpstreamModel.get(cfg.defaultModel ?? defaultModel) ?? models[0];
  const policy = cfg.unknownModelPolicy ?? unknownModelPolicy;
  const tiers = cfg.tiers ?? null;

  function withUpstream(entry, matchedBy, tier = null) {
    return {
      entry,
      upstreamModel: entry.id,
      upstream: entry.upstream ?? cfg.upstream ?? null,
      upstreamId: entry.upstreamId ?? entry.upstream?.id ?? null,
      matchedBy,
      tier,
    };
  }

  function resolve(requestModel) {
    const raw = String(requestModel ?? '').trim();
    if (!raw) return withUpstream(defaultEntry, 'empty');

    const base = stripContextSuffix(raw);
    if (byPublished.has(base)) return withUpstream(byPublished.get(base), 'published');
    if (byUpstreamModel.has(base)) return withUpstream(byUpstreamModel.get(base), 'upstream-id');

    // 档位：例如 claude-haiku-4-5-20251001 → haiku → tiers.haiku 指向的发布型号
    const tier = classifyTier(base);
    if (tier && tiers?.[tier] && byPublished.has(tiers[tier])) {
      return withUpstream(byPublished.get(tiers[tier]), `tier:${tier}`, tier);
    }

    if (CLAUDE_SHAPED_RE.test(base) || policy === 'default') {
      return withUpstream(defaultEntry, 'fallback-default', tier);
    }
    const err = new Error(`未知模型：${base}`);
    err.code = 'unknown_model';
    throw err;
  }

  function publicIdFor(upstreamModel) {
    const entry = byUpstreamModel.get(String(upstreamModel ?? '').trim());
    return entry ? entry.publishAs : defaultEntry.publishAs;
  }

  return {
    models,
    defaultEntry,
    tiers,
    resolve,
    publicIdFor,
    isPublished: (model) => byPublished.has(stripContextSuffix(model)),
    /** 档位 → 发布型号（供 UI/诊断显示）。 */
    tierTable: () => (tiers ? { ...tiers } : null),
  };
}

/** `/v1/models` 的 Anthropic Models API 响应形状。 */
export function anthropicModelsPayload(models) {
  const data = models.map((entry) => ({
    type: 'model',
    id: entry.publishAs,
    display_name: entry.displayName,
    created_at: '1970-01-01T00:00:00Z',
  }));
  const payload = {
    data,
    has_more: false,
  };
  if (data.length > 0) {
    payload.first_id = data[0].id;
    payload.last_id = data[data.length - 1].id;
  }
  return payload;
}
