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
  - Given a name + domain, generates email permutations (15 patterns, LATAM-aware).
  - SERP-based pattern discovery: searches Google for `"@domain.com"` to find real emails and identify the domain's pattern before brute-forcing.
  - Cross-references multiple SERP emails to resolve ambiguous patterns (flast vs lastf, etc.).
  - Multi-tier API verification cascade (EmailListVerify, DeBounce).
  - Smart catch-all handling: uses SERP patterns + Debounce cross-validation instead of blind guessing.
  - Domain intelligence: MX lookup, provider detection, disposable/free checks.
  - Pattern learning: remembers verified patterns per domain for faster future lookups. `scripts/backfill_domain_patterns.ts` seeds this table from the verified emails already in `profiles`, at no API cost.
  - LATAM naming: compound surnames are split paternal-first (`Juan Pérez García` → `juan.perez@` before `juan.perezgarcia@`), which matches our own verified data 6.6:1, and particles are glued rather than treated as surnames (`de la Torre` → `delatorre`, never `la`).
  - Pattern prevalence is measured from the 149k verified emails in `profiles`, not estimated.
  - Verification caching (30 days) and domain intel caching (7 days).
  - Parallel verification for speed (batches of 5 concurrent API calls).
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
  - `src/jobs/check-credits.ts` runs daily on Railway (service `credit-check-cron`, `0 14 * * *` UTC = 08:00 CDMX), records every check in `provider_credits`, and posts to Slack when something is wrong or has just recovered. All-green runs stay silent on purpose.
  - The cron service runs `node dist/jobs/check-credits.js` with restart policy `NEVER` — the job exits non-zero when a provider is red, and restarting on failure would re-post to Slack in a loop.
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
