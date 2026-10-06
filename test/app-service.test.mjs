/**
 * 编排层单测：全部通过依赖注入跑，不碰真实端口、不杀真实进程、不写真实 state.json。
 *
 * 覆盖：状态机（成功/各阶段失败/回滚）、端口占用拦截、登录态护栏、停止幂等、纯函数解析。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAppService,
  parseListeningPids,
  collectRecordedPids,
  maskConfigSecrets,
  STAGE_LABELS,
} from '../src/app-service.mjs';
import { log } from '../src/log.mjs';

let tmpRoot;
let configPath;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiusage-app-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const logDir = path.join(tmpRoot, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const binary = path.join(tmpRoot, 'fake-science.exe');
  fs.writeFileSync(binary, 'stub');
  configPath = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    upstream: { baseURL: 'https://example.invalid/api/v1', apiKey: 'sk-test-not-real' },
    models: [{ id: 'vendor/model-a', publishAs: 'claude-opus-5', displayName: 'Model A' }],
    ports: { inference: 19991, publicEntry: 19992, daemon: 19993, sandbox: 19994 },
    science: { dataDir, binaryPath: binary, noAutoUpdate: true },
    logging: { level: 'info', dir: logDir },
  }, null, 2));
});

after(() => {
  log.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

/** 造一份「完全不碰真实系统」的依赖替身，并把每次调用记进 calls。 */
function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    backup: async () => { calls.push('backup'); return { dest: 'backup-dir', copied: ['a', 'b'], missing: [] }; },
    inspectLogin: async () => {
      calls.push('inspectLogin');
      return overrides.inspectLogin
        ? overrides.inspectLogin()
        : { keyAvailable: true, hasRealLogin: false, tokens: [], files: [], dataDir: tmpRoot };
    },
    writeLogin: async () => { calls.push('writeLogin'); return { file: 'local-dev.enc' }; },
    startInference: async () => {
      calls.push('startInference');
      return { port: 19991, close: async () => { calls.push('inference.close'); } };
    },
    createSession: () => ({
      start: async () => { calls.push('session.start'); },
      stop: async () => { calls.push('session.stop'); },
      probe: async () => { calls.push('session.probe'); return { ok: overrides.probeOk !== false, status: 200 }; },
    }),
    spawnDaemon: () => { calls.push('spawnDaemon'); return { pid: 4242, child: null }; },
    stopDaemonChain: async () => { calls.push('stopDaemonChain'); return { cli: { code: 0 }, killed: [] }; },
    probe: async () => { calls.push('probe'); return { ok: true, status: 200 }; },
    waitHealth: async () => { calls.push('waitHealth'); return overrides.healthOk !== false; },
    listListeningPids: async () => { calls.push('listListeningPids'); return overrides.busyPorts ?? []; },
    killPortOwners: async () => { calls.push('killPortOwners'); return []; },
    killIfAllowed: async () => { calls.push('killIfAllowed'); return { killed: false }; },
    describePid: async () => 'stub.exe',
    readStateFile: () => { calls.push('readStateFile'); return null; },
    writeStateFile: (payload) => { calls.push('writeStateFile'); deps.writtenState = payload; return true; },
    removeStateFile: () => { calls.push('removeStateFile'); return true; },
    openUrl: () => { calls.push('openUrl'); return true; },
    logDir: () => path.join(tmpRoot, 'logs'),
  };
  return deps;
}

function makeService(overrides = {}) {
  const deps = makeDeps(overrides);
  const events = [];
  const service = createAppService({ configPath, deps, healthTimeoutMs: 1000 });
  service.onEvent((event) => events.push(event));
  return { service, deps, events };
}

// MARK: - 纯函数

test('parseListeningPids 只挑出目标端口的 LISTENING 行', () => {
  const netstat = [
    '  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       13708',
    '  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       111',
    '  TCP    [::]:8000              [::]:0                 LISTENING       111',
    '  TCP    127.0.0.1:8000         127.0.0.1:51234        ESTABLISHED     222',
    '  TCP    127.0.0.1:8010         0.0.0.0:0              LISTENING       333',
  ].join('\r\n');
  assert.deepEqual(parseListeningPids(netstat, 8000), [111]);
  assert.deepEqual(parseListeningPids(netstat, 8010), [333]);
  assert.deepEqual(parseListeningPids(netstat, 9999), []);
  assert.deepEqual(parseListeningPids('', 8000), []);
});

