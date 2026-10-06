import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIRequest, toolChoiceToOpenAI, systemToText, reasoningEffortFrom } from '../src/anthropic-to-openai.mjs';
import { toAnthropicResponse, stopReasonFromFinishReason, mapUpstreamError } from '../src/openai-to-anthropic.mjs';
import { createModelMap, anthropicModelsPayload, stripContextSuffix } from '../src/model-map.mjs';

const upstream = {
  maxTokensField: 'max_tokens',
  sendStreamUsage: true,
  supportsTools: true,
  supportsReasoningEffort: false,
  supportsParallelTools: true,
};

test('system 块数组压成文本', () => {
  assert.equal(systemToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb');
  assert.equal(systemToText('x'), 'x');
  assert.equal(systemToText(undefined), '');
});

test('tool_choice 映射', () => {
  assert.equal(toolChoiceToOpenAI({ type: 'auto' }), 'auto');
  assert.equal(toolChoiceToOpenAI({ type: 'any' }), 'required');
  assert.equal(toolChoiceToOpenAI({ type: 'none' }), 'none');
  assert.deepEqual(toolChoiceToOpenAI({ type: 'tool', name: 'shell' }), {
    type: 'function',
    function: { name: 'shell' },
  });
});

test('effort 映射（xhigh/max → high）', () => {
  assert.equal(reasoningEffortFrom({ output_config: { effort: 'low' } }), 'low');
  assert.equal(reasoningEffortFrom({ output_config: { effort: 'xhigh' } }), 'high');
  assert.equal(reasoningEffortFrom({ output_config: { effort: 'max' } }), 'high');
  assert.equal(reasoningEffortFrom({ thinking: { budget_tokens: 1000 } }), 'low');
  assert.equal(reasoningEffortFrom({ thinking: { budget_tokens: 20000 } }), 'high');
  assert.equal(reasoningEffortFrom({}), undefined);
});

test('基础请求转换：system + 文本 + 参数', () => {
  const { body, notes } = buildOpenAIRequest({
    upstreamModel: 'real-model',
    upstream,
    request: {
      model: 'claude-opus-5',
      system: '你是助手',
      max_tokens: 100,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['END'],
      stream: true,
      messages: [{ role: 'user', content: '你好' }],
      metadata: { user_id: 'u1' },
      thinking: { type: 'enabled', budget_tokens: 4000 },
    },
  });
  assert.equal(body.model, 'real-model');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(body.stop, ['END']);
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages[1], { role: 'user', content: '你好' });
  assert.equal(body.top_k, undefined);
  assert.ok(body.stream_options.include_usage);
  assert.ok(notes.some((n) => n.includes('top_k')));
  assert.ok(notes.some((n) => n.includes('metadata')));
});

test('工具定义与多轮 tool_use/tool_result 转换', () => {
  const { body } = buildOpenAIRequest({
    upstreamModel: 'real-model',
    upstream,
    request: {
      model: 'claude-opus-5',
      max_tokens: 512,
      tools: [{ name: 'shell', description: 'run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: '列目录' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看看' },
            { type: 'text', text: '我来执行' },
            { type: 'tool_use', id: 'toolu_1', name: 'shell', input: { cmd: 'ls' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' }] },
      ],
    },
  });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'shell');
  assert.deepEqual(body.tools[0].function.parameters.properties.cmd, { type: 'string' });
  assert.equal(body.tool_choice, 'auto');
  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.content, '我来执行');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'toolu_1');
  assert.equal(assistant.tool_calls[0].function.name, 'shell');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { cmd: 'ls' });
  const toolMessage = body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'toolu_1');
  assert.equal(toolMessage.content, 'a.txt\nb.txt');
});

test('图片块转 data URL', () => {
  const { body } = buildOpenAIRequest({
    upstreamModel: 'real-model',
    upstream,
    request: {
      model: 'claude-opus-5',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ],
      }],
    },
  });
  const parts = body.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,QUJD');
});

test('关闭工具支持时丢弃工具定义', () => {
  const { body, notes } = buildOpenAIRequest({
    upstreamModel: 'm',
    upstream: { ...upstream, supportsTools: false },
    request: { model: 'x', max_tokens: 10, tools: [{ name: 't', input_schema: {} }], messages: [] },
  });
  assert.equal(body.tools, undefined);
  assert.ok(notes.some((n) => n.includes('工具定义')));
});

test('开启 reasoning_effort 时透传 effort', () => {
  const { body } = buildOpenAIRequest({
    upstreamModel: 'm',
    upstream: { ...upstream, supportsReasoningEffort: true },
    request: { model: 'x', max_tokens: 10, output_config: { effort: 'max' }, messages: [] },
  });
  assert.equal(body.reasoning_effort, 'high');
});

