# Agentic Customer Support Assistant Platform — System Design

## 1. Current state (as reviewed)

The repo today is a **frontend-only prototype**:

- **`AppComponent`** — Angular 18 chat UI (Tailwind CSS, signals). Sends the user's message to a service, renders replies, dark-mode toggle, action chips.
- **`GeminiAgentService`** — wraps `@google/genai`, creates a chat session on model `gemini-3.5-flash`, declares two tools (`lookupOrderStatus`, `changeTheme`), executes them locally, and returns the model's final text.
- **`environment.ts`** — contains a **hardcoded Google API key** shipped in the browser bundle.

Everything (model call, API key, mock order data) lives in the browser. There is no backend, no data store, no auth, no persistence, no streaming, and no tests beyond a component smoke test.

### Issues to fix

| # | Issue | Impact | Status |
|---|-------|--------|--------|
| 1 | API key in `environment.ts`, not gitignored | Leaked to every site visitor; risk of abuse/billing | ✅ Resolved — key lives in `server/.env` (gitignored); `environment.ts` ships no secrets |
| 2 | Model call runs client-side | Key can never be hidden; no access to real business data | ✅ Resolved — agent runs server-side (`server/agent.js`) behind the API Gateway; the SPA only streams deltas |
| 3 | `lookupOrderStatus` returns hardcoded data | Not a real system; useless in production | ✅ Resolved — tools query SQLite (`server/db.js`), scoped to the authenticated customer |
| 4 | Agent loop handles only a single function call | No chained/parallel tool use, no loop-until-finished | ✅ Resolved — loop runs up to `MAX_AGENT_ITERATIONS` (8) and executes each turn's function calls in parallel, feeding results back |
| 5 | Model name `gemini-3.5-flash` unverified | Likely invalid; verify against current model list | ✅ Resolved — verified as a stable GA endpoint (`gemini-3.5-flash`, see [models doc](https://ai.google.dev/gemini-api/docs/models)); overridable via `GEMINI_MODEL` |
| 6 | No persistence, auth, or escalation path | Can't support real customers | ✅ Resolved — SQLite persistence (orders, tickets, conversations), demo session tokens, refund + human-escalation tools |

## 2. Target architecture

```
┌─────────────────────────────┐
│  Client (Angular SPA)        │
│  • Chat UI (existing)        │
│  • Streaming message display │
│  • Theme / session state     │
└──────────────┬──────────────┘
               │ HTTPS + JSON/SSE (auth token)
┌──────────────▼──────────────┐
│  API Gateway (Node/Firebase │
│  Functions / Cloud Run)     │
│  • Auth (customer session)  │
│  • Rate limiting            │
│  • Chat + SSE endpoints     │
└──────────────┬──────────────┘
┌──────────────▼──────────────┐
│  Agent Orchestrator         │
│  • Owns Gemini session      │
│  • Agentic loop:            │
│    model → tool calls →     │
│    execute → feed back →    │
│    repeat → final answer    │
│  • Streams to client        │
└──────┬──────────────┬───────┘
       │              │
┌──────▼──────┐ ┌─────▼─────────────┐
│ Tool        │ │ Data layer        │
│ registry    │ │ • Orders (DB)     │
│ • lookup    │ │ • Tickets         │
│   order     │ │ • Policy/knowledge│
│ • refund    │ │ • Customer        │
│ • escalate  │ │ • Chat history    │
│ • theme     │ └───────────────────┘
└──────┬──────┘
       │
┌──────▼──────┐
│ Gemini API  │
└─────────────┘
```

### Component responsibilities

**Client (Angular)**
- Renders messages, typing indicator, action chips; streams assistant text as it arrives.
- Sends `POST /api/chat` and subscribes to an SSE/streaming response; no API key, no model logic in the browser.
- The only tool the client still executes is cosmetic (`changeTheme`), invoked via a normal event — the AI never mutates the UI directly.

**API Gateway**
- Authenticates the caller (session token → customer ID), rate-limits per customer, enforces PII access rules, and proxies streaming responses.
- Single place for logging, tracing, and quota.

**Agent Orchestrator (server-side)**
- Holds the Gemini session and the **agentic loop**:
  1. Send user message (+ conversation history) to the model with the tool schemas.
  2. If the response contains function calls, execute each against the tool registry (or in parallel when safe), append `functionResponse` parts, and call the model again.
  3. Repeat up to `MAX_ITERATIONS` (e.g. 8), then return the final text.
- Streams tokens to the client while tool calls execute.
- Uses a current model (verify `gemini-3.x-flash` line) with `temperature` tuned for factual support replies.

**Tool registry**
Each tool = `FunctionDeclaration` schema + server-side executor + permission check.

| Tool | Executor | Data source |
|------|----------|-------------|
| `lookupOrderStatus` | Query orders by ID **scoped to the authenticated customer** | Orders DB |
| `lookupTicketStatus` | Query support ticket | Tickets DB |
| `requestRefund` | Create refund request (requires confirmation from customer) | Orders DB |
| `escalateToHuman` | Create/flag ticket, notify agent queue | Tickets DB + notification |
| `getPolicy` | Retrieve relevant policy text | Knowledge base (optional RAG/grounding) |
| `changeTheme` | *Not a server tool* — handled client-side as a UI affordance | — |

**Data layer**
- Orders, tickets, customers, chat history — one DB (Postgres or a managed equivalent; SQLite for local dev).
- Chat history persisted so sessions survive reload and the orchestrator can load the last N turns.
- Knowledge base for policy grounding (optional, phase 2).

**Security model**
- Google API key lives **only** in server env vars (never in the bundle, never in git).
- Every data tool takes the customer ID from the session, not from the model — the model can only ever query the caller's own records.
- Human escalation is the sanctioned escape hatch; refunds require explicit user confirmation before execution.

## 3. Data flow (happy path)

```
User: "Where is my order #1234?"
  → POST /api/chat {message, conversationId}
  → Orchestrator sends message + history + tool schemas to Gemini
  → Gemini returns functionCall(lookupOrderStatus, {orderId: "1234"})
  → Orchestrator calls executor with customerId from session
  → Executor queries Orders DB (scoped), returns {status, eta}
  → Orchestrator feeds functionResponse back to Gemini
  → Gemini returns final text
  → Gateway streams final text to client
```

## 4. Phased implementation plan

**Phase 1 — Harden the prototype (this repo, minimal):**
- Remove the key from `environment.ts`; load via `environment.apiKey` from an env-injected value, add `src/environments/environment.*.ts` and key files to `.gitignore`.
- Verify/replace the model name with a current Gemini model.
- Extend the agent loop in `GeminiAgentService` to handle chained and parallel function calls.

**Phase 2 — Server-side agent (new backend service):**
- Stand up the API Gateway + Agent Orchestrator (Node/Firebase Functions or Cloud Run).
- Move the Gemini session, key, and tool executors server-side; client becomes a thin chat client with streaming.

**Phase 3 — Real data + operations:**
- Orders/tickets DB, customer auth, persistence, escalation queue.
- Logging, tracing, and an eval set of support scenarios to measure agent quality.

## 5. Open decisions (need product input)

- Backend language/runtime (Node/Express vs Firebase Functions vs Cloud Run).
- Auth provider for customers (email/password vs OAuth/SSO).
- Which tools matter for the first real release (order status vs refunds vs escalations).
- Whether policy answers need RAG/grounding against a knowledge base in phase 1.
