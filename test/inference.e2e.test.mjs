/**
 * 端到端集成测试：mock 上游（OpenAI Chat）+ 我们的推理代理（Anthropic 形状）。
 * 覆盖：模型目录、非流式、流式 SSE、count_tokens、错误映射、凭证剥离、未知端点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.mjs';
import { createInferenceServer } from '../src/inference-server.mjs';

const UPSTREAM_KEY = 'sk-upstream-secret-key';
const CLIENT_KEY = 'sk-inbound-should-be-dropped';

/** 起一个 mock OpenAI 上游，记录收到的请求，行为可按场景切换。 */
async function startMockUpstream(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: (() => {
        try {
          return JSON.parse(bodyText);
        } catch {
          return bodyText;
        }
      })(),
    };
    seen.push(record);
    await handler(req, res, record);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    seen,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startProxy(upstreamBaseURL, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sci-proxy-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    upstream: { baseURL: upstreamBaseURL, apiKey: UPSTREAM_KEY, ...(overrides.upstream ?? {}) },
    models: [{ id: 'real-model-x', publishAs: 'claude-opus-5', displayName: 'Real X' }],
    defaultModel: 'real-model-x',
    logging: { level: 'error', dir: null },
    ...(overrides.root ?? {}),
  }));
  const cfg = loadConfig(configPath);
  const { server } = createInferenceServer(cfg);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    cfg,
    baseURL: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readSSE(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const ev = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
  }
  return events;
}

test('GET /v1/models 发布 Claude 形状目录', async () => {
  const upstream = await startMockUpstream((req, res) => res.end('{}'));
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/models?limit=1000&beta=true`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, 'claude-opus-5');
    assert.equal(body.data[0].display_name, 'Real X');
    assert.equal(body.data[0].type, 'model');
    assert.equal(upstream.seen.length, 0, '模型目录必须是本地的，不能打到上游');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('客户端非流式 + 上游仅流式：本地聚合，入站凭证被剥离且上游收到真实 key/模型名', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '你好，我是' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '上游模型' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CLIENT_KEY}`,
        'x-api-key': CLIENT_KEY,
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 64,
        system: '系统提示',
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.model, 'claude-opus-5');
    assert.equal(body.content[0].text, '你好，我是上游模型');
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.usage.input_tokens, 12);
    assert.equal(body.usage.output_tokens, 5);

    const received = upstream.seen[0];
    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    assert.ok(!JSON.stringify(received.headers).includes(CLIENT_KEY), '入站 client key 绝不能转发给上游');
    assert.equal(received.body.model, 'real-model-x');
    assert.equal(received.body.stream, true, '上游只走流式：请求必须带 stream:true');
    assert.equal(received.body.messages[0].role, 'system');
    assert.equal(received.body.messages[0].content, '系统提示');
    assert.equal(received.body.max_tokens, 64);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('流式对话：Anthropic SSE 事件序列完整', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = readSSE(await res.text());
    assert.deepEqual(events.map((e) => e.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.equal(events[2].data.delta.text, '你');
    assert.equal(events[3].data.delta.text, '好');
    assert.equal(events[5].data.delta.stop_reason, 'end_turn');
    assert.equal(events[5].data.usage.output_tokens, 2);
    assert.equal(upstream.seen[0].body.stream, true);
    assert.deepEqual(upstream.seen[0].body.stream_options, { include_usage: true });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('流式工具调用：上游分片参数被还原成 partial_json', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.end();
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'ls' }],
        tools: [{ name: 'shell', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      }),
    });
    const events = readSSE(await res.text());
    const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.ok(toolStart, '必须出现 tool_use 块');
    assert.equal(toolStart.data.content_block.name, 'shell');
    const json = events
      .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'partial_json')
      .map((e) => e.data.delta.partial_json)
      .join('');
    assert.deepEqual(JSON.parse(json), { cmd: 'ls' });
    const delta = events.find((e) => e.event === 'message_delta');
    assert.equal(delta.data.delta.stop_reason, 'tool_use');
    assert.equal(upstream.seen[0].body.tools[0].function.name, 'shell');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('count_tokens 走本地估算，不打上游', async () => {
  const upstream = await startMockUpstream((req, res) => res.end('{}'));
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'a'.repeat(400) }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.input_tokens >= 100 && body.input_tokens <= 110, `估算应约等于 100，实际 ${body.input_tokens}`);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游 401 映射为 Anthropic authentication_error', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
    assert.equal(body.error.message, 'invalid api key');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游 500 映射为 api_error，流式请求同样在开流前返回 JSON 错误', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('upstream boom');
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.error.type, 'api_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('未知模型在 reject 策略下 404；Claude 别名在 default 策略下回退', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
  });
  const proxy = await startProxy(upstream.baseURL, { root: { unknownModelPolicy: 'reject' } });
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'totally-unknown', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.type, 'not_found_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }

  const upstream2 = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
  });
  const proxy2 = await startProxy(upstream2.baseURL);
  try {
    const res = await fetch(`${proxy2.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream2.seen[0].body.model, 'real-model-x');
  } finally {
    await proxy2.close();
    await upstream2.close();
  }
});

test('GET /health 与未知端点', async () => {
  const upstream = await startMockUpstream((req, res) => res.end('{}'));
  const proxy = await startProxy(upstream.baseURL);
  try {
    const health = await (await fetch(`${proxy.baseURL}/health`)).json();
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.models, ['claude-opus-5']);

    const missing = await fetch(`${proxy.baseURL}/v1/organizations`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.type, 'not_found_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('客户端要非流式时，本地把上游流式分片聚合成完整消息（含工具调用）', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '第一段' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二段' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'shell', arguments: '{"cmd":' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 21 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: '列目录' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.content[0].type, 'text');
    assert.equal(body.content[0].text, '第一段第二段');
    assert.equal(body.content[1].type, 'tool_use');
    assert.equal(body.content[1].name, 'shell');
    assert.deepEqual(body.content[1].input, { cmd: 'pwd' });
    assert.equal(body.stop_reason, 'tool_use');
    assert.equal(body.usage.input_tokens, 9);
    assert.equal(body.usage.output_tokens, 21);
    // 关键：即使客户端要非流式，上游收到的仍是流式请求
    assert.equal(upstream.seen[0].body.stream, true);
    assert.deepEqual(upstream.seen[0].body.stream_options, { include_usage: true });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('网关忽略 stream:true 却回了 JSON：本地按 JSON 解析（不产出空回复）', async () => {
  const upstream = await startMockUpstream((req, res) => {
    // 声明 application/json：走 content-type 分支
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '网关回了 JSON' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }));
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, '网关回了 JSON');
    assert.equal(body.usage.input_tokens, 3);
    assert.equal(upstream.seen[0].body.stream, true, '仍然以流式请求上游');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('网关回 JSON 但 content-type 不标注：按首片嗅探兜底解析', async () => {
  const upstream = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '无类型 JSON' } }],
    }));
  });
  const proxy = await startProxy(upstream.baseURL);
  try {
    const res = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content[0].text, '无类型 JSON');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
