import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, normalizeUpstreamBaseURL, ConfigError, describeConfig } from '../src/config.mjs';

function writeConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

const baseConfig = {
  upstream: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test-key-value-1234' },
  models: [{ id: 'real-model-a', publishAs: 'claude-opus-5', displayName: 'A' }],
  defaultModel: 'real-model-a',
};

test('normalizeUpstreamBaseURL 去掉 /chat/completions 与结尾斜杠', () => {
  assert.equal(normalizeUpstreamBaseURL('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1');
  assert.equal(normalizeUpstreamBaseURL('https://api.x.com/v1/'), 'https://api.x.com/v1');
  assert.equal(normalizeUpstreamBaseURL('https://api.x.com'), 'https://api.x.com');
});

test('loadConfig 读取合法配置并展开 %VAR%', () => {
  process.env.SCI_TEST_DIR = 'C:\\tmp\\sci';
  const file = writeConfig({
    ...baseConfig,
    science: { dataDir: '%SCI_TEST_DIR%\\data' },
    logging: { level: 'debug', dir: '%SCI_TEST_DIR%\\logs' },
  });
  const cfg = loadConfig(file);
  assert.equal(cfg.upstream.baseURL, 'https://api.example.com/v1');
  assert.equal(cfg.models[0].publishAs, 'claude-opus-5');
  assert.equal(cfg.defaultModel, 'real-model-a');
  assert.equal(cfg.science.dataDir, 'C:\\tmp\\sci\\data');
  assert.equal(cfg.science.configTomlPath, 'C:\\tmp\\sci\\data\\config.toml');
  assert.equal(cfg.ports.inference, 14402);
  assert.equal(cfg.ports.daemon, 8010);
});

test('describeConfig 不回显密钥', () => {
  const cfg = loadConfig(writeConfig(baseConfig));
  const described = JSON.stringify(describeConfig(cfg));
  assert.ok(!described.includes('sk-test-key-value-1234'));
  assert.ok(described.includes('<set>'));
});

test('缺少 apiKey 直接报错', () => {
  const file = writeConfig({ ...baseConfig, upstream: { baseURL: 'https://api.example.com/v1' } });
  assert.throws(() => loadConfig(file), ConfigError);
});

test('publishAs 重复报错', () => {
  const file = writeConfig({
    ...baseConfig,
    models: [
      { id: 'a', publishAs: 'claude-opus-5' },
      { id: 'b', publishAs: 'claude-opus-5' },
    ],
  });
  assert.throws(() => loadConfig(file), /publishAs 重复/);
});

test('defaultModel 必须在 models 里', () => {
  const file = writeConfig({ ...baseConfig, defaultModel: 'nope' });
  assert.throws(() => loadConfig(file), /defaultModel/);
});

test('端口必须互不相同', () => {
  const file = writeConfig({ ...baseConfig, ports: { inference: 14402, daemon: 14402, sandbox: 8001, publicEntry: 8000 } });
  assert.throws(() => loadConfig(file), /互不相同/);
});

test('配置文件不存在时报错', () => {
  assert.throws(() => loadConfig(path.join(os.tmpdir(), 'definitely-missing-config.json')), /找不到配置文件/);
});

test('未展开的 %VAR% 占位符直接报错（避免「能启动但请求全失败」）', () => {
  const file = writeConfig({
    ...baseConfig,
    upstream: { baseURL: 'https://api.example.com/v1', apiKey: '%NOT_SET_UPSTREAM_KEY%' },
  });
  assert.throws(() => loadConfig(file), /未展开的环境变量占位符/);
});

test('四个端口必须两两互不相同（含 publicEntry 与 inference 撞车）', () => {
  const file = writeConfig({
    ...baseConfig,
    ports: { inference: 14402, publicEntry: 14402, daemon: 8010, sandbox: 8001 },
  });
  assert.throws(() => loadConfig(file), /两两互不相同/);
});
