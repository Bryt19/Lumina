import { GoogleGenAI } from '@google/genai';
import { toolRegistry, executeTool } from './tools/index.js';

const MAX_AGENT_ITERATIONS = 8;

const FALLBACK_ANSWER = 'Sorry, I was unable to process your request at this time.';

/**
 * Identity + behavior instructions shared by every provider. Lumina is this
 * assistant's brand name, so the model must refer to itself as Lumina in its
 * replies instead of as a generic assistant.
 */
export const SYSTEM_PROMPT =
  'You are Lumina, the AI customer support assistant for Lumina Support. ' +
  'Help customers with their orders, refunds, tickets, and policy questions using the available tools, ' +
  'and offer to escalate to a human agent when you cannot resolve an issue. ' +
  'Always refer to yourself as "Lumina" (for example "I\u2019m Lumina, your support assistant") and never as ' +
  '"the AI", "the assistant", or any other generic name. ' +
  'Keep replies concise, friendly, and grounded in tool results and policy text.';

/**
 * Owns the Gemini session and runs the agentic loop:
 *   user message -> model -> function calls -> execute tools -> feed results back -> repeat
 * until the model produces a final text answer, which is streamed via onToken.
 */
export class AgentOrchestrator {
  constructor({ apiKey, model = 'gemini-3.5-flash' }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async run({ customerId, customer, history = [], userMessage, onToken, onTool }) {
    // Seed the session with the persisted conversation. Roles MUST alternate
    // user/model — replaying turns via sendMessage() would label the assistant's
    // own past replies as user messages and corrupt the model's context.
    const chat = this.ai.chats.create({
      model: this.model,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: toolRegistry.map((t) => t.declaration) }],
      },
      history: toHistoryContents(history),
    });

    let response = await withRetry(() => chat.sendMessage({ message: userMessage }));

    for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
      if (!response.functionCalls || response.functionCalls.length === 0) {
        break;
      }

      const parts = [];
      for (const fn of response.functionCalls) {
        onTool?.(fn.name, fn.args);
        const result = await executeTool(fn.name, fn.args, { customerId, customer });
        parts.push({ functionResponse: { name: fn.name, response: result } });
      }

      response = await withRetry(() => chat.sendMessage({ message: parts }));
    }

    const text = response.text || FALLBACK_ANSWER;
    await streamText(text, onToken);
    return text;
  }
}

/**
 * Generic OpenAI-compatible gateway agent (OpenRouter, BazaarLink, ...).
 * Implements the same run() contract as AgentOrchestrator but talks to a
 * chat/completions endpoint with plain fetch (global in Node 22+), so no SDK
 * dependency is needed.
 *
 * @param {string} envPrefix Prefix for the provider's env vars, e.g.
 *   'OPENROUTER' reads OPENROUTER_SITE_URL / OPENROUTER_MAX_TOKENS.
 */
export class OpenAICompatAgent {
  constructor({ apiKey, model = 'openai/gpt-4o', baseUrl, label = 'OpenAI-compatible API', envPrefix = 'OPENROUTER' }) {
    if (!apiKey) throw new Error(`${label} requires an apiKey.`);
    if (!baseUrl) throw new Error(`${label} requires a baseUrl.`);
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.label = label;
    this.envPrefix = envPrefix;
  }

  async run({ customerId, customer, history = [], userMessage, onToken, onTool }) {
    const messages = buildOpenAIMessages(history, userMessage);
    const tools = toOpenAITools(toolRegistry);

    let response = await withRetry(() => this.complete(messages, tools));

    for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
      const message = response.choices?.[0]?.message ?? {};

      if (!message.tool_calls || message.tool_calls.length === 0) {
        const text = message.content || FALLBACK_ANSWER;
        await streamText(text, onToken);
        return text;
      }

      // Feed the assistant's tool calls back, then append each tool result
      // (OpenAI format: role 'tool' with the matching tool_call_id).
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const args = parseToolArgs(call.function?.arguments);
        onTool?.(call.function?.name, args);
        const result = await executeTool(call.function?.name, args, { customerId, customer });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }

