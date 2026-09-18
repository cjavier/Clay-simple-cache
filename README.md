# Clay Cache API

Identity cache, email finder, tech stack detection, LinkedIn resolution, per-client Do Not Contact (DNC) lists, and DeepSeek-backed AI endpoints (copy generation + a web-research agent) for a GTM outbound agency. Allows upserting People/Company records based on normalized keys and merging enrichment data into a unified record over time.

Consumed both as a REST API and as an [MCP server](#mcp-server--agent-access) (Streamable HTTP), so it's built to be driven directly by AI agents (Claude Code, claude.ai, etc.) as much as by traditional backend code.

Full endpoint reference (request/response shapes, error codes, curl examples, and a compact machine-readable summary for AI agents) is served live at `GET /docs/api` — see [Docs](#docs) below. A plain-text summary for agents is also served at `GET /llms.txt`.

## Features
- **Profiles**:
  - Normalization: Email, LinkedIn (Slug & Full URL), Phone.
  - Resolution priority: Email > LinkedIn URL > LinkedIn Slug > Phone.
- **Companies**:
  - Normalization: Domain (trim, lowercase, remove www/protocol), LinkedIn.
  - Resolution priority: Domain > LinkedIn.
- **Email Finder**:
  - **Reads the name off the LinkedIn slug, not just the `last_name` field.** In a LATAM name the mailbox is built on the *paternal* surname, but the `last_name` we receive is the *maternal* one 74.9% of the time (measured over the 68,719 profiles here that carry two surnames), while 57.2% of real addresses use the paternal surname. `roberto-lozano-martinez` arrives as "Roberto Martinez" and his address is `rlozano@` — unreachable at any budget from the name as sent. Replayed over 119,981 known-good corporate addresses, the name as received tops out at **59.1%**; the surnames recovered from the slug reach **79.6%**. `/find` accepts `linkedin_url`/`linkedin_slug`; pass it whenever you have it.
  - **Five candidates, not fifteen.** With the right surname, 3 candidates beat the old 15 (62.7% vs 59.1%) and 5 reach 66.8%. Candidates 6–15 bought 4 points for twice the spend.
  - **Spends in order of what's free first**: addresses already in `profiles` → the domain's learned pattern → a domain-cached Google lookup → verified candidates. 75.8% of searches land on a domain we already hold an address for.
  - **Pattern-first for known domains**: where a domain has ≥3 known addresses the search verifies exactly one candidate. Leave-one-out over `profiles` puts that guess right **81.5%** of the time, against 33.3% for the catch-all guessing it replaces. `scripts/backfill_domain_patterns.ts --commit` mines this from existing data at no API cost — it covers 56,340 domains.
  - **Catch-all domains are answered from the pattern, not probed.** A catch-all server accepts every local part by definition, so scanning candidates there buys identical "yes" answers. `domain_intel.is_catch_all` is now actually written (it was a hardcoded `false` in both upsert branches, so all 63,291 rows said false).
  - **A domain that never answers stops being asked**: 10 fruitless searches mute it for 30 days. 6,889 such domains cost $135 in four weeks — `banorte.com.mx` alone was 549 searches for 0 results.
  - **Everything that can be cached is**: verification verdicts including the negatives (20.1% of searches repeat a person+domain), SERP keyed by domain rather than by search (139,560 duplicate calls, $139.56), domain intel, learned patterns.
  - **Bounded in time**: a hard 20s budget per search, and a cap on the DeBounce queue so a burst sheds to Tier 1 instead of parking. The median `catch_all` answer used to take 72 minutes and the slowest search 7h56m; answers over an hour were kept by the caller only 29.4% of the time, against 99.3% under 30 seconds.
  - **`POST /find/batch`** returns a job id immediately and **`GET /find/batch/:id`** collects the results, so a campaign list never races an HTTP timeout. Interrupted jobs resume on boot.
  - Multi-tier API verification cascade (EmailListVerify, DeBounce), MX lookup, provider detection, disposable/free checks.
  - LATAM naming: compound surnames are split paternal-first, particles are glued rather than treated as surnames (`de la Torre` → `delatorre`, never `la`), and the compound-initial spelling (`José Carlos Morente` → `jcmorente@`) is generated.
  - Pattern prevalence is measured from the verified emails in `profiles`, not estimated.
- **Measurement & history** (so the effect of a change stays visible after the fact):
  - `search_log` records `identity_source` (was the surname recovered from LinkedIn, a full name, or taken as sent), `timed_out`, and `candidates_built` alongside `permutations_tried` — the gap between those two is what the budget is actually saving.
  - `finder_metrics` keeps a dated daily snapshot of accuracy, delivery, cost and latency, written by the daily job. `GET /stats` reads a rolling window live; once that window slides the number is gone, so it is written down on the day it was true — the same reason `provider_credits` keeps history instead of current state. `GET /stats/history` reads it back.
  - Historical knowledge was backfilled rather than relearned at cost: `scripts/backfill_domain_patterns.ts` (56,340 domains), `scripts/backfill_catch_all_domains.ts` (2,829 catch-all domains recovered from `search_log`, since the flag could never be written before), `scripts/seed_domain_health.ts` (18,390 domains, 23 muted).
- **Finder Quality Monitor**:
  - `GET /stats` used to report `valid / total_searches`, which says nothing about whether the address was right — and hid the gap that mattered: `valid` matches the address another provider found **95.2%** of the time, `catch_all` **33.3%**. Both were one number.
  - `stats.quality` now reports agreement and delivery per verdict, plus latency percentiles. "Delivery" is whether the address we returned exists in `profiles` — a direct read on whether callers are still listening.
  - The daily job that watches provider balances also alerts when `catch_all` precision drops under 60%, `valid` under 85%, or the median answer passes 30s. Those are the two indicators that would have caught both failures months earlier. It records the day's numbers first and alerts second — an all-green day is exactly the one you want on file when something later goes wrong.
- **Tech Detector**:
  - Given a URL, fetches its HTML and detects web technologies (CMS, ecommerce, analytics, tag managers, marketing tools, advertising pixels, payment integrations, CDN, SEO plugins, and privacy tools).
- **LinkedIn Finder**:
  - Resolves a company domain to its LinkedIn company page via SERP search.
- **Clients & Do Not Contact (DNC)**:
  - Register clients under a readable `handle` (derived from `name`).
  - Per-client DNC lists (`individual` emails or whole `domain`s); an optional `dnc_client` param on `GET /profiles`, `GET /companies`, `POST /find`, and `POST /verify` gates the lookup behind the client's DNC list in a single call.
- **AI (DeepSeek)**:
  - `POST /copy` — single-shot prompt → outbound copy generation.
  - `POST /explore` — a tool-using research agent (Google search + page fetch, SSRF-guarded) that answers open-ended questions with sourced reasoning steps.
  - Both return `usage` (prompt/completion/cached tokens) and `usage.cost_usd` (computed from DeepSeek's per-model pricing).
  - Both accept an optional `response_schema` — a JSON shape describing the desired output — to get back parsed structured JSON (e.g. `{description, top_problems: [...]}`) instead of a single free-text string.
- **Provider Credit Monitor**:
  - `GET /credits` — live green/yellow/red balance for every paid API (EmailListVerify, DeBounce, Serper, DeepSeek).
  - Status is runway-based: it divides each balance by the burn rate measured from `search_log`, so `yellow` means "under 10 days left at current usage", not an arbitrary number. DeepSeek uses USD floors instead, since its spend isn't logged.
  - A provider that can't be read — bad key, network error, missing key — is reported **red**, never green.
  - Runs daily at 14:00 UTC (08:00 CDMX) — before the day's campaigns — recording every check in `provider_credits` and posting to Slack when something is wrong or has just recovered. All-green runs stay silent on purpose.
  - The daily run is scheduled **inside the API process** (`src/jobs/credit-check-schedule.ts`), enabled with `CREDIT_CHECK_DAILY=true`. It was a separate Railway cron service first, but that fired exactly once: a schedule set through the dashboard/API binds to the deployment that existed at that moment, so every later deploy produced one with no cron and the check silently stopped. A monitor that doesn't run is worse than none, because it looks like coverage. This service is already up 24/7, so the schedule is plain code — it survives every deploy and the timing is unit-tested.
  - On boot it asks `provider_credits` whether today's slot already produced a check; if the slot has passed and nothing is recorded, it runs immediately. That way a deploy near the scheduled time doesn't skip the day, and a restart storm still only checks once.
  - `npm run check:credits` runs the same `runCreditCheck()` the scheduler calls, so a manual check and a scheduled one can't drift. Its exit code reports whether the run worked, not what it found: a red provider exits 0 (Slack is the channel for that), while an unhandled error or an undelivered alert exits 1.
  - Exists because a depleted verifier returns `unknown`, which is indistinguishable from "email not found" — that failure mode went unnoticed for 82 days.
- **Data Merging**: Merges JSON data safely, never destructively overwrites.
- **ORM**: Builds on **Prisma** + **Supabase** (PostgreSQL).

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```

   | Variable | Required | Description |
   |---|---|---|
   | `PORT` | No (default `3000`) | HTTP port the server listens on. |
   | `API_KEY` | **Yes** | Bearer token required on every endpoint except `GET /health` and `GET /docs/api`. |
   | `DATABASE_URL` | **Yes** | Connection Pool URL (Transaction Mode, port `6543`). |
   | `DIRECT_URL` | **Yes** | Direct Connection URL (Session Mode, port `5432`) — used for migrations. |
   | `EMAILLISTVERIFY_API_KEY` | **Yes** (for Email Finder) | Tier 1 email verification provider. |
   | `DEBOUNCE_API_KEY` | **Yes** (for Email Finder) | Tier 2 email verification provider. |
   | `SERPER_API_KEY` | **Yes** (for Email Finder, LinkedIn Finder, Explore agent) | google.serper.dev — SERP pattern discovery, domain→LinkedIn resolution, and the `serp_search` tool. |
   | `DEEPSEEK_API_KEY` | **Yes** (for `/copy`, `/explore`) | DeepSeek chat completions API. Missing key returns `503` from those two endpoints only; the rest of the API works without it. |
   | `SLACK_TOKEN` | No (needed for credit alerts) | Slack bot token (`xoxb-…`) with `chat:write`. Used only by `src/jobs/check-credits.ts`. |
   | `SLACK_ALERT_CHANNEL` | No (needed for credit alerts) | Slack channel ID to post balance alerts to, e.g. `C0BSJ09ESCQ`. |
   | `CREDIT_ALERT_RED_DAYS` | No (default `3`) | Runway in days below which a provider is red. |
   | `CREDIT_ALERT_YELLOW_DAYS` | No (default `10`) | Runway in days below which a provider is yellow. |
   | `CREDIT_ALERT_RED_USD` | No (default `5`) | DeepSeek USD balance below which it's red. |
   | `CREDIT_ALERT_YELLOW_USD` | No (default `20`) | DeepSeek USD balance below which it's yellow. |
   | `ALLOWED_ORIGINS` | No | Comma-separated list of allowed CORS origins. Omitted/empty = CORS open (current default behavior). |
   | `RATE_LIMIT_PER_MIN` | No (default `300`) | Global per-IP rate limit (requests/minute), all routes. |
   | `COSTLY_RATE_LIMIT_PER_MIN` | No (default `30`) | Additional per-IP rate limit (requests/minute) stacked on `/find`, `/verify`, `/detect-tech`, `/copy`, `/explore`, `/find-linkedin`. |

3. **Database Setup**:
   Push the schema to your database:
   ```bash
   npm run prisma:push
   ```

## Usage

**Start Development Server**:
```bash
npm run dev
```

**Production Build & Start**:
```bash
npm run build
npm start
```
`npm start` runs `prisma migrate deploy` (applying versioned migrations from `prisma/migrations/`) before starting the compiled server — it no longer runs `prisma db push` in production, since `db push` can silently drop data on a live database. Migrations are the source of truth for schema changes; use `npm run prisma:push` only against your local/dev database.

**npm scripts**:
| Script | Purpose |
|---|---|
| `npm run dev` | `prisma generate` + `prisma db push` + `nodemon src/index.ts` (local dev, schema kept in sync automatically). |
| `npm run build` | `tsc` — compiles to `dist/`. |
| `npm start` | `prisma generate` + `prisma migrate deploy` + `node dist/index.js` (production; requires committed migrations). |
| `npm run prisma:generate` | Regenerate the Prisma client. |
| `npm run prisma:push` | Push the schema directly to the database (dev only — bypasses migrations). |
| `npm run prisma:studio` | Open Prisma Studio. |
| `npm run check:credits` | Probe every provider's balance, record it, and alert Slack if anything is red/yellow or just changed. `--dry-run` to check without writing or alerting; `--force` to alert even when all green. |
| `npm test` | `vitest run` — run the test suite once. |
| `npm run test:watch` | `vitest` — run tests in watch mode. |

## Docs

See the full, always-current API reference at `GET /docs/api` (e.g. `http://localhost:3000/docs/api` locally). It documents every endpoint below with request/response shapes, error codes, curl examples, rate limits, and a compact "for AI agents" summary meant to be pasted directly into an agent prompt.

**API Endpoints** (summary — see `/docs/api` for full detail):

- **Cache — Profiles**
  - `POST /profiles`: Upsert/enrich a profile by `email`, `linkedin_url`, or `phone`.
  - `GET /profiles`: Query by `email`, `linkedin`, or `phone`. Optional `dnc_client=<handle>` gates the response behind that client's DNC list.

- **Cache — Companies**
  - `POST /companies`: Upsert/enrich a company by `domain` or `linkedin_url`.
  - `GET /companies`: Query by `domain` or `linkedin`. Optional `dnc_client=<handle>`.

- **Email Finder**
  - `POST /find`: Find email by name + domain. Optional `dnc_client=<handle>`.
  - `POST /verify`: Verify an existing email address. Optional `dnc_client=<handle>`.
  - `GET /stats`: Aggregate metrics for the email finder.

- **Tech Detector**
  - `POST /detect-tech`: Detect web technologies from a URL.

- **LinkedIn Finder**
  - `POST /find-linkedin`: Resolve a domain (or URL) to its LinkedIn company page.

- **Clients (Do Not Contact)**
  - `POST /clients`: Create a client. The `handle` (unified client id) is derived from `name` (lowercased, hyphenated, accents stripped).
  - `GET /clients`: List clients, or fetch one with `?handle=`.

- **Do Not Contact (DNC)**
  - `POST /dnc`: Upload entries to a client's DNC list (`list_type` = `individual` | `domain`). Emails on a `domain` list are decomposed: the domain is blocked and the original email is stored.
  - `POST /dnc/check`: Check an email against a client's DNC list. Returns `200` with `do_not_contact: true|false`.
  - `GET /dnc`: List a client's DNC entries (optional `?list_type=`).

- **AI (DeepSeek)**
  - `POST /copy`: Generate outbound copy from a prompt. Returns `503` if `DEEPSEEK_API_KEY` is unset, `502` on upstream failure. Optional `response_schema` returns `response` as parsed JSON matching that shape.
  - `POST /explore`: Run a tool-using research agent (`serp_search` + `fetch_page`, up to `max_steps` tool calls, default 8, hard cap 15). Returns the final message plus a step-by-step trace. Optional `response_schema` returns `message` as parsed JSON matching that shape.

- **Misc**
  - `GET /health`: Liveness check (no auth), returns `OK`.
  - `GET /docs/api`: This documentation (no auth).

### Example: Find Email

```bash
curl -X POST http://localhost:3000/find \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"first_name": "Juan", "last_name": "Garcia", "domain": "empresa.com"}'
```

### Example: Verify Email

```bash
curl -X POST http://localhost:3000/verify \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"email": "juan@empresa.com"}'
```

### Example: Detect Technologies

```bash
curl -X POST http://localhost:3000/detect-tech \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Response:**
```json
{
  "success": true,
  "url": "https://example.com",
  "cms": "WordPress 6.4",
  "ecommerce": "WooCommerce",
  "analytics": ["Google Analytics (GA4)", "Facebook Pixel"],
  "tag_managers": ["Google Tag Manager"],
  "frameworks": [],
  "marketing": ["HubSpot", "Intercom"],
  "advertising": ["Google Ads", "LinkedIn Insight Tag"],
  "payments": ["Stripe"],
  "cdn": ["Cloudflare"],
  "seo": ["Yoast SEO"],
  "privacy": ["OneTrust"],
  "otros": [],
  "resumen": "WordPress 6.4 | WooCommerce | Google Analytics (GA4) | Facebook Pixel | Google Tag Manager | HubSpot | Intercom | Google Ads | LinkedIn Insight Tag | Stripe | Cloudflare | Yoast SEO | OneTrust"
}
```

**Detected categories:**
| Field | Description |
|-------|-------------|
| `cms` | CMS platform (WordPress, Shopify, Wix, Webflow, etc.) |
| `ecommerce` | E-commerce platform (WooCommerce, Shopify, VTEX, Tiendanube) |
| `analytics` | Analytics tools (GA4, Facebook Pixel, Hotjar, Mixpanel, etc.) |
| `tag_managers` | Tag managers (Google Tag Manager) |
| `frameworks` | JS frameworks (empty — no Wappalyzer integration) |
| `marketing` | CRM & marketing tools (HubSpot, Intercom, Mailchimp, etc.) |
| `advertising` | Ad pixels (Google Ads, LinkedIn, TikTok, Pinterest, etc.) |
| `payments` | Payment integrations (Stripe, PayPal, MercadoPago) |
| `cdn` | CDN providers (Cloudflare, jsDelivr, unpkg) |
| `seo` | SEO plugins (Yoast SEO, RankMath) |
| `privacy` | Consent tools (OneTrust, CookieBot) |
| `resumen` | Human-readable summary of detected technologies |

### Example: Check Do Not Contact

```bash
curl -X POST http://localhost:3000/dnc/check \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"handle": "acme", "email": "juan@empresa.com"}'
```

## Email Finder — Cost per Lookup

Each lookup runs through a pipeline with up to 3 paid services. Actual cost depends on how quickly a valid email is found.

| Service | Cost per call | When it runs |
|---|---|---|
| Serper (SERP) | $0.001 | Always (1 search per domain) |
| EmailListVerify (Tier 1) | $0.0004 / email | Each permutation tested |
| Debounce (Tier 2) | $0.0015 / email | Cascade fallback or catch-all cross-validation |

**Estimated cost by scenario:**

| Scenario | Serper | ELV | Debounce | Total |
|---|---|---|---|---|
| Cache hit | — | — | — | **$0.000** |
| SERP direct match (1 ELV call) | $0.001 | $0.0004 | — | **$0.0014** |
| Found in 1st batch (5 perms) | $0.001 | $0.002 | — | **$0.003** |
| Catch-all domain (1 batch + Debounce) | $0.001 | $0.002 | $0.0015 | **$0.0045** |
| 2 batches, Tier 1 only | $0.001 | $0.004 | — | **$0.005** |
| Worst case (15 perms, both tiers) | $0.001 | $0.006 | $0.0225 | **$0.0295** |

**Typical cost: ~$0.003 per email** (SERP patterns prioritize the right permutation early).

## Roadmap

Not yet implemented in this API:
- `POST /find/batch` — Batch email finding (array of contacts, background processing).
- `POST /verify/batch` — Batch email verification.
- Tier 3 verification provider (NeverBounce).

See [`ROADMAP.md`](./ROADMAP.md) for the full phased plan: production hardening, a `/personalize` copy engine with per-client voice profiles, Instantly campaign integration, async enrichment jobs, and multi-tenant API keys/usage metering. The MCP server surface mentioned there is now live — see [MCP Server & agent access](#mcp-server--agent-access) above.

## MCP Server & agent access

Beyond the REST API, this service is exposed as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, so Claude Code, claude.ai, or any other MCP-capable agent can use it as a tool source directly — no custom HTTP client needed.

- **URL**: `<host>/mcp`
- **Transport**: Streamable HTTP (`StreamableHTTPServerTransport`), **stateless** — a fresh server+transport pair is created per request, no session id. `GET`/`DELETE /mcp` return `405` (nothing to open/close without sessions).
- **Auth**: same Bearer `API_KEY` as the REST API.
- **Tools** (16): `find_email`, `verify_email`, `get_profile`, `upsert_profile`, `get_company`, `upsert_company`, `detect_tech`, `find_linkedin`, `list_clients`, `create_client`, `dnc_check`, `dnc_add`, `dnc_list`, `generate_copy`, `explore`, `get_stats` — mirroring the REST endpoints above, calling straight into the service layer (no internal HTTP hop). Full descriptions/inputs are in `GET /docs/api` (section "MCP Server") and `GET /llms.txt`.

**Connect from Claude Code**:
```bash
claude mcp add --transport http clay-cache https://<host>/mcp --header "Authorization: Bearer <API_KEY>"
```

**Connect from claude.ai**: Settings → Connectors → Add custom connector → URL `https://<host>/mcp`, with header `Authorization: Bearer <API_KEY>`.

**`.mcp.json`**:
```json
{
  "mcpServers": {
    "clay-cache": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

`GET /llms.txt` (no auth) serves a compact, plain-text summary of the whole service (REST endpoints + MCP tools + agent rules) meant to be pasted directly into an agent's context.

## Testing

Run the test suite:
```bash
npm test
```

Standalone normalization verification scripts:
```bash
npx ts-node src/verify_normalization.ts # Profiles
npx ts-node src/verify_companies.ts     # Companies
```
