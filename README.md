# Freelance CFO: an AI agent that runs invoicing and collections on PayPal

Freelancers lose hours turning client chats into invoices and chasing late payments. **Freelance CFO** is an AI agent that handles that work on top of the **PayPal Invoicing API**, while **you stay in control**: the agent can read your PayPal data freely, but every change (an invoice, a reminder, a payment record) is only a *proposal* until you approve it.

Built for the *Build What's Next with PayPal and AI* hackathon. It runs against the **PayPal sandbox** (test money only).

## The agent

You talk to it in plain language. It decides which tools to call, and shows you exactly what it did.

| You say | What the agent does |
|---|---|
| *Paste a messy client message: "Logo is $250, banners $60 each, need it Friday, mail ankit@example.com"* | Extracts client, email, line items and due date and prepares an invoice for review |
| *"Who hasn't paid me?"* | Reads your real invoices from PayPal and answers from that data only |
| *"How is my cash flow? Who is my riskiest client?"* | Reads the money overview (outstanding, overdue, aging, top debtors) |
| *"Review my collections"* | Plans a follow-up run: finds overdue invoices, drafts one reminder each with a tone that gets firmer the later it is, and explains who it skipped and why |
| *"Ravi paid me by bank transfer yesterday"* | Finds the invoice and prepares a payment record |

**Tools:** `prepare_invoice`, `list_invoices`, `get_invoice`, `get_summary`, `draft_reminder`, `record_payment`. Gemini (free tier, function calling) chooses the tools; our server executes them and decides what is allowed.

**Transparency:** every answer comes with a collapsible *What I did* trace listing each tool call, so the agent's actions are never hidden.

## The product

A multi-page web app, not a demo screen:

| Page | What it does |
|---|---|
| **Dashboard** | Outstanding, overdue, collected; an aging chart of money owed by lateness; invoices needing attention; one-click *Run collections review* |
| **Assistant** | The agent chat, with example prompts and the tool trace |
| **Invoices** | Search and filter all invoices; open one for line items, payments and actions |
| **Invoice detail** | Send a reminder, record an offline payment, cancel the invoice, open the client's view; all through approval cards |
| **New invoice** | A manual form for when you do not want to talk to the agent |
| **Clients** | Totals per client built from invoices (billed, paid, outstanding, overdue) |
| **Approvals** | Queue of everything prepared and waiting for a decision |
| **Activity** | Permanent audit log of what actually happened |
| **Settings** | Connection status, editable safety limits, how the agent is kept safe |

## How PayPal and AI are used

**PayPal (central)**: Invoicing API v2 (sandbox) over REST with OAuth 2.0 client credentials:
`POST /v2/invoicing/invoices` (create draft, idempotent via `PayPal-Request-Id`), `/send`, `GET /v2/invoicing/invoices` and `/{id}`, `/remind`, `/payments` (record payment), `/cancel`.

**AI**: Google Gemini with function calling, with an automatic fallback chain across several models (free-tier models can be slow or busy). The model never talks to PayPal directly.

## Safety by design (why you can trust an agent near money)

1. **Read freely, change only with approval.** Agent tools cannot send, record or cancel anything. They create proposals; only a human click calls PayPal.
2. **The server re-validates every approval**, including your edits, so limits cannot be bypassed from the browser or by the AI.
3. **Hard cap** per invoice and an **extra confirmation** for high-value invoices (both editable in Settings).
4. **Warnings** for first-time client emails and probable duplicates.
5. **Idempotent and recoverable.** Double-clicks are harmless; if PayPal fails after a draft exists, retrying sends that same draft.
6. **Prompt-injection aware.** Text in client messages or invoice notes is treated as data. Reminders are never drafted for paid invoices; payments are only recorded when you state they arrived.
7. **Bounded agent.** At most 8 proposals and 10 reasoning steps per request.
8. **Sandbox lock.** The app refuses to start against live PayPal unless `ALLOW_LIVE=true`.
9. **Optional sign-in** (`APP_PASSWORD`) with signed, HttpOnly session cookies, constant-time comparison and rate-limited login.
10. Secrets stay in environment variables; all AI/PayPal text is rendered as plain text (no HTML injection); strict Content-Security-Policy; per-IP rate limits; append-only audit log.

## Run it locally

Requires **Node.js 22.9 or newer** (`node -v`).