      response = await withRetry(() => this.complete(messages, tools));
    }

    await streamText(FALLBACK_ANSWER, onToken);
    return FALLBACK_ANSWER;
  }

  async complete(messages, tools) {
    const env = (name) => process.env[`${this.envPrefix}_${name}`];
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        // Gateways use these headers to attribute the app on their dashboards.
        'HTTP-Referer': env('SITE_URL') || 'https://example.com',
        'X-Title': env('SITE_NAME') || 'Lumina Support',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        tool_choice: 'auto',
        // Support replies are short; cap max_tokens so free/low-credit
        // accounts aren't rejected (defaults can exceed their cap).
        max_tokens: Number(env('MAX_TOKENS')) || 1024,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message ?? '';
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(`${this.label} API error (${res.status})${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      // OpenAI-compatible APIs signal backoff via Retry-After (seconds).
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    return res.json();
  }
}

/**
 * Tries a list of agents in order. When the primary agent fails with a
 * quota/rate-limit/credit/server error, the next provider takes over — e.g.
 * Gemini free-tier quota exhausted -> OpenRouter. Both agents implement the
 * same run() contract, so the caller (and its SSE callbacks) is unaffected.
 */
export class FallbackAgent {
  constructor({ agents }) {
    this.agents = agents.filter(Boolean);
    if (this.agents.length === 0) throw new Error('FallbackAgent requires at least one agent.');
  }

  get model() {
    return this.agents[0].model;
  }

  async run(args) {
    for (let i = 0; i < this.agents.length; i++) {
      try {
        return await this.agents[i].run(args);
      } catch (err) {
        const isLast = i === this.agents.length - 1;
        if (isLast || !shouldFallback(err)) throw err;
        console.warn(
          `[agent] ${this.agents[i].constructor.name} unavailable (${err?.status ?? err?.message}); ` +
            `falling back to ${this.agents[i + 1].constructor.name}`
        );
      }
    }
  }
}

/**
 * Failures worth retrying on a different provider: rate limits (429), quota
 * exhaustion / insufficient credits (429/402), and transient server errors
 * (500/503). Auth and validation errors are provider-specific and would just
 * fail again on another provider.
 */
export function shouldFallback(err) {
  const status = err?.status ?? err?.code;
  return status === 429 || status === 402 || status === 500 || status === 503;
}

/**
 * Maps persisted conversation turns ({role: 'user'|'assistant', content}) to
 * Gemini Content parts with proper user/model roles. Without this mapping the
 * assistant's own replies would be replayed as user turns, corrupting context.
 */
export function toHistoryContents(history) {
  return (history ?? []).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
}

/** Maps persisted conversation turns to OpenAI-style messages for OpenRouter. */
export function toOpenAIMessages(history) {
  return (history ?? []).map((turn) => ({
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.content,
  }));
}

/**
 * Builds the full OpenAI-compatible message list: the Lumina system prompt,
 * then the persisted history, then the new user message.
 */
export function buildOpenAIMessages(history, userMessage) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...toOpenAIMessages(history),
    { role: 'user', content: userMessage },
  ];
}

// Gemini declarations use UPPERCASE type names; OpenAI tools use JSON Schema's
// lowercase names (e.g. 'OBJECT' -> 'object').
const OPENAI_TYPE_MAP = {
  STRING: 'string',
  INTEGER: 'integer',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
};

/** Recursively converts a Gemini-style schema to a JSON Schema (OpenAI format). */
export function toOpenAISchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = OPENAI_TYPE_MAP[value] ?? value.toLowerCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [name, propSchema] of Object.entries(value)) {
        out.properties[name] = toOpenAISchema(propSchema);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Converts the shared tool registry into OpenAI-format function tools. */
export function toOpenAITools(registry = toolRegistry) {
  return registry.map((t) => ({
    type: 'function',
    function: {
      name: t.declaration.name,
      description: t.declaration.description,
      parameters: toOpenAISchema(t.declaration.parameters),
    },
  }));
}

/** Parses the JSON-string `arguments` payload of an OpenAI tool call. */
function parseToolArgs(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function streamText(text, onToken) {
  if (!onToken) return;
  // Relay the final answer in small chunks so the client can render incrementally.
  const CHUNK = 24;
  for (let i = 0; i < text.length; i += CHUNK) {
    onToken(text.slice(i, i + CHUNK));
    await new Promise((r) => setTimeout(r, 15));
  }
}

/**
 * Retries transient Gemini API failures (rate limits, 5xx) with backoff.
 * When the API includes a RetryInfo retryDelay (e.g. per-minute rate limits),
 * that delay is honored instead of the fixed schedule.
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 2000, maxDelayMs = 60_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.code;
      const retriable = status === 429 || status === 500 || status === 503;
      const suggested = retryDelayMs(err);
      // A long server-suggested delay means daily-quota exhaustion, which will
      // not recover in seconds — fail fast with a friendly message instead of
      // burning through the retries.
      if (suggested !== null && suggested > 30_000) throw toFriendlyError(err);
      if (!retriable || attempt >= attempts) throw toFriendlyError(err);

      // Honor the server's suggested retry delay when provided (bounded).
      const delay = Math.min(suggested ?? baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[agent] transient API error (${status}), retrying in ${delay}ms (${attempt}/${attempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Extracts a retry delay (ms) from an API error, if one is suggested. */
function retryDelayMs(err) {
  // OpenRouter/OpenAI-compatible APIs signal backoff via Retry-After (seconds).
  if (err?.retryAfterMs) return err.retryAfterMs;
  // Gemini signals it via a RetryInfo detail on the ApiError.
  const retryInfo = err?.details?.find?.((d) => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const seconds = Number(retryInfo?.retryDelay?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Re-throws an ApiError as a friendly Error with a useful, non-sensitive message. */
export function toFriendlyError(err) {
  const status = err?.status ?? err?.code;
  const message = err?.message ?? String(err);
  if (status === 429) {
    const quota = message.includes('quota') || message.includes('RESOURCE_EXHAUSTED');
    return friendlyError(
      quota
        ? 'The AI service quota for this project is exhausted for today. Please try again later or check your provider\'s billing.'
        : 'The AI service is rate-limiting requests. Please try again in a moment.',
      status
    );
  }
  if (status === 402) {
    return friendlyError(
      'The AI provider rejected the request because the account has insufficient credits. ' +
        'Please top up the account and try again.',
      status
    );
  }
  if ((status === 400 || status === 404) && message.includes('not found')) {
    return friendlyError(`The configured AI model is unavailable: ${message.split('\n')[0]}`, status);
  }
  return err;
}

/** Friendly errors keep their HTTP status so callers (e.g. FallbackAgent) can react. */
function friendlyError(message, status) {
  const err = new Error(message);
  err.friendly = true;
  if (status) err.status = status;
  return err;
}
