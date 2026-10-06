/**
 * Anthropic Messages 请求 → OpenAI Chat Completions 请求。
 *
 * 设计原则：
 *  1. 只转发上游认识的字段（白名单），Claude 专有字段（metadata/context_management/
 *     mcp_servers/container/output_format/anthropic-* 等）一律丢弃，避免上游 400。
 *  2. 工具调用是 Science 的主力用法（shell/python/skill），`tool_use`/`tool_result`
 *     的多轮结构必须严格还原成 OpenAI 的 assistant.tool_calls + role:"tool"。
 *  3. 未知块类型不抛错、不静默丢内容：能转的转，转不了的记一条 warn 供排障。
 */

/** Anthropic 图像/文档块 → OpenAI image_url 数据 URL。 */
function imagePartToOpenAI(block) {
  const source = block?.source ?? {};
  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** 把 Anthropic 的 system（字符串或块数组）压成一段纯文本。 */
export function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .filter((t) => t !== '')
      .join('\n\n');
  }
  return '';
}

/** tool_result 的 content（字符串或块数组）→ 纯文本。 */
function toolResultToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block?.type === 'image') texts.push('[image omitted: 上游只接受文本工具结果]');
      else if (block?.type === 'document') texts.push('[document omitted: 上游只接受文本工具结果]');
      else if (typeof block?.text === 'string') texts.push(block.text);
    }
    return texts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * 归一化 OpenAI 的 tool_choice。
 * Anthropic: {type:"auto"} | {type:"any"} | {type:"tool",name} | {type:"none"}
 */
export function toolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return toolChoice.name
        ? { type: 'function', function: { name: toolChoice.name } }
        : 'auto';
    default:
      return undefined;
  }
}

/** Anthropic effort / thinking 预算 → 上游 reasoning_effort。 */
export function reasoningEffortFrom(request) {
  const effort = request?.output_config?.effort;
  if (typeof effort === 'string' && effort.trim() !== '') {
    const normalized = effort.trim().toLowerCase();
    if (normalized === 'xhigh' || normalized === 'max') return 'high';
    if (['low', 'medium', 'high', 'minimal'].includes(normalized)) return normalized;
  }
  const budget = request?.thinking?.budget_tokens;
  if (typeof budget === 'number' && budget > 0) {
    if (budget < 4096) return 'low';
    if (budget < 16384) return 'medium';
    return 'high';
  }
  return undefined;
}

/**
 * 主转换入口。
 * @returns {{body: object, notes: string[], upstreamModel: string}}
 */
