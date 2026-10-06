/**
 * 上游能力探测（**只走流式**）：把「你的 OpenAI 端点到底支持什么」测清楚，并给出 config.json 建议。
 *
 * 为什么只测流式：实测这类网关的非流式接口会静默返回空内容（200 空 message / 500
 * empty response content），而流式接口正常且带工具调用与 usage。本工具链也一律以流式调上游，
 * 因此这里只按其真实用法探测，避免把「非流式坏」误判成「不支持工具」。
 *
 * 两种入口：
 *  - 库：`runProbe(upstream, { model, deep })`（桌面控制台「一键探测」直接用这个）
 *  - CLI：`node src/probe.mjs [--config <path>] [--upstream <id>] [--model <id>]`
 * 绝不打印密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig, ConfigError } from './config.mjs';
import { configureLogging, log } from './log.mjs';

function parseArgs(argv) {
  const out = { config: null, upstream: null, model: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.config = argv[i + 1];
    else if (argv[i].startsWith('--config=')) out.config = argv[i].slice('--config='.length);
    else if (argv[i] === '--upstream') out.upstream = argv[i + 1];
    else if (argv[i] === '--model') out.model = argv[i + 1];
  }
  return out;
}

function shortError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? parsed?.message ?? String(text).slice(0, 200);
  } catch {
    return String(text ?? '').slice(0, 200);
  }
}

/** 一次性流式调用：可带工具与 effort，返回内容/工具调用/usage/推理片段。 */
export async function probeStream(upstream, model, { messages, tools, toolChoice, reasoningEffort, maxTokens = 128, label } = {}) {
  const body = {
    model,
    messages: messages ?? [{ role: 'user', content: '请只回答两个字：收到' }],
    stream: true,
    stream_options: { include_usage: true },
    [upstream.maxTokensField ?? 'max_tokens']: maxTokens,
  };
  if (tools) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${upstream.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${upstream.apiKey}`,
        accept: 'application/json',
        ...(upstream.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: shortError(await res.text()), label };
    }

    let chunks = 0;
    let content = '';
    let reasoning = '';
    let sawUsage = false;
    let usage = null;
    let finishReason = null;
    const toolCalls = new Map(); // index -> { id, name, arguments }
    let pending = '';
    const decoder = new TextDecoder();
    for await (const part of res.body) {
      pending += decoder.decode(part, { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        chunks += 1;
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.usage) { sawUsage = true; usage = parsed.usage; }
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta ?? {};
          if (typeof delta.content === 'string') content += delta.content;
          const r = delta.reasoning_content ?? delta.reasoning;
          if (typeof r === 'string') reasoning += r;
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const key = call.index ?? 0;
              const state = toolCalls.get(key) ?? { id: '', name: '', arguments: '' };
              if (call.id) state.id = call.id;
              if (typeof call.function?.name === 'string') state.name += call.function.name;
              if (typeof call.function?.arguments === 'string') state.arguments += call.function.arguments;
              toolCalls.set(key, state);
            }
          }
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        } catch {
          /* 忽略无法解析的分片 */
        }
      }
    }

    return {
      ok: chunks > 0,
      status: res.status,
      chunks,
      sawUsage,
      usage,
      content: content.slice(0, 80),
      reasoningChars: reasoning.length,
      finishReason,
      toolCalls: [...toolCalls.values()].map((c) => ({ name: c.name, arguments: c.arguments.slice(0, 160) })),
      label,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err.name === 'AbortError' ? '<超时>' : err.message,
      label,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(upstream) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${upstream.baseURL}/models`, {
      headers: { authorization: `Bearer ${upstream.apiKey}`, ...(upstream.extraHeaders ?? {}) },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, ids: [], error: shortError(await res.text()) };
    const body = await res.json();
    const ids = (body?.data ?? body?.models ?? []).map((m) => m?.id ?? m?.name).filter(Boolean);
    return { ok: true, status: res.status, ids };
  } catch (err) {
    return { ok: false, status: null, ids: [], error: err.name === 'AbortError' ? '<超时>' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市的当前天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

/**
 * 对某个上游跑一遍完整探测。
 * @param {object} upstream 归一化后的上游（含 baseURL / apiKey / maxTokensField / extraHeaders）
 * @param {{model: string, deep?: boolean}} options deep=false 时只测「模型列表 + 流式对话」
 * @returns {Promise<object>} 结构化报告（网络错误也返回对象，不抛错）
 */
export async function runProbe(upstream, { model, deep = true } = {}) {
  const report = {
    upstreamId: upstream.id ?? null,
    origin: (() => {
      try { return new URL(upstream.baseURL).origin; } catch { return upstream.baseURL; }
    })(),
    model,
    deep: !!deep,
    startedAt: new Date().toISOString(),
  };

  report.modelsEndpoint = await listModels(upstream);
  report.stream = await probeStream(upstream, model, {
    messages: [{ role: 'user', content: '用一句话解释蛋白质折叠。' }],
    maxTokens: 256,
    label: '流式对话',
  });

  if (deep) {
    report.tools = await probeStream(upstream, model, {
      messages: [{ role: 'user', content: '必须调用 get_weather 工具查询北京的天气，不要直接回答。' }],
      tools: [WEATHER_TOOL],
      toolChoice: 'auto',
      maxTokens: 256,
      label: '工具调用',
    });
    report.reasoningEffort = await probeStream(upstream, model, {
      messages: [{ role: 'user', content: '用一句话解释蛋白质折叠。' }],
      reasoningEffort: 'high',
      maxTokens: 256,
      label: 'effort',
    });
  }

  const calledTools = report.tools?.toolCalls ?? [];
  const suggestions = {};
  if (deep && report.tools && calledTools.length === 0) suggestions.supportsTools = false;
  if (report.stream?.ok && !report.stream.sawUsage) suggestions.sendStreamUsage = false;
  if (report.reasoningEffort?.ok) suggestions.supportsReasoningEffort = true;

  report.suggestions = suggestions;
  report.ok = !!report.stream?.ok;
  report.finishedAt = new Date().toISOString();
  return report;
}

// MARK: - CLI

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
  configureLogging({ level: 'error', dir: null });

  const upstream = args.upstream ? cfg.upstreamById.get(args.upstream) : cfg.upstream;
  if (!upstream) {
    console.error(`未知上游：${args.upstream}（可用：${[...cfg.upstreamById.keys()].join(', ')}）`);
    process.exit(2);
  }
  const model = args.model ?? cfg.defaultModel;

  console.log('=== 上游能力探测（只走流式）===');
  console.log(JSON.stringify(describeConfig(cfg), null, 2));
  console.log('');

  const report = await runProbe(upstream, { model, deep: true });

  console.log(`[1/4] GET /models → ${report.modelsEndpoint.ok
    ? `OK，${report.modelsEndpoint.ids.length} 个模型`
    : `失败：${report.modelsEndpoint.status ?? ''} ${report.modelsEndpoint.error ?? ''}`}`);
  if (report.modelsEndpoint.ok && !report.modelsEndpoint.ids.includes(model)) {
    console.log(`      ⚠ 配置模型 "${model}" 不在上游 /models 列表里（套餐别名常如此；只要对话能通就没问题）`);
  }

  console.log(`[2/4] 流式对话 → ${report.stream.ok
    ? `OK（${report.stream.chunks} 片，include_usage=${report.stream.sawUsage}，think 片段 ${report.stream.reasoningChars} 字）`
    : `失败：${report.stream.status ?? ''} ${report.stream.error ?? ''}`}`);
  if (report.stream.ok && report.stream.content) console.log(`      回复片段：${report.stream.content}`);

  const calledTools = report.tools?.toolCalls ?? [];
  console.log(`[3/4] 工具调用（流式）→ ${calledTools.length > 0
    ? `OK：${JSON.stringify(calledTools)}`
    : `未观察到 tool_calls（status=${report.tools?.status ?? ''} finish=${report.tools?.finishReason ?? '-'}）`}`);
  if (calledTools.length === 0 && report.tools?.content) {
    console.log(`      模型改用文本回答：${report.tools.content.slice(0, 80)}`);
  }

  console.log(`[4/4] reasoning_effort=high（流式）→ ${report.reasoningEffort?.ok
    ? 'OK（可开启 supportsReasoningEffort）'
    : `上游不接受：${report.reasoningEffort?.status ?? ''} ${report.reasoningEffort?.error ?? ''}`}`);

  console.log('\n=== 建议写回 config.json 的字段 ===');
  console.log(JSON.stringify(report.suggestions, null, 2));
  if (Object.keys(report.suggestions).length === 0) console.log('（默认配置已适配，无需修改）');

  const reportPath = path.join(process.env.PI_SCRATCH_DIR ?? '.', 'probe-report.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n完整报告：${reportPath}`);
  } catch (err) {
    log.warn(`写报告失败：${err.message}`);
  }

  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`探测异常：${err.stack ?? err.message}`);
    process.exit(1);
  });
}