test('非流式响应转换：文本 + 工具调用 + usage', () => {
  const response = toAnthropicResponse({
    publicModel: 'claude-opus-5',
    messageId: 'msg_test',
    openaiResponse: {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '好的',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }],
        },
      }],
      usage: { prompt_tokens: 11, completion_tokens: 22, prompt_tokens_details: { cached_tokens: 3 } },
    },
  });
  assert.equal(response.id, 'msg_test');
  assert.equal(response.type, 'message');
  assert.equal(response.model, 'claude-opus-5');
  assert.equal(response.stop_reason, 'tool_use');
  assert.equal(response.content[0].text, '好的');
  assert.equal(response.content[1].type, 'tool_use');
  assert.deepEqual(response.content[1].input, { cmd: 'pwd' });
  assert.equal(response.usage.input_tokens, 11);
  assert.equal(response.usage.output_tokens, 22);
  assert.equal(response.usage.cache_read_input_tokens, 3);
});

test('非法 arguments 不抛错', () => {
  const response = toAnthropicResponse({
    publicModel: 'm',
    openaiResponse: {
      choices: [{ finish_reason: 'stop', message: { content: '', tool_calls: [{ id: 'c', function: { name: 't', arguments: '{oops' } }] } }],
    },
  });
  assert.equal(response.content[0].input.__raw_arguments, '{oops');
});

test('finish_reason 映射与空响应补空块', () => {
  assert.equal(stopReasonFromFinishReason('length'), 'max_tokens');
  assert.equal(stopReasonFromFinishReason('stop'), 'end_turn');
  assert.equal(stopReasonFromFinishReason(undefined), 'end_turn');
  const response = toAnthropicResponse({ publicModel: 'm', openaiResponse: { choices: [{ finish_reason: null, message: {} }] } });
  assert.deepEqual(response.content, [{ type: 'text', text: '' }]);
});

test('上游错误映射为 Anthropic 错误体', () => {
  const mapped = mapUpstreamError(401, '{"error":{"message":"bad key"}}');
  assert.equal(mapped.status, 401);
  assert.equal(mapped.body.error.type, 'authentication_error');
  assert.equal(mapped.body.error.message, 'bad key');
  assert.equal(mapUpstreamError(429, 'rate limited').body.error.type, 'rate_limit_error');
  assert.equal(mapUpstreamError(503, '').body.error.type, 'overloaded_error');
  assert.equal(mapUpstreamError(422, 'nope').status, 400);
});

test('模型映射：发布 ID / 上游 ID / Claude 别名回退 / 拒绝策略', () => {
  const map = createModelMap(
    [{ id: 'real-a', publishAs: 'claude-opus-5', displayName: 'A' }, { id: 'real-b', publishAs: 'claude-sonnet-5', displayName: 'B' }],
    'real-a',
    'default',
  );
  assert.equal(map.resolve('claude-opus-5').upstreamModel, 'real-a');
  assert.equal(map.resolve('claude-opus-5[1m]').upstreamModel, 'real-a');
  assert.equal(map.resolve('claude-sonnet-5').upstreamModel, 'real-b');
  assert.equal(map.resolve('real-b').upstreamModel, 'real-b');
  assert.equal(map.resolve('claude-3-opus-20240229').upstreamModel, 'real-a');
  assert.equal(map.resolve('claude-3-opus-20240229').matchedBy, 'fallback-default');
  assert.equal(map.publicIdFor('real-b'), 'claude-sonnet-5');
  assert.equal(map.publicIdFor('unknown'), 'claude-opus-5');

  const strict = createModelMap([{ id: 'a', publishAs: 'claude-opus-5', displayName: 'A' }], 'a', 'reject');
  assert.throws(() => strict.resolve('some-other-model'));
});

test('stripContextSuffix 只剥 [1m]', () => {
  assert.equal(stripContextSuffix('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(stripContextSuffix('claude-opus-5'), 'claude-opus-5');
});

test('/v1/models 负载形状', () => {
  const payload = anthropicModelsPayload([{ id: 'real-a', publishAs: 'claude-opus-5', displayName: 'A' }]);
  assert.equal(payload.data[0].id, 'claude-opus-5');
  assert.equal(payload.data[0].display_name, 'A');
  assert.equal(payload.data[0].type, 'model');
  assert.equal(payload.has_more, false);
  assert.equal(payload.first_id, 'claude-opus-5');
});

test('上游不支持工具时：tool_use / tool_result 降级为文本（不出 tool_calls / role:tool）', () => {
  const { body, notes } = buildOpenAIRequest({
    upstreamModel: 'm',
    upstream: { ...upstream, supportsTools: false },
    request: {
      model: 'x',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { cmd: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
      ],
    },
  });
  assert.equal(body.messages.some((m) => m.tool_calls), false);
  assert.equal(body.messages.some((m) => m.role === 'tool'), false);
  assert.match(JSON.stringify(body.messages), /tool_use shell/);
  assert.match(JSON.stringify(body.messages), /tool_result t1/);
  assert.ok(notes.some((n) => n.includes('降级为文本')));
});

test('tool_result 缺少配对 id 时降级为文本（避免孤立 role:tool 被 400）', () => {
  const { body } = buildOpenAIRequest({
    upstreamModel: 'm',
    upstream,
    request: {
      model: 'x',
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: '孤立结果' }] }],
    },
  });
  assert.equal(body.messages.some((m) => m.role === 'tool'), false);
  assert.match(JSON.stringify(body.messages), /孤立结果/);
});
