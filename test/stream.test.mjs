import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicStreamTranslator } from '../src/openai-to-anthropic.mjs';

function names(events) {
  return events.map((e) => e.event);
}

test('文本流：message_start → 文本块 → message_delta/stop', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'claude-opus-5', messageId: 'msg_1' });
  const events = [];
  events.push(...t.push({ choices: [{ delta: { role: 'assistant', content: '你' } }] }));
  events.push(...t.push({ choices: [{ delta: { content: '好' }, finish_reason: null }] }));
  events.push(...t.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
  events.push(...t.finish());

  assert.deepEqual(names(events), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[0].data.message.model, 'claude-opus-5');
  assert.equal(events[0].data.message.id, 'msg_1');
  assert.equal(events[2].data.delta.text, '你');
  assert.equal(events[3].data.delta.text, '好');
  assert.equal(events[5].data.delta.stop_reason, 'end_turn');
  assert.equal(events[5].data.usage.output_tokens, 2);
  assert.equal(events[0].data.message.usage.input_tokens, 0);
});

test('工具调用流：名字与参数分片，切块顺序合法', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'claude-opus-5', messageId: 'msg_2' });
  const events = [];
  events.push(...t.push({ choices: [{ delta: { content: '先查一下' } }] }));
  events.push(...t.push({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'sh', arguments: '' } }],
      },
    }],
  }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 9 } }));
  events.push(...t.finish());

  assert.deepEqual(names(events), [
    'message_start',
    'content_block_start', // 文本块（流中实时输出）
    'content_block_delta',
    'content_block_stop', // finish() 里先关文本块
    'content_block_start', // 工具块
    'content_block_delta', // 一次给出完整参数
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const toolStart = events[4].data.content_block;
  assert.equal(toolStart.type, 'tool_use');
  assert.equal(toolStart.id, 'call_abc');
  assert.equal(toolStart.name, 'sh');
  assert.deepEqual(JSON.parse(events[5].data.delta.partial_json), { cmd: 'ls' });
  assert.equal(events[7].data.delta.stop_reason, 'tool_use');
  assert.equal(events[7].data.usage.output_tokens, 9);
});

test('并行工具调用：两个 index 各自开块', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'm' });
  const events = [];
  events.push(...t.push({
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } },
          { index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } },
        ],
      },
    }],
  }));
  events.push(...t.finish());
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.data.content_block.name), ['a', 'b']);
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1]);
});

test('并行工具调用：参数分片跨 index 交错时，delta 不会落到已关闭的块上（回归）', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'm', messageId: 'msg_reg' });
  const events = [];
  // 上游常见形态：先给两个 index 的 name，再交错补各自 arguments
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'shell' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'python' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"code":' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"1+1"}' } }] } }] }));
  events.push(...t.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  events.push(...t.finish());

  // 任意时刻只能有一个「已开未关」的块，且 delta 的 index 必须是当前打开的块
  let open = null;
  for (const e of events) {
    if (e.event === 'content_block_start') {
      assert.equal(open, null, '不允许同时打开两个块');
      open = e.data.index;
    } else if (e.event === 'content_block_delta') {
      assert.equal(e.data.index, open, `delta 落到了未打开的块 index=${e.data.index}`);
    } else if (e.event === 'content_block_stop') {
      assert.equal(e.data.index, open, 'stop 的 index 必须是当前块');
      open = null;
    }
  }
  assert.equal(open, null, '流结束前必须关闭所有块');

  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.deepEqual(starts.map((e) => e.data.content_block.name), ['shell', 'python']);
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1]);
  const byIndex = new Map(events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => [e.data.index, e.data.delta.partial_json]));
  assert.deepEqual(JSON.parse(byIndex.get(0)), { cmd: 'ls' });
  assert.deepEqual(JSON.parse(byIndex.get(1)), { code: '1+1' });
  const delta = events.find((e) => e.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'tool_use');
});

test('空流也产出合法序列（补空文本块）', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'm' });
  const events = t.finish();
  assert.deepEqual(names(events), [
    'message_start',
    'content_block_start',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[1].data.content_block.text, '');
  assert.equal(events[3].data.delta.stop_reason, 'end_turn');
});

test('reasoning_content 默认丢弃，开启后转 thinking 块', () => {
  const off = new AnthropicStreamTranslator({ publicModel: 'm' });
  const offEvents = [
    ...off.push({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    ...off.finish(),
  ];
  assert.equal(offEvents.filter((e) => e.event === 'content_block_start').length, 1);

  const on = new AnthropicStreamTranslator({ publicModel: 'm', includeReasoning: true });
  const onEvents = [
    ...on.push({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    ...on.push({ choices: [{ delta: { content: '答案' } }] }),
    ...on.finish(),
  ];
  const starts = onEvents.filter((e) => e.event === 'content_block_start');
  assert.equal(starts[0].data.content_block.type, 'thinking');
  assert.equal(starts[1].data.content_block.type, 'text');
  const thinkingDelta = onEvents.find((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta');
  assert.equal(thinkingDelta.data.delta.thinking, '想一下');
});

test('finish 幂等：重复调用不再吐事件', () => {
  const t = new AnthropicStreamTranslator({ publicModel: 'm' });
  t.push({ choices: [{ delta: { content: 'x' } }] });
  const first = t.finish();
  const second = t.finish();
  assert.ok(first.length > 0);
  assert.equal(second.length, 0);
});
