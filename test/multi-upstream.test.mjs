/**
 * 阶段 2 单测：多上游 + 档位映射 + 配置保存（先校验再落盘）。
 * 全部使用临时目录，不碰真实 config.json。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  parseConfig,
  applyConfigPatch,
  saveConfigPatch,
  configForEditing,
  normalizeUpstream,
  ConfigError,
} from '../src/config.mjs';
import { createModelMap, classifyTier } from '../src/model-map.mjs';

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-multi-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

const legacyConfig = {
  upstream: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-legacy-key-1234' },
  models: [{ id: 'real-a', publishAs: 'claude-opus-5', displayName: 'A' }],
  defaultModel: 'real-a',
};

const multiConfig = {
  upstreams: [
    { id: 'main', label: '主力', baseURL: 'https://api.main.com/v1', apiKey: 'sk-main-key-1234' },
    { id: 'fast', label: '快速', baseURL: 'https://api.fast.com/v1', apiKey: 'sk-fast-key-1234', supportsReasoningEffort: true },
  ],
  models: [
    { id: 'main/big', publishAs: 'claude-opus-5', displayName: '主力模型', upstream: 'main' },
    { id: 'fast/small', publishAs: 'claude-haiku-4-5-fast', displayName: '快速模型', upstream: 'fast' },
  ],
  tiers: { opus: 'claude-opus-5', sonnet: 'claude-opus-5', haiku: 'claude-haiku-4-5-fast', default: 'claude-opus-5' },
  defaultModel: 'main/big',
};

// MARK: - 配置解析

test('旧写法（单 upstream）解析为 upstreams[0]，并保留兼容别名', () => {
  const cfg = loadConfig(tmpConfig(legacyConfig));
  assert.equal(cfg.upstreams.length, 1);
  assert.equal(cfg.upstreams[0].id, 'default');
  assert.equal(cfg.upstream.id, 'default');
  assert.equal(cfg.upstream.baseURL, 'https://api.example.com/v1');
  assert.equal(cfg.models[0].upstreamId, 'default');
});

test('两种写法同时出现直接报错（避免歧义）', () => {
  assert.throws(
    () => parseConfig({ ...legacyConfig, upstreams: multiConfig.upstreams }),
    /不能同时写 upstream 与 upstreams/,
  );
});

test('多上游解析：每个上游独立密钥与能力，模型按 upstream 归属', () => {
  const cfg = loadConfig(tmpConfig(multiConfig));
  assert.equal(cfg.upstreams.length, 2);
  assert.equal(cfg.upstreamById.get('fast').supportsReasoningEffort, true);
  assert.equal(cfg.upstreamById.get('main').supportsReasoningEffort, false);
  assert.equal(cfg.models[1].upstream.id, 'fast');
  assert.equal(cfg.models[1].upstream.apiKey, 'sk-fast-key-1234');
});

test('upstreams 里 id 重复报错', () => {
  const file = tmpConfig({
    ...multiConfig,
    upstreams: [multiConfig.upstreams[0], { ...multiConfig.upstreams[1], id: 'main' }],
  });
  assert.throws(() => loadConfig(file), /id 重复/);
});

test('models[].upstream 指向不存在的上游时报错', () => {
  const file = tmpConfig({
    ...multiConfig,
    models: [{ id: 'x', publishAs: 'claude-opus-5', upstream: 'nope' }],
  });
  assert.throws(() => loadConfig(file), /不在 upstreams 里/);
});

test('档位缺省时四档都指向默认模型（「都指向同一个模型」）', () => {
  const cfg = loadConfig(tmpConfig(legacyConfig));
  assert.deepEqual(cfg.tiers, {
    opus: 'claude-opus-5',
    sonnet: 'claude-opus-5',
    haiku: 'claude-opus-5',
    default: 'claude-opus-5',
  });
});

test('档位里的未知键与不存在的目标都报错', () => {
  assert.throws(
    () => parseConfig({ ...legacyConfig, tiers: { huge: 'claude-opus-5' } }),
    /未知档位/,
  );
  assert.throws(
    () => parseConfig({ ...legacyConfig, tiers: { haiku: 'claude-nope' } }),
    /不是任何 models\[\]\.publishAs/,
  );
});

test('configForEditing 只暴露打码后的密钥', () => {
  const cfg = loadConfig(tmpConfig(multiConfig));
  const view = configForEditing(cfg);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('sk-main-key-1234'));
  assert.equal(view.upstreams[0].apiKey, `<set:${'sk-main-key-1234'.length}>`);
  assert.equal(view.upstreams[0].hasApiKey, true);
  assert.deepEqual(view.tierKeys, ['opus', 'sonnet', 'haiku', 'default']);
  assert.equal(view.tiers.haiku, 'claude-haiku-4-5-fast');
});

// MARK: - 合并与保存

test('applyConfigPatch：省略 apiKey 表示保持原密钥', () => {
  const merged = applyConfigPatch(multiConfig, {
    upstreams: [{ id: 'main', label: '主力改', baseURL: 'https://api.main.com/v2' }],
  });
  assert.equal(merged.upstreams.length, 1);
  assert.equal(merged.upstreams[0].apiKey, 'sk-main-key-1234');
  assert.equal(merged.upstreams[0].label, '主力改');
  assert.equal(merged.upstream, undefined, '应统一到 upstreams 新写法');
});

test('applyConfigPatch：新上游没给密钥则报错', () => {
  assert.throws(
    () => applyConfigPatch(multiConfig, { upstreams: [{ id: 'brand-new', baseURL: 'https://x.invalid/v1' }] }),
    /缺少 apiKey/,
  );
});

test('applyConfigPatch：旧写法改密钥时不会串到别的上游', () => {
  const merged = applyConfigPatch(legacyConfig, {
    upstreams: [{ id: 'default', baseURL: 'https://api.example.com/v1', apiKey: 'sk-new-key-9999' }],
  });
  assert.equal(merged.upstreams[0].apiKey, 'sk-new-key-9999');
});

test('saveConfigPatch：先校验再落盘，非法补丁不写盘', () => {
  const file = tmpConfig(multiConfig);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => saveConfigPatch(file, { tiers: { haiku: 'claude-not-exist' } }),
    ConfigError,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, '校验失败时磁盘内容必须不变');

  const result = saveConfigPatch(file, { tiers: { haiku: 'claude-opus-5' } });
  assert.equal(result.cfg.tiers.haiku, 'claude-opus-5');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tiers.haiku, 'claude-opus-5');
  assert.equal(onDisk.upstreams[1].apiKey, 'sk-fast-key-1234', '未提交的字段必须原样保留');
  assert.equal(loadConfig(file).tiers.opus, 'claude-opus-5');
});

test('saveConfigPatch：只改档位时保留旧写法的 upstream（不动用户没改的部分）', () => {
  const file = tmpConfig(legacyConfig);
  const result = saveConfigPatch(file, { tiers: { opus: 'claude-opus-5' } });
  assert.equal(result.cfg.tiers.opus, 'claude-opus-5');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.upstream.apiKey, 'sk-legacy-key-1234');
  assert.equal(onDisk.upstreams, undefined);
  assert.equal(loadConfig(file).tiers.opus, 'claude-opus-5');
});

test('saveConfigPatch：界面提交 upstreams 后旧写法升级为新写法且密钥不丢', () => {
  const file = tmpConfig(legacyConfig);
  const result = saveConfigPatch(file, {
    upstreams: [{
      id: 'default',
      label: '主上游',
      baseURL: 'https://api.example.com/v1',
      maxTokensField: 'max_tokens',
      sendStreamUsage: true,
      supportsTools: true,
      supportsReasoningEffort: false,
    }],
  });
  assert.equal(result.config.upstream, undefined);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.upstreams[0].apiKey, 'sk-legacy-key-1234');
  assert.equal(loadConfig(file).upstream.apiKey, 'sk-legacy-key-1234');
});

// MARK: - 档位路由

test('classifyTier 按型号家族词分档（含 [1m] 后缀与大小写）', () => {
  assert.equal(classifyTier('claude-opus-5'), 'opus');
  assert.equal(classifyTier('claude-sonnet-5[1m]'), 'sonnet');
  assert.equal(classifyTier('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(classifyTier('claude-3-5'), 'default');
  assert.equal(classifyTier('gpt-4o'), null);
});

test('档位命中时按 tiers 路由到对应模型与上游', () => {
  const cfg = loadConfig(tmpConfig(multiConfig));
  const map = createModelMap(cfg);

  const opus = map.resolve('claude-opus-5');
  assert.equal(opus.matchedBy, 'published');
  assert.equal(opus.upstream.id, 'main');

  const haiku = map.resolve('claude-haiku-4-5-20251001');
  assert.equal(haiku.matchedBy, 'tier:haiku');
  assert.equal(haiku.tier, 'haiku');
  assert.equal(haiku.upstreamModel, 'fast/small');
  assert.equal(haiku.upstream.id, 'fast', '辅助调用应打到 fast 上游，而不是主力');
  assert.equal(haiku.entry.publishAs, 'claude-haiku-4-5-fast');
});

test('四档都指向同一模型时，未知 Claude 型号仍回退到默认模型（行为与阶段 1 一致）', () => {
  const cfg = loadConfig(tmpConfig(legacyConfig));
  const map = createModelMap(cfg);
  const resolved = map.resolve('claude-haiku-4-5-20251001');
  assert.equal(resolved.matchedBy, 'tier:haiku');
  assert.equal(resolved.upstreamModel, 'real-a');
  assert.equal(resolved.entry.publishAs, 'claude-opus-5');
});

test('unknownModelPolicy=reject 时非 Claude 型号仍被拒绝', () => {
  const cfg = loadConfig(tmpConfig({ ...legacyConfig, unknownModelPolicy: 'reject' }));
  const map = createModelMap(cfg);
  assert.throws(() => map.resolve('gpt-4o'), /未知模型/);
  // Claude 形状仍然回退（档位/默认），这是 Science 辅助调用的正常路径
  assert.equal(map.resolve('claude-opus-4-8').matchedBy, 'tier:opus');
});

test('createModelMap 仍兼容旧的数组签名', () => {
  const map = createModelMap([{ id: 'a', publishAs: 'claude-opus-5' }], 'a', 'reject');
  assert.equal(map.resolve('claude-opus-5').upstreamModel, 'a');
  assert.equal(map.resolve('claude-opus-5').upstream, null);
});

test('normalizeUpstream 校验 id 与 baseURL', () => {
  assert.throws(() => normalizeUpstream({ id: 'bad id!', baseURL: 'https://x.invalid', apiKey: 'k' }, 0), /id 非法/);
  const ok = normalizeUpstream({ id: 'ok', baseURL: 'https://x.invalid/v1/chat/completions', apiKey: 'k' }, 0);
  assert.equal(ok.baseURL, 'https://x.invalid/v1');
  assert.equal(ok.isLoopback, false);
});
