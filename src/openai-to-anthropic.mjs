/**
 * OpenAI Chat Completions 响应 → Anthropic Messages 响应（含流式 SSE 事件）。
 *
 * 流式状态机要点：
 *  - Anthropic 的 content block 是「先 start、再 delta、后 stop」；切换到另一种块
 *    之前必须先 stop 当前块，因此这里维护一个「当前打开的块」指针。
 *  - 上游的 tool_calls 以 index 增量下发（name 与 arguments 都可能分片），这里按
 *    index 累积、首次拿到内容时才开块，arguments 分片原样转成 partial_json。
 *  - 上游若只给了 finish_reason 没给 usage，也要保证 message_delta 带 output_tokens。
 */

const STOP_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'stop_sequence',
  null: 'end_turn',
};

export function stopReasonFromFinishReason(finishReason) {
  if (finishReason == null) return 'end_turn';
  return STOP_REASON_MAP[finishReason] ?? 'end_turn';
}

export function newMessageId() {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function newToolUseId() {
  return `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function usageFromOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? 0;
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Number(cached ?? 0),
  };
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { __raw_arguments: raw };
  }
}

/** 非流式响应转换。 */
export function toAnthropicResponse({ openaiResponse, publicModel, messageId }) {
  const choice = openaiResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: call.id || newToolUseId(),
        name: call.function?.name ?? 'unknown_tool',
        input: parseToolArguments(call.function?.arguments),
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const usage = usageFromOpenAI(openaiResponse?.usage) ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  return {
    id: messageId ?? newMessageId(),
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: stopReasonFromFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage,
  };
}

/**
 * 由「文本 + 工具调用 + 停止原因 + usage」装配 Anthropic 响应体。
 * 非流式（上游 JSON）与「客户端非流式但上游流式（本地聚合）」两条路都走这里。
 */
export function toAnthropicResponseFromParts({
  publicModel,
  messageId,
  text = '',
  toolCalls = [],
  finishReason = null,
  usage = null,
}) {
  const content = [];
  if (typeof text === 'string' && text !== '') {
    content.push({ type: 'text', text });
  }
  for (const call of toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id || newToolUseId(),
      name: call.name ?? 'unknown_tool',
      input: parseToolArguments(call.arguments),
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: messageId ?? newMessageId(),
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: stopReasonFromFinishReason(finishReason),
    stop_sequence: null,
    usage: usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * 上游流式 chunk 聚合器：客户端要非流式、而上游只会流式时用它把分片拼回一个完整消息。
 */
export class OpenAIStreamAccumulator {
  constructor() {
    this.text = '';
    this.toolCalls = new Map();
    this.finishReason = null;
    this.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  push(chunk) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string') this.text += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const key = call.index ?? 0;
        const state = this.toolCalls.get(key) ?? { id: '', name: '', arguments: '' };
        if (call.id) state.id = call.id;
        if (typeof call.function?.name === 'string') state.name += call.function.name;
        if (typeof call.function?.arguments === 'string') state.arguments += call.function.arguments;
        this.toolCalls.set(key, state);
      }
    }
    if (typeof choice?.finish_reason === 'string') this.finishReason = choice.finish_reason;
    const usage = usageFromOpenAI(chunk?.usage);
    if (usage) {
      if (usage.input_tokens > 0) this.usage.input_tokens = usage.input_tokens;
      if (usage.output_tokens > 0) this.usage.output_tokens = usage.output_tokens;
      this.usage.cache_read_input_tokens = usage.cache_read_input_tokens;
    }
  }

  toAnthropicResponse({ publicModel, messageId }) {
    const toolCalls = [...this.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, state]) => state);
    const usage = { ...this.usage };
    if (usage.output_tokens === 0 && this.text !== '') {
      usage.output_tokens = Math.max(1, Math.round(this.text.length / 4));
    }
    return toAnthropicResponseFromParts({
      publicModel,
      messageId,
      text: this.text,
      toolCalls,
      finishReason: this.finishReason,
      usage,
    });
  }
}

/**
 * 流式翻译器：把解析后的 OpenAI chunk 逐个喂进来，返回要给客户端的 Anthropic 事件序列。
 */
export class AnthropicStreamTranslator {
  constructor({ publicModel, messageId = newMessageId(), includeReasoning = false }) {
    this.publicModel = publicModel;
    this.messageId = messageId;
    this.includeReasoning = includeReasoning;
    this.started = false;
    this.nextIndex = 0;
    this.openBlock = null; // {kind:'text'|'tool'|'thinking', index}
    this.toolStates = new Map(); // openai tool index -> {id, name, blockIndex, started}
    this.finished = false;
    this.sawContent = false;
    this.stopReason = null;
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  }

  #event(name, payload) {
    return { event: name, data: payload };
  }

  #closeOpenBlock(out) {
    if (!this.openBlock) return;
    out.push(this.#event('content_block_stop', {
      type: 'content_block_stop',
      index: this.openBlock.index,
    }));
    this.openBlock = null;
  }

  #ensureStarted(out) {
    if (this.started) return;
    this.started = true;
    out.push(this.#event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.publicModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    }));
  }

  #startTextBlock(out) {
    if (this.openBlock?.kind === 'text') return;
    this.#closeOpenBlock(out);
    const index = this.nextIndex++;
    this.openBlock = { kind: 'text', index };
    this.sawContent = true;
    out.push(this.#event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    }));
  }

  #startThinkingBlock(out) {
    if (this.openBlock?.kind === 'thinking') return;
    this.#closeOpenBlock(out);
    const index = this.nextIndex++;
    this.openBlock = { kind: 'thinking', index };
    this.sawContent = true;
    out.push(this.#event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' },
    }));
  }

  #startToolBlock(out, toolState) {
    this.#closeOpenBlock(out);
    const index = this.nextIndex++;
    toolState.blockIndex = index;
    this.openBlock = { kind: 'tool', index };
    this.sawContent = true;
    out.push(this.#event('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: toolState.id,
        name: toolState.name || 'unknown_tool',
        input: {},
      },
    }));
  }

  /** 处理一个 OpenAI chunk，返回 Anthropic 事件数组。 */
  push(chunk) {
    const out = [];
    if (this.finished) return out;

    this.#ensureStarted(out);

    const usage = usageFromOpenAI(chunk?.usage);
    if (usage) {
      if (usage.input_tokens > 0) this.usage.input_tokens = usage.input_tokens;
      if (usage.output_tokens > 0) this.usage.output_tokens = usage.output_tokens;
      this.usage.cache_read_input_tokens = usage.cache_read_input_tokens;
    }

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta ?? {};

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (this.includeReasoning && typeof reasoning === 'string' && reasoning !== '') {
      this.#startThinkingBlock(out);
      out.push(this.#event('content_block_delta', {
        type: 'content_block_delta',
        index: this.openBlock.index,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }));
    }

    if (typeof delta.content === 'string' && delta.content !== '') {
      this.#startTextBlock(out);
      out.push(this.#event('content_block_delta', {
        type: 'content_block_delta',
        index: this.openBlock.index,
        delta: { type: 'text_delta', text: delta.content },
      }));
    }

    if (Array.isArray(delta.tool_calls)) {
      // 工具调用只累积、不在流中途开块：上游常在多个 index 之间交错下发参数分片，
      // 若边收边开块，切换 index 时会先关掉前一个块，随后到达的旧 index 参数就会
      // 落在已 stop 的块上（非法序列）。统一在 finish() 按 index 顺序产出。
      for (const call of delta.tool_calls) {
        const key = call.index ?? 0;
        const state = this.toolStates.get(key) ?? { id: '', name: '', arguments: '' };
        if (call.id) state.id = call.id;
        if (typeof call.function?.name === 'string' && call.function.name !== '') {
          state.name += call.function.name;
        }
        if (typeof call.function?.arguments === 'string') state.arguments += call.function.arguments;
        this.toolStates.set(key, state);
      }
    }

    if (typeof choice?.finish_reason === 'string') {
      this.stopReason = stopReasonFromFinishReason(choice.finish_reason);
    }

    return out;
  }

  /** 流结束：按 index 顺序产出工具块，再补齐 message_delta 与 message_stop。 */
  finish() {
    const out = [];
    if (this.finished) return out;
    this.#ensureStarted(out);

    const toolEntries = [...this.toolStates.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, state] of toolEntries) {
      this.#closeOpenBlock(out);
      const index = this.nextIndex++;
      this.sawContent = true;
      out.push(this.#event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: state.id || newToolUseId(),
          name: state.name || 'unknown_tool',
          input: {},
        },
      }));
      if (state.arguments !== '') {
        out.push(this.#event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'partial_json', partial_json: state.arguments },
        }));
      }
      out.push(this.#event('content_block_stop', { type: 'content_block_stop', index }));
    }
    if (!this.sawContent) this.#startTextBlock(out);
    this.#closeOpenBlock(out);

    out.push(this.#event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    }));
    out.push(this.#event('message_stop', { type: 'message_stop' }));
    this.finished = true;
    return out;
  }

  setOutputTokens(count) {
    if (Number.isFinite(count) && count > 0) this.usage.output_tokens = count;
  }
}

/** 上游 HTTP 错误 → Anthropic 风格错误体。 */
export function mapUpstreamError(status, bodyText) {
  let detail = '';
  let upstreamType = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? '';
    upstreamType = parsed?.error?.type ?? parsed?.type ?? '';
  } catch {
    detail = String(bodyText ?? '').slice(0, 500);
  }

  let type = 'api_error';
  if (status === 400 || status === 422) type = 'invalid_request_error';
  else if (status === 401 || status === 403) type = 'authentication_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 413) type = 'request_too_large';
  else if (status === 429) type = 'rate_limit_error';
  else if (status === 529 || status === 503) type = 'overloaded_error';

  const message = detail
    || (upstreamType ? `上游错误：${upstreamType}` : `上游返回 HTTP ${status}`);

  return {
    status: status === 422 ? 400 : status,
    body: {
      type: 'error',
      error: { type, message },
    },
  };
}