1. `npm install`
2. Get credentials:
   - PayPal: [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → **Sandbox** → create a **Merchant** app, tick **Invoicing** under Features, copy *Client ID* and *Secret*. Use a **US** sandbox business account if invoicing is refused for your default one.
   - Gemini: [aistudio.google.com](https://aistudio.google.com) → *Get API key* (free).
3. Copy `.env.example` to `.env` and fill in the values.
4. `npm run check` tests your PayPal login, the Invoicing permission and Gemini.
5. *(Optional but recommended)* `npm run seed -- --yes` creates four demo invoices in your sandbox (one paid, two overdue, one upcoming) so every page and the collections review have real data.
6. `npm start`, then open <http://localhost:3000>.

## Try it (testing instructions for judges)

If the hosted demo is password protected, use the password given in the submission's testing instructions.

1. **Dashboard** shows live numbers and the aging chart. Click **Run collections review**: the agent finds the overdue invoices and prepares one reminder each. Open *What I did* to see its steps.
2. Open **Approvals**, edit a reminder, and approve it. PayPal sends it, and **Activity** records it.
3. **Assistant** → *Invoice from a messy message* → review the card → add the email → **Approve & send**. Open the client view link and pay it with a sandbox personal account (Developer Dashboard → Testing tools → Sandbox accounts); refresh the dashboard to watch it turn **Paid**.
4. **Assistant** → *Payment received* to see the agent record an offline payment on an invoice.
5. Try the safety rails: an invoice above the high-value threshold needs a confirmation tick, and above the hard cap the server refuses it (**Settings** to change both).

Manual test plan: [TESTING.md](TESTING.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | none | Sandbox app credentials |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` | Keep as sandbox |
| `PAYPAL_INVOICER_EMAIL` | empty | Only if PayPal asks for an invoicer email |
| `GEMINI_API_KEY` | none | Google AI Studio key |
| `GEMINI_MODEL` | `gemini-3-flash-preview,gemini-3.5-flash,gemini-3.1-flash-lite-preview,gemini-flash-lite-latest` | One model or a comma separated fallback list. Availability differs per key and over time |
| `APP_PASSWORD` | empty | Set on a hosted deployment to require sign-in |
| `SESSION_SECRET` | empty | Extra secret for signing session cookies (Render generates one) |
| `MAX_INVOICE_AMOUNT`, `HIGH_VALUE_THRESHOLD`, `DEFAULT_DUE_DAYS` | `5000`, `1000`, `14` | Defaults for the safety limits (editable in Settings, saved to `data/settings.json`) |
| `CHAT_RATE_PER_MIN`, `ACTION_RATE_PER_MIN` | `12`, `30` | Per-IP rate limits |
| `PORT`, `DATA_DIR` | `3000`, `data` | Server port and data folder |
| `ALLOW_LIVE` | unset | Only set `true` if you really intend to use live PayPal |

## Architecture

```
Browser (public/): router + 9 pages          Server (src/)                              External
┌─────────────────────────────┐  /api/chat   ┌───────────────┐   function calling   ┌───────────┐
│ Dashboard · Assistant ·     │─────────────▶│   agent.js    │─────────────────────▶│  Gemini   │
│ Invoices · New · Clients ·  │              │ (tool loop,   │◀─────────────────────│ (fallback │
│ Approvals · Activity ·      │              │  trace)       │                      │  models)  │
│ Settings · Login            │  /approve    └──────┬────────┘                      └───────────┘
│                             │─────────────▶┌──────▼────────┐   Invoicing API v2   ┌───────────┐
└─────────────────────────────┘              │    app.js     │─────────────────────▶│  PayPal   │
                                             │ proposals,    │◀─────────────────────│  Sandbox  │
                                             │ guards, auth, │                      └───────────┘
                                             │ audit log     │
                                             └───────────────┘
```

## Tests

`npm test` runs 53 automated tests: invoice logic and validation, safety guards, the PayPal and Gemini clients (token caching, retries, fallback, error mapping), the full approve / reject / retry flows for invoices, reminders, payments and cancellations, auth and rate limiting, settings, the agent's tool loop (including a collections review and a runaway-agent cap), and an end-to-end run of the real clients against local mock servers.

## Deploy (Render)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): *New → Blueprint* and pick the repo (it reads `render.yaml`).
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` and `APP_PASSWORD` in the dashboard. Never commit secrets.

Free Render instances sleep when idle, so the first request after a pause can take about a minute. The audit log and saved settings live on the instance disk and reset on redeploy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run check` says PayPal rejected the Client ID/Secret | Re-copy both from the same *Sandbox* app (no spaces or quotes in `.env`) |
| PayPal "not authorized" | Tick **Invoicing** in the app's Features, and try a sandbox business account with country United States |
| Gemini very slow or "model not found" | Set `GEMINI_MODEL` to models that work for your key (comma separated, best first) |
| "quota is busy" | Free-tier limit; wait a few seconds (the app retries and falls back automatically) |

## Project structure

```
src/      index.js · app.js (routes, approvals, guards) · agent.js (prompt, tools, loop) · auth.js
          gemini.js · paypal.js · invoices.js (domain logic) · store.js · config.js · check.js · seed.js
public/   index.html · styles.css · main.js (router) · ui.js (toolkit, approval cards)
          views/ dashboard · assistant · invoice-list · invoice-detail · new-invoice · clients
                 approvals · activity · settings · login
test/     logic.test.js · api.test.js · product.test.js
```

## Roadmap

- Per-user PayPal connections (OAuth / partner onboarding) so one deployment can serve many freelancers
- PayPal webhooks for instant "paid" updates and automatic follow-up scheduling
- Recurring invoices and retainers; multi-currency totals; accounting export

## License

MIT. See [LICENSE](LICENSE).