test('collectRecordedPids 兼容脚本与应用两种 state.json', () => {
  assert.deepEqual(collectRecordedPids({ inferencePid: 100, sessionPid: 200, startedAt: 'x' }).sort(), [100, 200]);
  assert.deepEqual(collectRecordedPids({ daemonPid: 300, hostPid: 4, ports: { inference: 1 } }), [300]);
  assert.deepEqual(collectRecordedPids(null), []);
});

test('maskConfigSecrets 只打码疑似密钥字段', () => {
  const masked = maskConfigSecrets({
    upstream: { apiKey: 'sk-abcdefghijklmnop', baseURL: 'https://x.invalid' },
    tokens: 'abc',
    nested: [{ secret: '' }],
    port: 8000,
  });
  assert.equal(masked.upstream.apiKey, '<set:19>');
  assert.equal(masked.upstream.baseURL, 'https://x.invalid');
  assert.equal(masked.tokens, '<set:3>');
  assert.equal(masked.nested[0].secret, '<empty>');
  assert.equal(masked.port, 8000);
});

// MARK: - 启动

test('start 成功：阶段事件齐全、进入 running、写 state.json', async () => {
  const { service, deps, events } = makeService();
  const status = await service.start();

  assert.equal(status.phase, 'running');
  assert.equal(service.isRunning(), true);
  const stages = events.filter((e) => e.type === 'stage').map((e) => e.stage);
  assert.deepEqual(stages, [
    'validate', 'backup', 'login', 'cleanup', 'inference',
    'daemon-start', 'daemon-health', 'session', 'probe',
  ]);
  for (const stage of stages) assert.ok(STAGE_LABELS[stage], `阶段 ${stage} 应有中文标签`);

  assert.ok(deps.calls.includes('startInference'));
  assert.ok(deps.calls.includes('spawnDaemon'));
  assert.ok(deps.calls.includes('session.start'));
  assert.equal(deps.writtenState.phase, 'running');
  assert.equal(deps.writtenState.managedBy, 'aiusage-app');
  assert.deepEqual(deps.writtenState.inProcess, ['inference', 'session']);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(status.loginMode, 'virtual-created');
});

test('start 复用已有虚拟登录，不重复写入', async () => {
  const { service, deps } = makeService({
    inspectLogin: () => ({
      keyAvailable: true,
      hasRealLogin: false,
      tokens: [{ file: 'local-dev.enc', virtual: true }],
      files: ['local-dev.enc'],
    }),
  });
  const status = await service.start();
  assert.equal(status.loginMode, 'virtual-reuse');
  assert.ok(!deps.calls.includes('writeLogin'));
});

test('start 检测到真实登录：直接复用，绝不覆盖', async () => {
  const { service, deps } = makeService({
    inspectLogin: () => ({
      keyAvailable: true,
      hasRealLogin: true,
      tokens: [{ file: 'real.enc', virtual: false }],
      files: ['real.enc'],
    }),
  });
  const status = await service.start();
  assert.equal(status.loginMode, 'real');
  assert.ok(!deps.calls.includes('writeLogin'));
});

test('start 在 login 阶段失败：报错带阶段与提示，且不启动任何代理', async () => {
  const { service, deps, events } = makeService({
    inspectLogin: () => ({ keyAvailable: false, keyError: '缺少 OAUTH_ENCRYPTION_KEY', tokens: [], files: [] }),
  });
  await assert.rejects(() => service.start(), (err) => {
    assert.equal(err.stage, 'login');
    assert.match(err.hint, /Claude Science/);
    return true;
  });
  assert.equal(service.state.phase, 'error');
  assert.equal(service.state.lastErrorStage, 'login');
  assert.ok(!deps.calls.includes('startInference'));
  assert.ok(!deps.calls.includes('spawnDaemon'));
  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应发出 error 事件');
  assert.equal(error.stage, 'login');
});

