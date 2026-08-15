# Lumina Support

Lumina Support is a modern landing page featuring an integrated, intelligent AI chatbox. Built with an Angular 18 client and backed by a Node.js API Gateway, it leverages a Gemini agent orchestrator to handle complex customer support tasks autonomously (including orders, tickets, refunds, and policy inquiries).

See [DESIGN.md](./DESIGN.md) for the system design and architecture.

## Architecture at a glance

```
Angular SPA (src/)  ──HTTPS/SSE──▶  Node API Gateway (server/)  ──▶  Gemini agent
  • landing page UI                    • demo session auth            • agentic loop:
  • integrated chatbox                 • conversation persistence       model ⇄ tools ⇄ model
  • streaming deltas                   • tool registry (orders,         (orders, tickets,
                                        tickets, refunds, policy)       refunds, escalate)
                                        └─▶ SQLite (server/data.db)
```

- The Gemini API key lives **only** in `server/.env` (gitignored) — never in the browser bundle.
- Every data tool is scoped to the authenticated customer, ensuring users can only access their own orders and tickets.

## Prerequisites

- Node.js >= 20 (uses `node:sqlite`, built into Node 22+)
- A Gemini API key: <https://aistudio.google.com/apikey>
- Client dependencies are installed with `npm install` at the repo root; server dependencies with `npm install` inside `server/`.

## Running the system

1. **Configure the server**

   ```bash
   cp server/.env.example server/.env
   # edit server/.env and set GEMINI_API_KEY=your-key
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

> Note: the free Gemini tier allows ~20 model requests/day per model. If you hit `429 quota` errors, switch the model (`GEMINI_MODEL` in `server/.env`) or add billing. See <https://ai.google.dev/gemini-api/docs/rate-limits>.

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

- `server/index.js` — Express API gateway: auth, `/api/chat` SSE, persistence
- `server/agent.js` — Gemini session + agentic tool-calling loop
- `server/tools/index.js` — tool registry (declarations + executors)
- `server/db.js` — SQLite schema, seeding, query helpers
- `src/app/services/chat.service.ts` — client chat/auth/streaming service
- `src/app/app.component.*` — landing page and chatbox UI
# Lumina