export function buildOpenAIRequest({ request, upstreamModel, upstream, dropUnsupported = true }) {
  const notes = [];
  const messages = [];

  const systemText = systemToText(request.system);
  if (systemText.trim() !== '') {
    messages.push({ role: 'system', content: systemText });
  }

  const pushTextMessage = (role, text) => {
    if (typeof text !== 'string' || text === '') return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && !last.tool_calls) {
      last.content += `\n\n${text}`;
      return;
    }
    messages.push({ role, content: text });
  };
  const toolsSupported = upstream.supportsTools !== false;

  for (const message of request.messages ?? []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = message?.content;

    if (typeof content === 'string') {
      pushTextMessage(role, content);
      continue;
    }
    if (!Array.isArray(content)) {
      notes.push(`跳过无法识别的 ${role} 消息内容：${typeof content}`);
      continue;
    }

    const textParts = [];
    const imageParts = [];
    const toolCalls = [];
    const toolMessages = [];
    let sawThinking = false;

    for (const block of content) {
      switch (block?.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text !== '') textParts.push(block.text);
          break;
        case 'image': {
          const part = imagePartToOpenAI(block);
          if (part) imageParts.push(part);
          else notes.push('丢弃无法解析的 image 块（source 既非 base64 也非 url）');
          break;
        }
        case 'document':
          notes.push('丢弃 document 块（上游 OpenAI Chat 不支持 PDF 输入）');
          break;
        case 'tool_use':
          if (!toolsSupported) {
            // 上游不支持 function calling：降级成文本，避免发出 tool_calls 被 400
            textParts.push(`[tool_use ${block.name ?? 'unknown_tool'}] ${JSON.stringify(block.input ?? {})}`);
            notes.push('上游不支持工具：tool_use 已降级为文本');
            break;
          }
          toolCalls.push({
            id: block.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: block.name ?? 'unknown_tool',
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;
        case 'tool_result': {
          const resultText = toolResultToText(block.content) || '(empty tool result)';
          if (!toolsSupported || !block.tool_use_id) {
            // 没有配对 id（或上游不支持工具）时不能发 role:"tool"，否则上游 400
            textParts.push(`[tool_result ${block.tool_use_id ?? '(无 id)'}] ${resultText}`);
            notes.push('tool_result 缺少配对 id 或上游不支持工具：已降级为文本');
            break;
          }
          toolMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultText,
          });
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          // thinking 内容不回灌上游（上游没有对应的入站字段），仅记录一次
          sawThinking = true;
          break;
        default:
          if (block?.type) notes.push(`丢弃未知内容块类型：${block.type}`);
      }
    }
    if (sawThinking) notes.push('丢弃 assistant thinking 块（上游无对应入站字段）');

    if (toolMessages.length > 0) {
      // tool_result 必须先于同批用户文本，保证紧跟上一个 assistant.tool_calls
      for (const tm of toolMessages) messages.push(tm);
    }

    if (role === 'assistant') {
      if (textParts.length > 0 || imageParts.length > 0 || toolCalls.length > 0) {
        const assistantMessage = { role: 'assistant' };
        const combined = [];
        if (textParts.length > 0) combined.push({ type: 'text', text: textParts.join('\n\n') });
        if (imageParts.length > 0) combined.push(...imageParts);
        assistantMessage.content = combined.length > 0
          ? (combined.length === 1 && combined[0].type === 'text' ? combined[0].text : combined)
          : null;
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
        messages.push(assistantMessage);
      }
    } else {
      if (textParts.length > 0 || imageParts.length > 0) {
        const combined = [];
        if (textParts.length > 0) combined.push({ type: 'text', text: textParts.join('\n\n') });
        if (imageParts.length > 0) combined.push(...imageParts);
        messages.push({
          role: 'user',
          content: combined.length === 1 && combined[0].type === 'text' ? combined[0].text : combined,
        });
      }
    }
  }

  const body = {
    model: upstreamModel,
    messages,
    stream: request.stream === true,
  };

  const maxTokens = request.max_tokens;
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body[upstream.maxTokensField] = maxTokens;
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;
  if (typeof request.top_k === 'number' && request.top_k > 0 && dropUnsupported) {
    notes.push('丢弃 top_k（OpenAI Chat 无此参数）');
  }
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences;
  }

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    if (upstream.supportsTools) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }));
      const choice = toolChoiceToOpenAI(request.tool_choice);
      if (choice !== undefined) body.tool_choice = choice;
      if (upstream.supportsParallelTools === false) body.parallel_tool_calls = false;
    } else {
      notes.push(`丢弃 ${request.tools.length} 个工具定义（配置里关闭了工具支持）`);
    }
  }

  if (body.stream && upstream.sendStreamUsage) {
    body.stream_options = { include_usage: true };
  }

  if (upstream.supportsReasoningEffort) {
    const effort = reasoningEffortFrom(request);
    if (effort) body.reasoning_effort = effort;
  } else if (request?.output_config?.effort || request?.thinking) {
    notes.push('丢弃 effort/thinking（配置未开启 reasoning_effort 透传）');
  }

  for (const key of ['metadata', 'context_management', 'mcp_servers', 'container', 'output_format', 'output_config', 'thinking', 'anthropic_version']) {
    if (request?.[key] !== undefined && !notes.some((n) => n.includes(key))) {
      notes.push(`忽略 Claude 专有字段：${key}`);
    }
  }

  return { body, notes, upstreamModel };
}
