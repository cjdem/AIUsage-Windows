/**
 * 推理代理（默认 127.0.0.1:14402）：对 Science 假装自己是 Anthropic API，对上游是 OpenAI Chat。
 *
 * 端点：
 *   POST /v1/messages               Anthropic Messages（流式/非流式）
 *   POST /v1/messages/count_tokens  本地启发式估算（上游无此能力）
 *   GET  /v1/models                 Science 模型选择器的数据源（发布 Claude 形状 ID）
 *   GET  /v1/models/:id             单模型查询
 *   GET  /health                    自检（供启动脚本轮询）
 *
 * 安全：只监听回环；入站 Authorization / x-api-key 一律剥离不转发；真实上游 key 只在本进程内存里。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { loadConfig, describeConfig, ConfigError } from './config.mjs';
import { configureLogging, log, safeHeaders } from './log.mjs';
import { createModelMap, anthropicModelsPayload, stripContextSuffix } from './model-map.mjs';
import { buildOpenAIRequest } from './anthropic-to-openai.mjs';
import {
  AnthropicStreamTranslator,
  mapUpstreamError,
  newMessageId,
  OpenAIStreamAccumulator,
  toAnthropicResponse,
} from './openai-to-anthropic.mjs';
import { createAnalyticsStore, extractCost } from './analytics-store.mjs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
  const out = { config: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.config = argv[i + 1];
    else if (argv[i].startsWith('--config=')) out.config = argv[i].slice('--config='.length);
  }
  return out;
}

export function createInferenceServer(cfg, { modelMap = createModelMap(cfg), analytics = null } = {}) {
  /** 每个上游有自己的密钥与额外头：按本次请求解析出的上游构造。 */
  const upstreamHeaders = (upstream) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${upstream.apiKey}`,
    accept: 'application/json',
    ...upstream.extraHeaders,
  });

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'request-id': `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    });
    res.end(body);
  }

  function sendAnthropicError(res, status, type, message) {
    sendJson(res, status, { type: 'error', error: { type, message } });
  }

  async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`);
        err.code = 'too_large';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** 本地 token 估算：对齐 Claude 侧字符数/4 的启发式，够 Science 的预算提示用。 */
  function estimateTokens(request) {
    let chars = 0;
    const system = request?.system;
    if (typeof system === 'string') chars += system.length;
    else if (Array.isArray(system)) {
      for (const b of system) chars += typeof b === 'string' ? b.length : (b?.text?.length ?? 0);
    }
    for (const message of request?.messages ?? []) {
      const content = message?.content;
      if (typeof content === 'string') chars += content.length;
      else if (Array.isArray(content)) {
        for (const block of content) {
          switch (block?.type) {
            case 'text':
              chars += (block.text ?? '').length;
              break;
            case 'tool_use':
              chars += JSON.stringify(block.input ?? {}).length + (block.name ?? '').length + 50;
              break;
            case 'tool_result': {
              const c = block.content;
              if (typeof c === 'string') chars += c.length;
              else if (Array.isArray(c)) {
                for (const inner of c) {
                  if (inner?.type === 'image') chars += 4000;
                  else chars += (inner?.text?.length ?? 0);
                }
              }
              break;
            }
            case 'image':
              chars += 4000;
              break;
            case 'document':
              chars += 8000;
              break;
            case 'thinking':
              chars += (block.thinking ?? '').length;
              break;
            default:
              chars += 100;
          }
        }
      }
    }
    for (const tool of request?.tools ?? []) {
      chars += (tool?.name?.length ?? 0) + (tool?.description?.length ?? 0) + 100;
    }
    return Math.max(1, Math.round(chars / 4));
  }

  /** 把上游 SSE 逐行解析成 OpenAI chunk 对象。 */
  function createSSEParser(onChunk) {
    let buffer = '';
    return {
      feed(text) {
        buffer += text;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line === '' || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            onChunk(JSON.parse(payload));
          } catch (err) {
            log.warn(`上游 SSE 不是合法 JSON，已跳过一片：${err.message}`);
          }
        }
      },
      flush() {
        const rest = buffer.trim();
        buffer = '';
        if (rest.startsWith('data:')) {
          const payload = rest.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              onChunk(JSON.parse(payload));
            } catch {
              /* 忽略尾部残片 */
            }
          }
        }
      },
    };
  }

  async function handleMessages(req, res, rawBody) {
    const startedAt = Date.now();
    let request;
    try {
      request = JSON.parse(rawBody);
    } catch (err) {
      return sendAnthropicError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${err.message}`);
    }

    let resolved;
    try {
      resolved = modelMap.resolve(request?.model);
    } catch {
      return sendAnthropicError(
        res,
        404,
        'not_found_error',
        `模型 "${request?.model}" 不在本地目录里；可用：${cfg.models.map((m) => m.publishAs).join(', ')}`,
      );
    }

    const publicModel = resolved.entry.publishAs;
    const upstream = resolved.upstream ?? cfg.upstream;
    const { body: openaiBody, notes } = buildOpenAIRequest({
      request,
      upstreamModel: resolved.upstreamModel,
      upstream,
    });

    for (const note of notes) log.debug(`转换说明：${note}`);
    log.info(
      `→ POST /v1/messages model=${stripContextSuffix(request?.model)} → ${resolved.upstreamModel}`
      + ` (${resolved.matchedBy}) upstream=${upstream.id} stream=${openaiBody.stream}`
      + ` msgs=${openaiBody.messages.length} tools=${openaiBody.tools?.length ?? 0}`,
    );

    // 调用记录（阶段 3）：上游原始 usage 里才有成本字段，所以单独留一份
    let upstreamUsage = null;
    let toolCallCount = 0;
    let upstreamHttpStatus = null;
    const callStartedAt = Date.now();
    const baseCall = () => ({
      model: publicModel,
      upstreamModel: resolved.upstreamModel,
      upstreamId: upstream.id,
      matchedBy: resolved.matchedBy,
      tier: resolved.tier ?? null,
      messages: openaiBody.messages.length,
      tools: openaiBody.tools?.length ?? 0,
    });
    /** 记录一次调用；写失败只降级，绝不影响推理。 */
    const recordCall = (extra = {}) => {
      if (!analytics) return;
      const cost = extractCost(upstreamUsage);
      try {
        analytics.record({ ...baseCall(), ...cost, upstreamHttpStatus, ...extra });
      } catch (err) {
        log.warn(`调用记录写入失败（已忽略）：${err.message}`);
      }
    };

    // 上游只走流式：实测该网关的非流式接口会静默返回空内容（200 空 message / 500
    // empty response content），而流式接口正常且带工具调用与 usage。因此这里**始终**
    // 以 stream:true 发起请求；客户端若要非流式，由本地把分片聚合成一次性 JSON 返回。
    const upstreamBody = {
      ...openaiBody,
      stream: true,
      ...(upstream.sendStreamUsage ? { stream_options: { include_usage: true } } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstream.timeoutMs);

    let upstreamRes;
    try {
      upstreamRes = await fetch(`${upstream.baseURL}/chat/completions`, {
        method: 'POST',
        headers: upstreamHeaders(upstream),
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const reason = err.name === 'AbortError' ? `上游超时（${upstream.timeoutMs}ms）` : err.message;
      log.error(`上游不可达：${reason}`);
      recordCall({ ok: false, stream: false, ms: Date.now() - callStartedAt, error: `上游不可达：${reason}` });
      return sendAnthropicError(res, 502, 'api_error', `无法连接上游：${reason}`);
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      clearTimeout(timeout);
      const mapped = mapUpstreamError(upstreamRes.status, text);
      upstreamHttpStatus = upstreamRes.status;
      log.error(`上游 HTTP ${upstreamRes.status}：${mapped.body.error.message.slice(0, 300)}`);
      recordCall({
        ok: false,
        stream: false,
        ms: Date.now() - callStartedAt,
        error: `上游 HTTP ${upstreamRes.status}：${mapped.body.error.message.slice(0, 200)}`,
      });
      return sendJson(res, mapped.status, mapped.body);
    }

    const upstreamContentType = String(upstreamRes.headers.get('content-type') ?? '').toLowerCase();
    const upstreamLooksJSON = upstreamContentType.includes('application/json');

    if (upstreamLooksJSON) {
      // 防御性分支：网关忽略了 stream:true 却回了普通 JSON —— 这里照 JSON 解析，
      // 而不是把 SSE 解析器空跑一遍产出空回复。
      let text;
      try {
        text = await upstreamRes.text();
      } finally {
        clearTimeout(timeout);
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        log.error(`上游 200 但正文既非流式也非 JSON（${text.length} 字节）：${text.slice(0, 200)}`);
        recordCall({ ok: false, stream: false, ms: Date.now() - callStartedAt, error: '上游 200 但响应无法解析（正文既非 SSE 也非 JSON）' });
        return sendAnthropicError(
          res,
          502,
          'api_error',
          `上游 200 但响应无法解析（content-type=${upstreamContentType || '空'}，前 200 字节：${text.slice(0, 200)}）`,
        );
      }
      const response = toAnthropicResponse({
        openaiResponse: json,
        publicModel,
        messageId: newMessageId(),
      });
      upstreamUsage = json?.usage ?? null;
      upstreamHttpStatus = upstreamRes.status;
      toolCallCount = response.content.filter((block) => block.type === 'tool_use').length;
      const empty = response.content.every((b) => b.type === 'text' && b.text === '')
        && (response.content.length > 0);
      if (empty) {
        log.warn(`上游返回了空内容（model=${resolved.upstreamModel}）——该端点非流式接口可能不可用，`
          + '本代理已按流式请求上游；若持续出现请检查该上游网关。');
      }
      log.info(
        `← 200 model=${publicModel} stop=${response.stop_reason}`
        + ` in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
        + ` ${Date.now() - startedAt}ms`,
      );
      recordCall({
        ok: true,
        stream: false,
        ms: Date.now() - callStartedAt,
        inTokens: response.usage.input_tokens,
        outTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        toolCallCount,
        stopReason: response.stop_reason,
      });
      return sendJson(res, 200, response);
    }

    // 先窥探首片：网关忽略 stream 时正文是 JSON 而不是 SSE，必须据此分流
    const decoder = new TextDecoder();
    const iterator = upstreamRes.body[Symbol.asyncIterator]();
    let head = '';
    let firstValue = null;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      head += decoder.decode(next.value, { stream: true });
      firstValue = next.value;
      if (head.trim().length > 0) break;
    }
    const looksLikeSSE = /^(?:data:|event:|:)/.test(head.trimStart());
    upstreamHttpStatus = upstreamRes.status;


    if (looksLikeSSE && !openaiBody.stream) {
      // 客户端要非流式，而上游给的是流：本地聚合后一次性返回完整 Anthropic 消息。
      const accumulator = new OpenAIStreamAccumulator();
      const aggregateParser = createSSEParser((chunk) => {
        if (chunk?.usage) upstreamUsage = chunk.usage;
        accumulator.push(chunk);
      });
      aggregateParser.feed(head);
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          aggregateParser.feed(decoder.decode(next.value, { stream: true }));
        }
        aggregateParser.flush();
      } catch (err) {
        clearTimeout(timeout);
        log.error(`聚合上游流失败：${err.message}`);
        return sendAnthropicError(res, 502, 'api_error', `上游流式中断：${err.message}`);
      }
      clearTimeout(timeout);
      const response = accumulator.toAnthropicResponse({ publicModel, messageId: newMessageId() });
      toolCallCount = response.content.filter((block) => block.type === 'tool_use').length;
      log.info(
        `← 200 (aggregated) model=${publicModel} stop=${response.stop_reason}`
        + ` in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
        + ` ${Date.now() - startedAt}ms`,
      );
      recordCall({
        ok: true,
        stream: false,
        aggregated: true,
        ms: Date.now() - callStartedAt,
        inTokens: response.usage.input_tokens,
        outTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        toolCallCount,
        stopReason: response.stop_reason,
      });
      return sendJson(res, 200, response);
    }
    if (head.trim() === '' || (!looksLikeSSE && firstValue)) {
      // 把已读到的首片 + 剩余正文一起当 JSON 处理
      let text = head;
      try {
        for await (const part of { [Symbol.asyncIterator]: () => iterator }) {
          text += decoder.decode(part, { stream: true });
        }
      } catch (err) {
        clearTimeout(timeout);
        log.error(`读取上游正文失败：${err.message}`);
        return sendAnthropicError(res, 502, 'api_error', `读取上游正文失败：${err.message}`);
      }
      clearTimeout(timeout);
      try {
        const json = JSON.parse(text);
        const response = toAnthropicResponse({ openaiResponse: json, publicModel, messageId: newMessageId() });
        upstreamUsage = json?.usage ?? null;
        toolCallCount = response.content.filter((block) => block.type === 'tool_use').length;
        log.info(
          `← 200 (json-fallback) model=${publicModel} stop=${response.stop_reason}`
          + ` in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
          + ` ${Date.now() - startedAt}ms`,
        );
        recordCall({
          ok: true,
          stream: false,
          ms: Date.now() - callStartedAt,
          inTokens: response.usage.input_tokens,
          outTokens: response.usage.output_tokens,
          toolCallCount,
          stopReason: response.stop_reason,
        });
        return sendJson(res, 200, response);
      } catch (err) {
        log.error(`上游 200 但正文非 SSE 也非 JSON（前 200 字节）：${text.slice(0, 200)}`);
        recordCall({ ok: false, stream: false, ms: Date.now() - callStartedAt, error: '上游返回了无法识别的正文' });
        return sendAnthropicError(
          res,
          502,
          'api_error',
          `上游返回了无法识别的正文（前 200 字节：${text.slice(0, 200)}）`,
        );
      }
    }

    // 流式：把上游 SSE 翻译成 Anthropic SSE
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'request-id': `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    });

    const translator = new AnthropicStreamTranslator({ publicModel });
    let firstDeltaAt = null;
    let outputChars = 0;
    let failed = false;

    const streamEvents = [];
    // 客户端断开时立刻取消上游，避免对端继续生成到超时
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });
    const writeEvent = async ({ event, data }) => {
      if (clientGone || res.destroyed) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!res.write(frame)) {
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
    };

    const parser = createSSEParser((chunk) => {
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
      if (chunk?.usage) upstreamUsage = chunk.usage;
      const delta = chunk?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') outputChars += delta.content.length;
      const events = translator.push(chunk);
      for (const evt of events) {
        if (evt.event === 'content_block_start' && evt.data?.content_block?.type === 'tool_use') {
          toolCallCount += 1;
        }
      }
      streamEvents.push(...events);
    });
    const drainEvents = async () => {
      while (streamEvents.length > 0) {
        await writeEvent(streamEvents.shift());
      }
    };

    try {
      parser.feed(head);
      await drainEvents();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        parser.feed(decoder.decode(next.value, { stream: true }));
        await drainEvents();
      }
      parser.flush();
      await drainEvents();
      translator.setOutputTokens(translator.usage.output_tokens || Math.max(1, Math.round(outputChars / 4)));
      for (const event of translator.finish()) await writeEvent(event);
    } catch (err) {
      if (clientGone) {
        log.info('客户端已断开，已取消上游流');
      } else {
        failed = true;
        const reason = err.name === 'AbortError' ? `上游流式超时（${upstream.timeoutMs}ms）` : err.message;
        log.error(`流式中断：${reason}`);
        recordCall({
          ok: false,
          stream: true,
          ms: Date.now() - callStartedAt,
          ttftMs: firstDeltaAt ? firstDeltaAt - callStartedAt : null,
          error: `上游流式中断：${reason}`,
        });
        await writeEvent({
          event: 'error',
          data: { type: 'error', error: { type: 'api_error', message: `上游流式中断：${reason}` } },
        });
      }
    } finally {
      clearTimeout(timeout);
      if (!res.writableEnded) res.end();
      if (!failed && !clientGone) {
        log.info(
          `← 200 stream model=${publicModel} stop=${translator.stopReason ?? 'end_turn'}`
          + ` in=${translator.usage.input_tokens} out=${translator.usage.output_tokens}`
          + ` ttft=${firstDeltaAt ? firstDeltaAt - startedAt : '-'}ms ${Date.now() - startedAt}ms`,
        );
        recordCall({
          ok: true,
          stream: true,
          ms: Date.now() - callStartedAt,
          ttftMs: firstDeltaAt ? firstDeltaAt - callStartedAt : null,
          inTokens: translator.usage.input_tokens,
          outTokens: translator.usage.output_tokens,
          cacheReadTokens: translator.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: translator.usage.cache_creation_input_tokens ?? 0,
          toolCallCount,
          stopReason: translator.stopReason ?? 'end_turn',
        });
      } else if (clientGone) {
        recordCall({
          ok: true,
          stream: true,
          clientDisconnected: true,
          ms: Date.now() - callStartedAt,
          ttftMs: firstDeltaAt ? firstDeltaAt - callStartedAt : null,
          toolCallCount,
        });
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    log.debug(`收到 ${req.method} ${path} headers=${JSON.stringify(safeHeaders(req.headers))}`);

    try {
      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          models: cfg.models.map((m) => m.publishAs),
          upstreams: cfg.upstreams.map((u) => `${u.id}:${u.baseURL}`),
        });
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 1000);
        const payload = anthropicModelsPayload(cfg.models);
        return sendJson(res, 200, { ...payload, data: payload.data.slice(0, limit) });
      }

      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        const id = decodeURIComponent(path.slice('/v1/models/'.length));
        const entry = cfg.models.find((m) => m.publishAs === id || m.id === id);
        if (!entry) return sendAnthropicError(res, 404, 'not_found_error', `未知模型：${id}`);
        return sendJson(res, 200, {
          type: 'model',
          id: entry.publishAs,
          display_name: entry.displayName,
          created_at: '1970-01-01T00:00:00Z',
        });
      }

      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          return sendAnthropicError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${err.message}`);
        }
        const tokens = estimateTokens(parsed);
        log.debug(`count_tokens → ${tokens}`);
        return sendJson(res, 200, { input_tokens: tokens });
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        const raw = await readBody(req);
        return await handleMessages(req, res, raw);
      }

      // 其它 Anthropic 端点（organizations/usage/oauth 等）本地一律 404，
      // 让 Science 走它自己的降级路径，同时留下一条线索便于按需补齐。
      log.info(`未实现的端点 ${req.method} ${path} → 404（如属 Science 必需功能，请补实现）`);
      return sendAnthropicError(res, 404, 'not_found_error', `本代理未实现 ${req.method} ${path}`);
    } catch (err) {
      if (err?.code === 'too_large') {
        return sendAnthropicError(res, 413, 'request_too_large', err.message);
      }
      log.error(`处理 ${req.method} ${path} 失败：${err.stack ?? err.message}`);
      if (!res.headersSent) {
        return sendAnthropicError(res, 500, 'api_error', err.message);
      }
      res.end();
    }
  });

  return { server, modelMap };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cfg;
  try {
    cfg = loadConfig(args.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`配置错误：${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  configureLogging({ level: cfg.logging.level, dir: cfg.logging.dir, fileName: 'inference.log' });
  log.info('推理代理启动中', describeConfig(cfg));

  const analytics = createAnalyticsStore({ dir: cfg.logging.dir });
  const { server } = createInferenceServer(cfg, { analytics });
  server.listen(cfg.ports.inference, '127.0.0.1', () => {
    log.info(`推理代理已监听 http://127.0.0.1:${cfg.ports.inference}（Science 的 ANTHROPIC_BASE_URL 指向这里）`);
    log.info(`对外发布模型：${cfg.models.map((m) => `${m.publishAs}(→${m.id})`).join(', ')}`);
  });
  server.on('error', (err) => {
    log.error(`推理代理监听失败：${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    log.info('收到退出信号，关闭推理代理');
    server.close(() => {
      log.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 只有被直接执行时才启动监听（被测试 import 时保持安静）。
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
