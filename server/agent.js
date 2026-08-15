import { GoogleGenAI } from '@google/genai';
import { toolRegistry, executeTool } from './tools/index.js';

const MAX_AGENT_ITERATIONS = 8;

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

    const text = response.text || 'Sorry, I was unable to process your request at this time.';
    await streamText(text, onToken);
    return text;
  }
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

/** Extracts a retry delay (ms) from a Gemini ApiError's RetryInfo detail, if any. */
function retryDelayMs(err) {
  const retryInfo = err?.details?.find?.((d) => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const seconds = Number(retryInfo?.retryDelay?.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Re-throws an ApiError as a friendly Error with a useful, non-sensitive message. */
function toFriendlyError(err) {
  const status = err?.status ?? err?.code;
  const message = err?.message ?? String(err);
  if (status === 429) {
    const quota = message.includes('quota') || message.includes('RESOURCE_EXHAUSTED');
    return friendlyError(
      quota
        ? 'The AI service quota for this project is exhausted for today. Please try again later or check your Gemini API billing.'
        : 'The AI service is rate-limiting requests. Please try again in a moment.'
    );
  }
  if ((status === 400 || status === 404) && message.includes('not found')) {
    return friendlyError(`The configured Gemini model is unavailable: ${message.split('\n')[0]}`);
  }
  return err;
}

function friendlyError(message) {
  const err = new Error(message);
  err.friendly = true;
  return err;
}
