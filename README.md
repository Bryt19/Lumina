# Lumina Support

Lumina Support is a modern landing page featuring an integrated, intelligent AI chatbox. Built with an Angular 18 client and backed by a Node.js API Gateway, it leverages an agentic AI orchestrator to handle complex customer support tasks autonomously (including orders, tickets, refunds, and policy inquiries). The agent runs on Google Gemini by default and automatically falls back to OpenRouter, then BazaarLink, when the Gemini free-tier quota runs out — so the chatbox keeps answering even after Gemini's daily limit.

See [DESIGN.md](./DESIGN.md) for the system design and architecture.

## Architecture at a glance

```
Angular SPA (src/)  ──HTTPS/SSE──▶  Node API Gateway (server/)  ──▶  AI agent
  • landing page UI                    • demo session auth            • agentic loop:
  • integrated chatbox                 • conversation persistence       model ⇄ tools ⇄ model
  • streaming deltas                   • tool registry (orders,         (orders, tickets,
                                        tickets, refunds, policy)       refunds, escalate)
                                        │ Gemini (primary)
                                        │   ↳ OpenRouter fallback when out of quota
                                        │   ↳ BazaarLink fallback after that
                                        └─▶ SQLite (server/data.db)
```

- AI provider keys (Gemini and/or OpenRouter) live **only** in `server/.env` (gitignored) — never in the browser bundle.
- Every data tool is scoped to the authenticated customer, ensuring users can only access their own orders and tickets.

## Prerequisites

- Node.js >= 20 (uses `node:sqlite`, built into Node 22+)
- A Gemini API key: <https://aistudio.google.com/apikey> (primary provider)
- Optional: an OpenRouter API key: <https://openrouter.ai/keys> (automatic fallback when Gemini is out of quota; use it as the only key if you don't have Gemini)
- Optional: a BazaarLink API key: <https://bazaarlink.ai> (OpenAI-compatible gateway; used after OpenRouter if both are configured)
- Client dependencies are installed with `npm install` at the repo root; server dependencies with `npm install` inside `server/`.

## Running the system

1. **Configure the server**

   ```bash
   cp server/.env.example server/.env
   # edit server/.env and set GEMINI_API_KEY=your-key
   # optionally also set OPENROUTER_API_KEY=your-key and/or BAZAARLINK_API_KEY=your-key
   # for automatic fallbacks when Gemini's quota is exhausted
   ```

2. **Start the API server** (port 3000)

   ```bash
   cd server && npm start        # or: npm run dev (auto-reload)
   ```

   The SQLite database (`server/data.db`) is created and seeded automatically with demo customers, orders, and tickets on first run.

3. **Start the Angular client** (port 4200)

   ```bash
   npm start
   ```

   Open <http://localhost:4200/> and explore the Lumina Support landing page. Sign in as a demo customer (Alice, Bob, or Carol) to test the integrated chatbox. The dev server proxies `/api` to `http://localhost:3000` via `proxy.conf.json`.

## Demo accounts

| Customer      | Token            | Sample data                    |
|---------------|------------------|--------------------------------|
| Alice Chen    | demo-token-alice | ORD-1001..1003, TKT-5001       |
| Bob Martinez  | demo-token-bob   | ORD-2001..2002                 |
| Carol Nguyen  | demo-token-carol | ORD-3001, TKT-5002             |

Try asking the chatbox: *"Where is my order ORD-1001?"*, *"Request a refund for ORD-1003"*, *"Escalate to a human agent"*, or *"What is your refund policy?"*.

> Note: the free Gemini tier allows ~20 model requests/day per model. When that quota is exhausted, the server automatically retries the request on the next configured provider — OpenRouter (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`, default `openai/gpt-4o`), then BazaarLink (`BAZAARLINK_API_KEY` + `BAZAARLINK_MODEL`, default `openai/gpt-4o`) — no code changes needed. You can still switch the Gemini model (`GEMINI_MODEL` in `server/.env`) or add billing. See <https://ai.google.dev/gemini-api/docs/rate-limits>.

## Tests

Server (Node's built-in test runner):

```bash
cd server && npm test
```

Client (Karma):

```bash
npm test
```

The client test runner (webpack/karma) cannot run if the repo path contains a `!` character (webpack reserves it for loader syntax). Move the project to a path without `!` if you need `ng test`.

## Scripts

| Where   | Command        | Purpose                          |
|---------|----------------|----------------------------------|
| root    | `npm start`    | Run the Angular dev server       |
| root    | `npm run build`| Production build to `dist/`      |
| root    | `npm test`     | Client unit tests (Karma)        |
| server  | `npm start`    | Run the API gateway + agent      |
| server  | `npm run dev`  | Run with auto-reload (`--watch`) |
| server  | `npm test`     | Server unit tests (`node --test`)|

## Key files

- `server/index.js` — Express API gateway: auth, `/api/chat` SSE, persistence, provider selection
- `server/agent.js` — agentic tool-calling loop for Gemini and OpenAI-compatible gateways (OpenRouter, BazaarLink), plus automatic provider fallback
- `server/tools/index.js` — tool registry (declarations + executors)
- `server/db.js` — SQLite schema, seeding, query helpers
- `src/app/services/chat.service.ts` — client chat/auth/streaming service
- `src/app/app.component.*` — landing page and chatbox UI
# Lumina
