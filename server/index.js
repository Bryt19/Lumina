import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AgentOrchestrator } from './agent.js';
import {
  findCustomerByToken,
  findCustomerById,
  addMessage,
  createConversation,
  deleteConversation,
  getMessages,
  popLastExchange,
  db,
} from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const apiKey = process.env.GEMINI_API_KEY;
const agent = new AgentOrchestrator({ apiKey, model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });

// ---- Auth helpers ---------------------------------------------------------

function requireCustomer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const customer = token ? findCustomerByToken(token) : null;
  if (!customer) {
    return res.status(401).json({ error: 'unauthorized', message: 'Valid customer token required.' });
  }
  req.customer = customer;
  next();
}

// ---- Auth endpoints ---------------------------------------------------------

// Demo login: any seeded customer id maps to a session token.
// (Production would verify a password / OAuth before issuing a token.)
app.get('/api/auth/customers', (_req, res) => {
  const customers = db
    .prepare('SELECT id, name, email FROM customers ORDER BY name')
    .all();
  res.json({ customers });
});

app.post('/api/auth/login', (req, res) => {
  const { customerId } = req.body || {};
  const customer = customerId ? findCustomerById(customerId) : null;
  if (!customer) {
    return res.status(401).json({ error: 'invalid_customer', message: 'Unknown customer id.' });
  }
  res.json({ token: customer.token, customer: { id: customer.id, name: customer.name, email: customer.email } });
});

app.get('/api/me', requireCustomer, (req, res) => {
  const orderCount = db
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?')
    .get(req.customer.id).n;
  const ticketCount = db
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE customer_id = ?')
    .get(req.customer.id).n;
  res.json({
    customer: { id: req.customer.id, name: req.customer.name, email: req.customer.email },
    orderCount,
    ticketCount,
  });
});

// ---- Chat endpoint (SSE) ----------------------------------------------------

app.post('/api/chat', requireCustomer, async (req, res) => {
  const { message, conversationId, regenerate } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'A non-empty message is required.' });
  }

  // Reuse the caller's conversation if it exists, otherwise start a new one.
  let convId = conversationId;
  if (convId) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND customer_id = ?').get(convId, req.customer.id);
    if (!conv) return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
    // Regenerate: drop the trailing [user, assistant] exchange first so the
    // previous answer isn't replayed into the model's context.
    if (regenerate) popLastExchange(convId);
  } else {
    convId = createConversation(req.customer.id);
  }

  if (!apiKey) {
    return res.status(500).json({
      error: 'server_not_configured',
      message: 'GEMINI_API_KEY is not set on the server. Add it to server/.env and restart.',
    });
  }

  const history = getMessages(convId).slice(-20);
  addMessage(convId, 'user', message.trim());

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const text = await agent.run({
      customerId: req.customer.id,
      customer: req.customer,
      history,
      userMessage: message.trim(),
      onToken: (delta) => sse('token', { delta }),
      onTool: (name, args) => sse('tool', { name, args }),
    });
    addMessage(convId, 'assistant', text);
    sse('done', { conversationId: convId, text });
    res.end();
  } catch (err) {
    console.error('[chat] Error:', err);
    // Surface a friendly message when we have one (e.g. quota exhausted);
    // otherwise keep the generic, non-leaky message.
    const message = err?.friendly ? err.message : 'The support agent encountered an error. Please try again.';
    // Persist a fallback assistant turn so the conversation history stays
    // balanced — a stored user message without a reply would be replayed as a
    // dangling user turn and corrupt the next request's context.
    addMessage(convId, 'assistant', message);
    sse('error', { message });
    res.end();
  }
});

// ---- Conversation management -------------------------------------------------

// Permanently deletes the caller's conversation (and its messages).
app.delete('/api/conversations/:id', requireCustomer, (req, res) => {
  const conv = db
    .prepare('SELECT id FROM conversations WHERE id = ? AND customer_id = ?')
    .get(req.params.id, req.customer.id);
  if (!conv) {
    return res.status(404).json({ error: 'not_found', message: 'Conversation not found.' });
  }
  deleteConversation(conv.id);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: agent.model, geminiConfigured: Boolean(apiKey) });
});

app.listen(PORT, () => {
  console.log(`[server] API Gateway listening on http://localhost:${PORT}`);
  console.log(`[server] Model: ${agent.model} | Gemini configured: ${Boolean(apiKey)}`);
  if (!apiKey) {
    console.warn('[server] WARNING: GEMINI_API_KEY missing — set it in server/.env');
  }
});
