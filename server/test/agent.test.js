// Use a fresh in-memory DB so importing agent.js (which imports db.js via the
// tool registry) never touches the dev database. Dynamic imports ensure this
// env var is set before db.js is evaluated.
process.env.DB_PATH = ':memory:';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  toHistoryContents,
  toOpenAIMessages,
  buildOpenAIMessages,
  toOpenAISchema,
  toOpenAITools,
  FallbackAgent,
  shouldFallback,
  toFriendlyError,
  OpenAICompatAgent,
  SYSTEM_PROMPT,
} = await import('../agent.js');

test('toHistoryContents maps user turns to user role', () => {
  const contents = toHistoryContents([{ role: 'user', content: 'Where is my order?' }]);
  assert.equal(contents[0].role, 'user');
  assert.deepEqual(contents[0].parts, [{ text: 'Where is my order?' }]);
});

test('toHistoryContents maps assistant turns to model role (never replayed as user)', () => {
  const history = [
    { role: 'user', content: 'Where is my order ORD-1001?' },
    { role: 'assistant', content: 'Your order ORD-1001 has shipped.' },
  ];
  const contents = toHistoryContents(history);
  assert.deepEqual(
    contents.map((c) => c.role),
    ['user', 'model']
  );
  assert.equal(contents[1].parts[0].text, 'Your order ORD-1001 has shipped.');
});

test('toHistoryContents handles empty and unknown-role turns safely', () => {
  assert.deepEqual(toHistoryContents([]), []);
  const contents = toHistoryContents([{ content: 'no role given' }]);
  assert.equal(contents[0].role, 'user');
});

test('buildOpenAIMessages leads with the Lumina system prompt', () => {
  const messages = buildOpenAIMessages([{ role: 'user', content: 'Where is my order?' }], 'ORD-1001?');
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('Lumina'));
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.deepEqual(messages[1], { role: 'user', content: 'Where is my order?' });
  assert.deepEqual(messages[2], { role: 'user', content: 'ORD-1001?' });
  assert.equal(messages.length, 3);
});

test('toOpenAIMessages maps persisted turns to OpenAI roles', () => {
  const history = [
    { role: 'user', content: 'Where is my order?' },
    { role: 'assistant', content: 'Your order ORD-1001 has shipped.' },
  ];
  assert.deepEqual(toOpenAIMessages(history), [
    { role: 'user', content: 'Where is my order?' },
    { role: 'assistant', content: 'Your order ORD-1001 has shipped.' },
  ]);
  assert.deepEqual(toOpenAIMessages([]), []);
  assert.deepEqual(toOpenAIMessages([{ content: 'no role given' }]), [{ role: 'user', content: 'no role given' }]);
});

test('toOpenAISchema converts Gemini UPPERCASE types to JSON Schema lowercase', () => {
  const schema = toOpenAISchema({
    type: 'OBJECT',
    properties: {
      orderId: { type: 'STRING', description: 'The order id.' },
      confirmed: { type: 'BOOLEAN' },
      count: { type: 'INTEGER' },
    },
    required: ['orderId', 'confirmed'],
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.orderId.type, 'string');
  assert.equal(schema.properties.confirmed.type, 'boolean');
  assert.equal(schema.properties.count.type, 'integer');
  assert.deepEqual(schema.required, ['orderId', 'confirmed']);
});

test('toOpenAITools emits OpenAI-format function tools', () => {
  const tools = toOpenAITools([
    {
      declaration: {
        name: 'lookupOrderStatus',
        description: 'Looks up the status of an order.',
        parameters: { type: 'OBJECT', properties: { orderId: { type: 'STRING' } }, required: ['orderId'] },
      },
    },
  ]);
  assert.deepEqual(tools, [
    {
      type: 'function',
      function: {
        name: 'lookupOrderStatus',
        description: 'Looks up the status of an order.',
        parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      },
    },
  ]);
});

test('toOpenAITools converts the full tool registry (valid JSON Schema for OpenRouter)', () => {
  const tools = toOpenAITools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function.name);
    assert.equal(tool.function.parameters.type, 'object');
    assert.doesNotThrow(() => JSON.stringify(tool));
  }
});