test('start 在 daemon 健康检查失败：回滚推理代理与 daemon 并进入 error', async () => {
  const { service, deps, events } = makeService({ healthOk: false });
  await assert.rejects(() => service.start(), /daemon 未在/);
  assert.equal(service.state.phase, 'error');
  assert.equal(service.state.lastErrorStage, 'daemon-health');
  assert.ok(deps.calls.includes('inference.close'), '应回滚关闭推理代理');
  assert.ok(deps.calls.includes('stopDaemonChain'), '应回滚停止 daemon');
  assert.ok(!deps.calls.includes('session.start'), '不应启动会话反代');
  assert.ok(events.some((e) => e.type === 'warn' && /回滚/.test(e.message)));
});

test('start 前端口被占用：cleanup 阶段直接失败，不启动代理', async () => {
  const { service, deps } = makeService({ busyPorts: [1234] });
  await assert.rejects(() => service.start(), (err) => {
    assert.equal(err.stage, 'cleanup');
    assert.match(err.message, /端口仍被占用/);
    return true;
  });
  assert.ok(!deps.calls.includes('startInference'));
  assert.equal(service.state.phase, 'error');
});

test('start 允许跳过备份', async () => {
  const { service, deps } = makeService();
  await service.start({ skipBackup: true });
  assert.ok(!deps.calls.includes('backup'));
});

test('重复 start：已在运行时直接返回状态并给出警告', async () => {
  const { service, events } = makeService();
  await service.start();
  const again = await service.start();
  assert.equal(again.phase, 'running');
  assert.ok(events.some((e) => e.type === 'warn' && /已在运行/.test(e.message)));
});

// MARK: - 停止

test('stop：关闭会话反代与推理代理、停止 daemon、删除 state.json', async () => {
  const { service, deps, events } = makeService();
  await service.start();
  const result = await service.stop();

  assert.equal(service.state.phase, 'stopped');
  assert.equal(result.ok, true);
  assert.deepEqual(result.leftovers, []);
  assert.ok(deps.calls.includes('session.stop'));
  assert.ok(deps.calls.includes('inference.close'));
  assert.ok(deps.calls.indexOf('session.stop') < deps.calls.lastIndexOf('stopDaemonChain'));
  assert.ok(events.some((e) => e.type === 'done' && /链路已停止/.test(e.message)));
});

test('stop 幂等：从未启动过也能清理并返回 ok', async () => {
  const { service, deps } = makeService();
  const result = await service.stop();
  assert.equal(result.ok, true);
  assert.equal(service.state.phase, 'stopped');
  assert.ok(deps.calls.includes('stopDaemonChain'), '未启动也要清理 daemon 残留');
});

test('stop 报告残留端口', async () => {
  const { service } = makeService({ busyPorts: [777] });
  const result = await service.stop();
  assert.equal(result.ok, false);
  assert.equal(result.leftovers.length, 3);
});

test('restart = stop + start', async () => {
  const { service, deps } = makeService();
  await service.start();
  const status = await service.restart();
  assert.equal(status.phase, 'running');
  assert.ok(deps.calls.includes('session.stop'));
  assert.ok(deps.calls.filter((c) => c === 'startInference').length === 2);
});

// MARK: - 状态

test('status 汇总端口探活、上游能力与登录态，且不含明文密钥', async () => {
  const { service } = makeService();
  const status = await service.status();
  assert.equal(status.ports.inference, 19991);
  assert.equal(status.upstream.apiKey, '<set>');
  assert.equal(status.models[0].publishAs, 'claude-opus-5');
  assert.equal(status.endpoints.daemon.port, 19993);
  assert.equal(status.science.binaryExists, true);
  assert.ok(!JSON.stringify(status).includes('sk-test-not-real'), '状态里不允许出现明文密钥');
  assert.equal(status.configError, null);
  // 登录态必须在返回值里（阶段 1 曾漏掉，界面因此一直是空的）
  assert.ok(status.login, 'status 必须包含 login 字段');
  assert.equal(status.login.keyAvailable, true);
  assert.deepEqual(status.login.tokens, []);
  // 多上游与档位也必须在返回值里
  assert.equal(status.upstreams[0].id, 'default');
  assert.equal(status.upstreams[0].apiKey, `<set:${'sk-test-not-real'.length}>`);
  assert.equal(status.tiers.opus, 'claude-opus-5');
  assert.equal(status.models[0].upstream, 'default');
});