test('shouldFallback flags quota/rate-limit/credit/server failures only', () => {
  assert.equal(shouldFallback({ status: 429 }), true);
  assert.equal(shouldFallback({ status: 402 }), true);
  assert.equal(shouldFallback({ status: 500 }), true);
  assert.equal(shouldFallback({ status: 503 }), true);
  assert.equal(shouldFallback({ status: 400 }), false);
  assert.equal(shouldFallback({ status: 401 }), false);
  assert.equal(shouldFallback({ status: 404 }), false);
  assert.equal(shouldFallback({}), false);
});

test('toFriendlyError preserves the HTTP status so fallback can react', () => {
  const quota = new Error('RESOURCE_EXHAUSTED: daily limit exceeded');
  quota.status = 429;
  const friendly = toFriendlyError(quota);
  assert.equal(friendly.friendly, true);
  assert.equal(friendly.status, 429);
});

test('FallbackAgent hands off to the next provider on quota exhaustion', async () => {
  const calls = [];
  const gemini = {
    model: 'gemini-3.5-flash',
    run: async () => {
      calls.push('gemini');
      const err = new Error('quota exhausted');
      err.status = 429;
      throw err;
    },
  };
  const openrouter = {
    model: 'openai/gpt-4o',
    run: async () => {
      calls.push('openrouter');
      return 'answer from openrouter';
    },
  };
  const agent = new FallbackAgent({ agents: [gemini, openrouter] });
  const text = await agent.run({ userMessage: 'hi' });
  assert.equal(text, 'answer from openrouter');
  assert.deepEqual(calls, ['gemini', 'openrouter']);
  assert.equal(agent.model, 'gemini-3.5-flash');
});

test('FallbackAgent rethrows non-fallback errors without trying the next provider', async () => {
  const gemini = {
    run: async () => {
      const err = new Error('bad request');
      err.status = 400;
      throw err;
    },
  };
  let openrouterCalled = false;
  const openrouter = { run: async () => ((openrouterCalled = true), 'nope') };
  const agent = new FallbackAgent({ agents: [gemini, openrouter] });
  await assert.rejects(() => agent.run({}), /bad request/);
  assert.equal(openrouterCalled, false);
});

test('OpenAICompatAgent.complete sends provider-configurable OpenAI-compatible requests', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  };
  try {
    const agent = new OpenAICompatAgent({
      apiKey: 'sk-bl-test',
      model: 'openai/gpt-4o',
      baseUrl: 'https://api.bazaarlink.ai/v1',
      label: 'BazaarLink',
      envPrefix: 'BAZAARLINK',
    });
    const res = await agent.complete([{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } },
    ]);
    assert.equal(res.choices[0].message.content, 'hi');

    const { url, init } = calls[0];
    assert.equal(url, 'https://api.bazaarlink.ai/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer sk-bl-test');
    assert.equal(init.headers['X-Title'], 'Lumina Support');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'openai/gpt-4o');
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.messages[0].content, 'hi');
  } finally {
    global.fetch = origFetch;
  }
});

test('OpenAICompatAgent honors the provider max_tokens env var', async () => {
  const origFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: body.max_tokens.toString() } }] }) };
  };
  process.env.BAZAARLINK_MAX_TOKENS = '512';
  try {
    const agent = new OpenAICompatAgent({
      apiKey: 'sk-bl-test',
      model: 'openai/gpt-4o',
      baseUrl: 'https://api.bazaarlink.ai/v1',
      label: 'BazaarLink',
      envPrefix: 'BAZAARLINK',
    });
    const res = await agent.complete([{ role: 'user', content: 'hi' }], []);
    assert.equal(res.choices[0].message.content, '512');
  } finally {
    delete process.env.BAZAARLINK_MAX_TOKENS;
    global.fetch = origFetch;
  }
});

test('FallbackAgent rethrows when every provider fails', async () => {
  const gemini = {
    run: async () => {
      const e = new Error('quota');
      e.status = 429;
      throw e;
    },
  };
  const openrouter = {
    run: async () => {
      const e = new Error('credits');
      e.status = 402;
      throw e;
    },
  };
  const agent = new FallbackAgent({ agents: [gemini, openrouter] });
  await assert.rejects(() => agent.run({}), /credits/);
});
