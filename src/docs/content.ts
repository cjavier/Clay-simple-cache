import { REST_ENDPOINTS_SUMMARY, MCP_TOOLS_SUMMARY, AGENT_RULES } from './agents';

export const apiDocumentation = `# Clay Cache API

**Identity cache · Email finder · Tech detection · LinkedIn resolver · Do Not Contact lists · GTM AI**

<a id="overview"></a>
## 1. Overview

This API is the internal data & automation backbone for a GTM (go-to-market) outbound agency. It combines:

- An **identity cache** for People (\`profiles\`) and **Companies**, resolved via email, LinkedIn, phone, or domain, with best-effort merging across enrichment sources.
- An **Email Finder** that generates and verifies likely email addresses for a person at a domain (pattern permutation + SERP discovery + multi-tier verification), plus a standalone email **Verify** endpoint.
- A **Tech Detector** that fingerprints a website's stack (CMS, ecommerce, analytics, ads, CRM, payments, etc.).
- A **LinkedIn Finder** that resolves a company domain to its LinkedIn company page.
- Per-client **Do Not Contact (DNC)** lists (individual emails or whole domains), with an optional \`dnc_client\` gate on the read/lookup endpoints.
- Two **AI endpoints** backed by DeepSeek: \`/copy\` (single-shot copywriting) and \`/explore\` (a tool-using research agent with web search + page fetch).

<a id="authentication"></a>
## 2. Authentication

Every endpoint **except** \`GET /health\` and \`GET /docs/api\` requires a Bearer API key.

**Header**: \`Authorization\`
**Value**: \`Bearer <API_KEY>\`

\`\`\`bash
curl -H "Authorization: Bearer your_secret_key" {{BASE_URL}}/profiles?email=test@example.com
\`\`\`

| Status | Body | Reason |
|---|---|---|
| \`401\` | \`{ "error": "Unauthorized: Missing or malformed Authorization header" }\` | Header missing or doesn't start with \`Bearer \`. |
| \`401\` | \`{ "error": "Unauthorized: Invalid API Key" }\` | Token doesn't match the server's \`API_KEY\`. |
| \`500\` | \`{ "error": "Internal Server Error: Security configuration missing" }\` | Server has no \`API_KEY\` configured (deployment issue, not a client error). |

---

<a id="toc"></a>
## 3. Table of Contents

- [1. Overview](#overview)
- [2. Authentication](#authentication)
- [3. Table of Contents](#toc)
- [4. Endpoints at a Glance](#glance)
- [5. Quick Start](#quick-start)
- [6. Cache — Profiles & Companies](#cache)
  - [\`POST /profiles\`](#profiles-post) · [\`GET /profiles\`](#profiles-get)
  - [\`POST /companies\`](#companies-post) · [\`GET /companies\`](#companies-get)
- [7. Email Finder](#email-finder)
  - [\`POST /find\`](#find-post) · [\`POST /verify\`](#verify-post) · [\`GET /stats\`](#stats-get)
- [8. Tech Detector](#tech-detector)
  - [\`POST /detect-tech\`](#detect-tech-post)
- [9. LinkedIn Finder](#linkedin-finder)
  - [\`POST /find-linkedin\`](#find-linkedin-post)
- [10. Clients & Do Not Contact (DNC)](#clients-dnc)
  - [\`POST /clients\`](#clients-post) · [\`GET /clients\`](#clients-get)
  - [\`POST /dnc\`](#dnc-post) · [\`POST /dnc/check\`](#dnc-check-post) · [\`GET /dnc\`](#dnc-get)
  - [\`dnc_client\` semantics](#dnc-client-semantics)
- [11. AI — Copy & Explore (DeepSeek)](#ai)
  - [\`POST /copy\`](#copy-post) · [\`POST /explore\`](#explore-post)
- [12. MCP Server](#mcp-server)
- [13. Errors & Limits](#errors-and-limits)
- [14. For AI Agents (llms.txt style)](#for-ai-agents)
- [15. Pending / Roadmap](#pending)

---

<a id="glance"></a>
## 4. Endpoints at a Glance

| Method | Path | Description | Section |
|---|---|---|---|
| \`POST\` | \`/profiles\` | Upsert/enrich a person profile by email, LinkedIn, or phone. | [Cache](#profiles-post) |
| \`GET\` | \`/profiles\` | Look up a profile; optional \`dnc_client\` gate. | [Cache](#profiles-get) |
| \`POST\` | \`/companies\` | Upsert/enrich a company by domain or LinkedIn. | [Cache](#companies-post) |
| \`GET\` | \`/companies\` | Look up a company; optional \`dnc_client\` gate. | [Cache](#companies-get) |
| \`POST\` | \`/find\` | Find the most likely email for a person at a domain. | [Email Finder](#find-post) |
| \`POST\` | \`/verify\` | Verify an existing email address. | [Email Finder](#verify-post) |
| \`GET\` | \`/stats\` | Aggregate email finder metrics. | [Email Finder](#stats-get) |
| \`POST\` | \`/detect-tech\` | Detect web technologies used by a URL. | [Tech Detector](#detect-tech-post) |
| \`POST\` | \`/find-linkedin\` | Resolve a domain to its LinkedIn company URL. | [LinkedIn Finder](#find-linkedin-post) |
| \`POST\` | \`/clients\` | Create a client (handle derived from \`name\`). | [Clients & DNC](#clients-post) |
| \`GET\` | \`/clients\` | List clients, or fetch one by \`?handle=\`. | [Clients & DNC](#clients-get) |
| \`POST\` | \`/dnc\` | Upload entries to a client's DNC list. | [Clients & DNC](#dnc-post) |
| \`POST\` | \`/dnc/check\` | Check if an email is on a client's DNC list. | [Clients & DNC](#dnc-check-post) |
| \`GET\` | \`/dnc\` | List a client's DNC entries. | [Clients & DNC](#dnc-get) |
| \`POST\` | \`/copy\` | Generate copy from a prompt (DeepSeek). | [AI](#copy-post) |
| \`POST\` | \`/explore\` | Run a research agent (SERP + page fetch, DeepSeek). | [AI](#explore-post) |
| \`POST\` | \`/mcp\` | MCP (Model Context Protocol) JSON-RPC endpoint — Streamable HTTP, stateless. | [MCP Server](#mcp-server) |
| \`GET\`/\`DELETE\` | \`/mcp\` | \`405\` — this MCP server is stateless (no sessions to fetch/delete). | [MCP Server](#mcp-server) |
| \`GET\` | \`/llms.txt\` | Machine-readable service summary for LLM agents (no auth). | [MCP Server](#mcp-server) |
| \`GET\` | \`/health\` | Liveness check (no auth). Returns \`OK\`. | — |
| \`GET\` | \`/docs/api\` | This page (no auth). | — |
| \`GET\` | \`/\` | Redirects to \`/docs/api\`. | — |

---

<a id="quick-start"></a>
## 5. Quick Start

\`\`\`bash
# 1. Look up a cached profile by email
curl -H "Authorization: Bearer your_secret_key" \\
  "{{BASE_URL}}/profiles?email=juan@empresa.com"

# 2. Find the most likely email for a person at a domain
curl -X POST "{{BASE_URL}}/find" \\
  -H "Authorization: Bearer your_secret_key" \\
  -H "Content-Type: application/json" \\
  -d '{"first_name": "Juan", "last_name": "Garcia", "domain": "empresa.com"}'

# 3. Check a client's Do Not Contact list before reaching out
curl -X POST "{{BASE_URL}}/dnc/check" \\
  -H "Authorization: Bearer your_secret_key" \\
  -H "Content-Type: application/json" \\
  -d '{"handle": "acme", "email": "juan@empresa.com"}'
\`\`\`

---

<a id="cache"></a>
## 6. Cache — Profiles & Companies

Best-effort identity resolution: upsert with any subset of known identifiers, and later look records up by whichever identifier you have. New data is **merged** into existing records rather than overwritten.

<a id="profiles-post"></a>
### \`POST /profiles\` — Upsert Profile

Create or update a profile. Looks for an existing record by any provided identifier (in priority order **email > linkedin_url > linkedin_slug > phone**); if found, merges new fields into it, otherwise creates a new profile.

**Body (JSON)**:
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| \`email\` | string | No* | — | Lowercased on save. |
| \`linkedin_url\` | string | No* | — | Full LinkedIn profile URL; slug is extracted and stored alongside the full URL. |
| \`linkedin_profile\` | string | No* | — | Alias for \`linkedin_url\`. |
| \`phone\` | string | No* | — | Normalized to E.164 (via \`libphonenumber-js\`). |
| ...anything else | any | No | — | Stored verbatim in the \`data\` object and merged with existing data on future calls. |

\\* At least one of \`email\`, \`linkedin_url\`/\`linkedin_profile\`, or \`phone\` is required.

**Response — \`200\`**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "email",
  "profile_id": "1f2e-uuid",
  "saved_data": {
    "id": "1f2e-uuid",
    "email": "juan@empresa.com",
    "linkedin_slug": "juan-garcia",
    "linkedin_url": "https://www.linkedin.com/in/juan-garcia",
    "phone_e164": "+525512345678",
    "data": { "title": "VP Sales", "linkedin_url": "...", "phone_national": "..." }
  }
}
\`\`\`
\`resolved_by\` is one of \`email\` \\| \`linkedin_url\` \\| \`linkedin_slug\` \\| \`phone_e164\` \\| \`new\` (freshly created) \\| \`race\` (a concurrent request won the create and this call merged into it).

**Errors**: \`400\` \`{ "error": "At least one identity key (email, linkedin_url, phone) is required." }\`; \`500\` on unexpected failure.

\`\`\`bash
curl -X POST {{BASE_URL}}/profiles \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{"email": "juan@empresa.com", "linkedin_url": "https://linkedin.com/in/juan-garcia", "title": "VP Sales"}'
\`\`\`

<a id="profiles-get"></a>
### \`GET /profiles\` — Get Profile

**Query params** (any one): \`email\`, \`linkedin\` (URL or slug, also accepts \`linkedin_url\`), \`phone\`. Optional: \`dnc_client\` — see [\`dnc_client\` semantics](#dnc-client-semantics).

**Response — Found (\`200\`)**: fields from the stored \`data\` object are spread at the root, then overwritten by the canonical columns:
\`\`\`json
{
  "result": 1,
  "title": "VP Sales",
  "id": "1f2e-uuid",
  "email": "juan@empresa.com",
  "linkedin_slug": "juan-garcia",
  "phone": "+525512345678",
  "updated_at": "2026-07-01T12:00:00.000Z"
}
\`\`\`

**Response — Not found (\`200\`)**:
\`\`\`json
{
  "result": null,
  "message": "No records found",
  "search_criteria": { "email": "juan@empresa.com", "linkedin_url": null, "linkedin_slug": null, "phone_e164": null }
}
\`\`\`

**With \`?dnc_client=acme\`** — either the client isn't found (\`404\`), the contact is blocked (\`200\`, body is *only* \`{ "do_not_contact": true, "matched_by": "email" }\`), or the normal response above with an added \`"do_not_contact": false\`.

\`\`\`bash
curl -H "Authorization: Bearer your_secret_key" \\
  "{{BASE_URL}}/profiles?email=juan@empresa.com&dnc_client=acme"
\`\`\`

<a id="companies-post"></a>
### \`POST /companies\` — Upsert Company

Same merge semantics as profiles, resolved by **domain > linkedin_slug**.

**Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`domain\` | string | No* | Normalized: trimmed, lowercased, \`www.\`/protocol stripped. |
| \`linkedin_url\` | string | No* | Company LinkedIn URL; slug extracted. |
| ...anything else | any | No | Stored/merged into \`data\`. |

\\* At least one of \`domain\` or \`linkedin_url\` is required.

**Response — \`200\`**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "domain",
  "company_id": "9a1c-uuid",
  "saved_data": {
    "id": "9a1c-uuid",
    "domain": "empresa.com",
    "linkedin_slug": "empresa-inc",
    "data": { "industry": "SaaS", "linkedin_url": "..." }
  }
}
\`\`\`
\`resolved_by\`: \`domain\` \\| \`linkedin_slug\` \\| \`new\` \\| \`race\`.

**Errors**: \`400\` \`{ "error": "At least one identifier (domain, linkedin_url) is required." }\`.

<a id="companies-get"></a>
### \`GET /companies\` — Get Company

**Query params**: \`domain\`, \`linkedin\` (or \`linkedin_url\`). Optional \`dnc_client\` — same [semantics](#dnc-client-semantics) as \`GET /profiles\`, but checked against the company's **domain** (\`matched_by\` will be \`"domain"\` when blocked).

**Response — Found (\`200\`)**: same spread pattern as profiles (\`data\` fields at root, then \`id\`, \`domain\`, \`linkedin_slug\`, \`updated_at\`).

**Response — Not found (\`200\`)**: \`{ "result": null, "message": "No records found", "search_criteria": { "domain": "...", "linkedin_slug": "..." } }\`.

---

<a id="email-finder"></a>
## 7. Email Finder

Given a name and a domain, generates likely email permutations (15 patterns, LATAM-name-aware), tries to shortcut via SERP pattern discovery, and verifies candidates through a cost-tiered provider cascade (EmailListVerify → Debounce). Results and learned patterns are cached.

<a id="find-post"></a>
### \`POST /find\` — Find Email

**Body (JSON)**:
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| \`domain\` | string | **Yes** | — | Company domain, e.g. \`"empresa.com"\`. |
| \`first_name\` | string | No* | — | |
| \`last_name\` | string | No* | — | |
| \`full_name\` | string | No* | — | Parsed with LATAM-aware name-splitting logic. |
| \`max_tier\` | number | No | \`2\` | Max verification tier to use (\`1\` or \`2\`). |
| \`dnc_client\` | string | No | — | Client handle; see [\`dnc_client\` semantics](#dnc-client-semantics). Checked against the request \`domain\` **before** the search runs, and again against the found \`email\` before responding. |

\\* At least one of \`first_name\`, \`last_name\`, \`full_name\` is required.

**Response — \`200\`**:
\`\`\`json
{
  "success": true,
  "email": "juan.garcia@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "pattern": "first.last",
  "domain_info": {
    "domain": "empresa.com",
    "has_mx": true,
    "mx_records": ["aspmx.l.google.com"],
    "provider": "google_workspace",
    "is_catch_all": false,
    "is_disposable": false,
    "is_free_provider": false,
    "smtp_verifiable": true
  },
  "serp_info": {
    "used": true,
    "emails_found": 3,
    "patterns_detected": [{ "pattern": "first.last", "count": 2, "examples": ["ana.lopez@empresa.com"] }],
    "direct_match": null
  },
  "permutations_tried": 1,
  "cost_usd": 0.0004,
  "duration_ms": 983
}
\`\`\`
\`status\`: \`valid\` \\| \`invalid\` \\| \`catch_all\` \\| \`unknown\` \\| \`risky\` \\| \`disposable\` \\| \`no_mx\` \\| \`role_account\`.
\`method\`: \`local_syntax\` \\| \`local_dns\` \\| \`emaillistverify\` \\| \`debounce\` \\| \`bouncer\` \\| \`neverbounce\` \\| \`serp_pattern\`.

If \`dnc_client\` was sent and matched, the response is **only** \`{ "do_not_contact": true, "matched_by": "domain" | "email" }\` — no email/cost data leaks. Otherwise the response above gains \`"do_not_contact": false\`.

**Errors**: \`400\` missing \`domain\`; \`400\` missing name fields; \`404\` \`dnc_client\` handle not found; \`500\` unexpected.

<a id="verify-post"></a>
### \`POST /verify\` — Verify Email

**Body (JSON)**:
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| \`email\` | string | **Yes** | — | Email to verify. |
| \`max_tier\` | number | No | \`2\` | Max verification tier (\`1\` or \`2\`). |
| \`dnc_client\` | string | No | — | Checked against \`email\` before verifying; see [semantics](#dnc-client-semantics). |

**Response — \`200\`**:
\`\`\`json
{
  "email": "juan@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "domain_info": { "domain": "empresa.com", "has_mx": true, "provider": "google_workspace", "is_catch_all": false, "is_disposable": false, "is_free_provider": false },
  "cost_usd": 0.0004,
  "duration_ms": 450
}
\`\`\`
Blocked case: only \`{ "do_not_contact": true, "matched_by": "..." }\`. Otherwise adds \`"do_not_contact": false\`.

**Errors**: \`400\` missing \`email\`; \`404\` \`dnc_client\` not found.

<a id="stats-get"></a>
### \`GET /stats\` — Aggregate Metrics

No params. Returns totals across all searches ever run.

\`\`\`json
{
  "total_searches": 100,
  "total_valid_found": 15,
  "success_rate": 0.15,
  "methods_breakdown": { "emaillistverify": 12, "debounce": 3 },
  "total_cost_usd": 0.099,
  "avg_cost_per_email": 0.00099,
  "domains_in_cache": 93,
  "patterns_learned": 8,
  "catch_all_domains": 17
}
\`\`\`

---

<a id="tech-detector"></a>
## 8. Tech Detector

<a id="detect-tech-post"></a>
### \`POST /detect-tech\` — Detect Technologies

Fetches a URL's HTML and fingerprints its stack via regex pattern matching (no headless browser, no Wappalyzer).

**Body (JSON)**: \`url\` (string, **required**) — full URL, e.g. \`"https://example.com"\`.

\`\`\`bash
curl -X POST {{BASE_URL}}/detect-tech \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'
\`\`\`

**Response — success (\`200\`)**:
\`\`\`json
{
  "success": true,
  "url": "https://example.com",
  "cms": "WordPress 6.4",
  "ecommerce": "WooCommerce",
  "analytics": ["Google Analytics (GA4)", "Facebook Pixel", "Hotjar"],
  "tag_managers": ["Google Tag Manager"],
  "frameworks": [],
  "marketing": ["HubSpot", "Intercom"],
  "advertising": ["Google Ads", "LinkedIn Insight Tag"],
  "payments": ["Stripe"],
  "cdn": ["Cloudflare"],
  "seo": ["Yoast SEO"],
  "privacy": ["CookieBot"],
  "otros": [],
  "resumen": "WordPress 6.4 | WooCommerce | Google Analytics (GA4) | Facebook Pixel | ..."
}
\`\`\`

**Response — fetch failed (\`200\`, \`success: false\`)** — pipelines can branch on this without treating it as an HTTP error:
\`\`\`json
{
  "success": false,
  "url": "https://broken-site.com",
  "reason": "domain_not_found",
  "http_status": 404,
  "message": "DNS: domain not found",
  "technologies": "",
  "scripts": [],
  "links": [],
  "meta": []
}
\`\`\`
\`reason\`: \`blocked_by_site\` \\| \`rate_limited_by_site\` \\| \`site_unavailable\` \\| \`domain_not_found\` \\| \`ssl_error\` \\| \`timeout\` \\| \`network_error\`. \`http_status\` is only present when the target site responded with a non-2xx status.

**Errors**: \`400\` \`{ "error": "url is required" }\`; \`400\` \`{ "error": "Invalid URL format" }\`; \`500\` unexpected server error.

---

<a id="linkedin-finder"></a>
## 9. LinkedIn Finder

<a id="find-linkedin-post"></a>
### \`POST /find-linkedin\` — Resolve Domain → LinkedIn Company

Searches Google (via Serper) for \`site:linkedin.com/company "<domain>"\` and picks the best-matching company page.

**Body (JSON)**: \`url\` or \`domain\` (string, **required**) — either works, both are normalized to a domain.

\`\`\`bash
curl -X POST {{BASE_URL}}/find-linkedin \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{"domain": "empresa.com"}'
\`\`\`

**Response — success (\`200\`)**:
\`\`\`json
{
  "success": true,
  "input": "empresa.com",
  "domain": "empresa.com",
  "linkedin_url": "https://www.linkedin.com/company/empresa-inc",
  "linkedin_slug": "empresa-inc",
  "match_type": "domain_in_url",
  "candidates": [{ "url": "https://www.linkedin.com/company/empresa-inc", "slug": "empresa-inc", "title": "Empresa Inc | LinkedIn", "snippet": "..." }],
  "cost_usd": 0.001
}
\`\`\`
\`match_type\`: \`domain_in_url\` (slug contains the domain's root name) \\| \`domain_in_snippet\` (domain mentioned in title/snippet) \\| \`first_result\` (fallback to Google's top hit).

**Response — no match / error (\`200\`, \`success: false\`)**:
\`\`\`json
{ "success": false, "input": "empresa.com", "domain": "empresa.com", "linkedin_url": null, "linkedin_slug": null, "reason": "no_results", "message": "No LinkedIn company pages found", "cost_usd": 0.001 }
\`\`\`
\`reason\`: \`invalid_input\` \\| \`missing_api_key\` \\| \`serper_error\` \\| \`no_results\`.

**Errors**: \`400\` \`{ "error": "url or domain is required" }\`; \`503\` (body is the \`missing_api_key\` result above) when \`SERPER_API_KEY\` isn't configured; \`500\` unexpected.

---

<a id="clients-dnc"></a>
## 10. Clients & Do Not Contact (DNC)

Each client is identified by a readable **handle**: \`name\` lowercased, accents stripped, non-alphanumeric characters collapsed to hyphens (\`"Acme Corp México"\` → \`acme-corp-mexico\`). The handle is the id used everywhere else (\`dnc_client\`, \`/dnc*\` bodies).

Two DNC list types:
- **individual** — specific person emails.
- **domain** — whole company domains. Submitting an *email* to a domain list decomposes it: the domain is blocked and the original email kept for reference.

A check matches if the email itself was listed **or** its domain is blocked on a domain list.

<a id="clients-post"></a>
### \`POST /clients\` — Create Client

**Body (JSON)**: \`name\` (string, **required**) — handle is derived from it; any other fields are stored in \`data\`.

**Response — \`201\`**:
\`\`\`json
{
  "status": "ok",
  "client": { "id": "uuid", "handle": "acme-corp-mexico", "name": "Acme Corp México", "data": {}, "created_at": "...", "updated_at": "..." }
}
\`\`\`

**Errors**: \`400\` \`{ "error": "name is required." }\`; \`409\` \`{ "error": "client_already_exists", "message": "...", "handle": "...", "client": { ... } }\`.

<a id="clients-get"></a>
### \`GET /clients\` — List / Get Clients

No params → lists all. \`?handle=<handle>\` → fetch one (handle is normalized before lookup).

**Response — list**: \`{ "result": <count>, "clients": [ ... ] }\`
**Response — single**: \`{ "result": 1, "client": { ... } }\`

**Errors**: \`404\` \`{ "error": "client_not_found", "message": "...", "handle": "...", "suggestions": ["acme", "acme-inc"] }\` — \`suggestions\` are similar existing handles (substring/Levenshtein match).

<a id="dnc-post"></a>
### \`POST /dnc\` — Upload to a DNC List

**Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`handle\` | string | Yes | Client handle. |
| \`list_type\` | string | Yes | \`individual\` or \`domain\`. |
| \`entries\` | string[] | Yes* | Values to add. |
| \`entry\` / \`email\` / \`domain\` | string | Yes* | Convenience single-value alternatives, combinable with \`entries\`. |

\\* At least one value across \`entries\`/\`entry\`/\`email\`/\`domain\` is required. Invalid values are skipped and reported; duplicates (within the batch or already stored) are skipped silently.

**Response — \`200\`**:
\`\`\`json
{
  "status": "ok",
  "handle": "acme",
  "list_type": "domain",
  "added": 1,
  "skipped_duplicates": 0,
  "invalid": [],
  "entries": [{ "list_type": "domain", "email": "spammer@evilcorp.com", "domain": "evilcorp.com" }]
}
\`\`\`

**Errors**: \`400\` invalid/missing \`list_type\`; \`400\` no entries supplied; \`404\` \`client_not_found\`.

<a id="dnc-check-post"></a>
### \`POST /dnc/check\` — Check the DNC List

**Body (JSON)**: \`handle\` (string, required), \`email\` (string, required).

**Response — \`200\`** (whenever the client exists):
\`\`\`json
{ "handle": "acme", "email": "anyone@evilcorp.com", "do_not_contact": true, "matched_by": "domain" }
\`\`\`
\`matched_by\`: \`"email"\` \\| \`"domain"\` \\| \`null\`.

**Errors**: \`400\` missing \`email\`; \`400\` missing \`handle\`; \`404\` \`client_not_found\`.

<a id="dnc-get"></a>
### \`GET /dnc\` — List DNC Entries

**Query**: \`handle\` (required), \`list_type\` (optional, \`individual\` \\| \`domain\`).

**Response**: \`{ "handle": "acme", "result": <count>, "entries": [{ "id": "...", "client_id": "...", "list_type": "domain", "email": "...|null", "domain": "...|null", "created_at": "..." }] }\`

**Errors**: \`400\` invalid \`list_type\`; \`404\` \`client_not_found\` (also triggered by a missing/blank \`handle\`, since it's resolved the same way).

<a id="dnc-client-semantics"></a>
### \`dnc_client\` semantics (on \`GET /profiles\`, \`GET /companies\`, \`POST /find\`, \`POST /verify\`)

Pass \`dnc_client=<handle>\` to gate a lookup behind a client's DNC list, in one call instead of two:

1. \`dnc_client\` doesn't resolve to a known client → \`404\` \`{ "error": "client_not_found", "handle": "...", "suggestions": [...] }\`.
2. The contact/domain **is** on that client's DNC list → \`200\` with a **minimal** body: \`{ "do_not_contact": true, "matched_by": "email" | "domain" }\`. No profile/company/email data is included.
3. Otherwise → the endpoint's normal response, with \`"do_not_contact": false\` added.

This lets a single call answer "do we have this contact, and are we even allowed to reach them?" without ever leaking suppressed contact data.

---

<a id="ai"></a>
## 11. AI — Copy & Explore (DeepSeek)

Both endpoints call the DeepSeek chat completions API (OpenAI-compatible) and require \`DEEPSEEK_API_KEY\` to be configured server-side.

<a id="copy-post"></a>
### \`POST /copy\` — Generate Copy

Single-shot prompt → copy generation, defaulted to a direct-response B2B outbound copywriter persona.

**Body (JSON)**:
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| \`prompt\` | string | **Yes** | — | The user prompt/brief. |
| \`system\` | string | No | Built-in B2B copywriter system prompt | Override the system prompt. |
| \`model\` | string | No | \`"deepseek-v4-flash"\` | DeepSeek model name. |
| \`temperature\` | number | No | provider default | Passed through to DeepSeek. |
| \`max_tokens\` | number | No | provider default | Passed through to DeepSeek. |
| \`response_schema\` | object | No | — | A JSON structure/shape describing the desired output (a literal example object works, e.g. \`{"description": "string", "top_problems": ["string","string","string"]}\`). When set, \`response\` is the **parsed JSON object** matching it instead of a plain string. Best-effort: DeepSeek guarantees valid JSON syntax, not schema conformance — if it returns malformed JSON, \`response\` falls back to the raw string and a \`warning\` field is added. |

\`\`\`bash
curl -X POST {{BASE_URL}}/copy \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{"prompt": "Write a 2-line cold email opener for a VP Sales at a Series B SaaS company."}'
\`\`\`

**Response — \`200\`**:
\`\`\`json
{
  "response": "Hi {{first_name}} — noticed {{company}} just closed its Series B...",
  "model": "deepseek-v4-flash",
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 48,
    "total_tokens": 168,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 120,
    "cost_usd": 0.00003024
  },
  "duration_ms": 1450
}
\`\`\`
\`usage.cost_usd\` is computed from DeepSeek's per-model token pricing (cache-hit/cache-miss input rates + output rate); it's \`null\` if a custom \`model\` isn't in the known pricing table.

**Structured output example**:
\`\`\`bash
curl -X POST {{BASE_URL}}/copy \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Describe empresa.com'\\''s customer service and their top 3 problems.",
    "response_schema": { "description": "string", "top_problems": ["string", "string", "string"] }
  }'
\`\`\`
\`\`\`json
{
  "response": {
    "description": "empresa.com runs a small support team handling tickets via email and chat.",
    "top_problems": ["Slow first response time", "No self-service knowledge base", "Inconsistent escalation process"]
  },
  "model": "deepseek-v4-flash",
  "usage": { "...": "..." },
  "duration_ms": 1800
}
\`\`\`

**Errors**: \`400\` \`{ "error": "prompt is required" }\`; \`400\` \`{ "error": "response_schema must be a JSON object" }\`; \`503\` \`{ "error": "DEEPSEEK_API_KEY is not configured" }\`; \`502\` \`{ "error": "DeepSeek API error (...)" }\` on upstream failure; \`500\` unexpected.

<a id="explore-post"></a>
### \`POST /explore\` — Research Agent

Runs a tool-using agent loop: DeepSeek can call \`serp_search\` (Google via Serper) and \`fetch_page\` (fetch + strip HTML, SSRF-guarded — blocks localhost/private/link-local IPs and DNS-rebinding, 3 redirects max, ~8000-char truncation) until it produces a final answer.

**Body (JSON)**:
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| \`prompt\` | string | **Yes** | — | The research question/task. |
| \`max_steps\` | number | No | \`8\` | Max tool calls before forcing a final answer. Hard-capped at \`15\` regardless of the value sent. |
| \`reasoning\` | boolean | No | \`true\` | DeepSeek thinking mode. When enabled, each step's \`reasoning\` carries the model's chain of thought. Set \`false\` for a slightly faster, non-reasoning run. |
| \`model\` | string | No | \`"deepseek-v4-flash"\` | DeepSeek model name. |
| \`response_schema\` | object | No | — | A JSON structure/shape describing the desired final answer (e.g. \`{"answer": "string", "sources": ["string"]}\`). When set, the agent researches normally and then reformats its final answer with one extra (non-tool) model call — \`message\` becomes the **parsed JSON object** matching it instead of a plain string, and that extra call's tokens are included in \`usage\`. Best-effort, not schema-validated; malformed output falls back to \`{"error": "...", "raw": "..."}\`. |

\`\`\`bash
curl -X POST {{BASE_URL}}/explore \\
  -H "Authorization: Bearer your_secret_key" -H "Content-Type: application/json" \\
  -d '{"prompt": "What CRM does empresa.com use, and since when publicly?", "max_steps": 6}'
\`\`\`

**Response — \`200\`**:
\`\`\`json
{
  "message": "empresa.com uses HubSpot; their careers page has referenced it since at least 2023.",
  "steps": [
    { "step": 1, "tool": "serp_search", "input": { "query": "empresa.com CRM HubSpot" }, "output_summary": "query: empresa.com CRM HubSpot, organic: [...]", "reasoning": "I should search for public mentions first." },
    { "step": 2, "tool": "fetch_page", "input": { "url": "https://empresa.com/careers" }, "output_summary": "Careers ... HubSpot ..." }
  ],
  "total_steps": 2,
  "usage": {
    "prompt_tokens": 900,
    "completion_tokens": 210,
    "total_tokens": 1110,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 900,
    "cost_usd": 0.0001848
  },
  "duration_ms": 6200
}
\`\`\`
Each step's \`reasoning\` is the assistant's message content accompanying that tool call (often empty). \`output_summary\` is the tool's JSON/text output truncated to 300 characters. \`usage.cost_usd\` is \`null\` if a custom \`model\` isn't in the known DeepSeek pricing table.

With \`response_schema\`, \`message\` looks like:
\`\`\`json
{ "message": { "answer": "empresa.com uses HubSpot; their careers page has referenced it since at least 2023." }, "...": "..." }
\`\`\`

**Errors**: \`400\` \`{ "error": "prompt is required" }\`; \`400\` \`{ "error": "max_steps must be a positive number" }\`; \`400\` \`{ "error": "model must be a string" }\`; \`400\` \`{ "error": "response_schema must be a JSON object" }\`; \`503\` \`{ "error": "DEEPSEEK_API_KEY is not configured" }\`; \`502\` upstream DeepSeek failure; \`500\` unexpected.

---

<a id="mcp-server"></a>
## 12. MCP Server

This service is also exposed as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, so it can be wired directly into Claude Code, claude.ai, or any other MCP-capable agent as a tool source — no custom REST client needed.

- **URL**: \`{{BASE_URL}}/mcp\`
- **Transport**: Streamable HTTP (\`StreamableHTTPServerTransport\`), **stateless** — every request creates a fresh server+transport pair, there is no session to keep alive. \`GET\`/\`DELETE\` on \`/mcp\` return \`405\` (nothing to fetch/delete without sessions).
- **Auth**: same Bearer API key as the REST API — header \`Authorization: Bearer <API_KEY>\` on the HTTP connection/request.
- **Protocol**: standard JSON-RPC 2.0 MCP messages (\`initialize\`, \`tools/list\`, \`tools/call\`, ...).

**Tools** (16 total — same underlying logic as the REST endpoints above, called directly against the service layer):

| Tool | Input | Description |
|---|---|---|
| \`find_email\` | \`{first_name?,last_name?,full_name?,domain,max_tier?,dnc_client?}\` | Find + verify a person's most likely email at a domain. Costs money; DNC-gated. |
| \`verify_email\` | \`{email,max_tier?,dnc_client?}\` | Verify deliverability of an existing email. Costs money; DNC-gated. |
| \`get_profile\` | \`{email?,linkedin?,phone?,dnc_client?}\` | Read-only cache lookup for a person profile. |
| \`upsert_profile\` | \`{email?,linkedin_url?,phone?,data?}\` | Save/enrich a person profile in the cache. |
| \`get_company\` | \`{domain?,linkedin_slug?,dnc_client?}\` | Read-only cache lookup for a company. |
| \`upsert_company\` | \`{domain?,linkedin_slug?,data?}\` | Save/enrich a company in the cache. |
| \`detect_tech\` | \`{url}\` | Fingerprint a site's CMS/ecommerce/analytics/ads stack. |
| \`find_linkedin\` | \`{domain}\` | Resolve a domain to its LinkedIn company URL. |
| \`list_clients\` | \`{}\` | Read-only list of clients and their handles. |
| \`create_client\` | \`{name,handle?}\` | Create a client (handle derived from name if omitted). |
| \`dnc_check\` | \`{client,email}\` | Read-only Do Not Contact check — call before contacting a lead in a client campaign. |
| \`dnc_add\` | \`{client,list_type,entries[]}\` | Add emails/domains to a client's Do Not Contact list. |
| \`dnc_list\` | \`{client,list_type?}\` | Read-only listing of a client's Do Not Contact entries. |
| \`generate_copy\` | \`{prompt,system?,temperature?,max_tokens?,response_schema?}\` | Generate B2B outbound copy via DeepSeek. Returns token usage + \`cost_usd\`; with \`response_schema\`, \`response\` is a parsed JSON object. |
| \`explore\` | \`{prompt,max_steps?,response_schema?}\` | Run a web-research agent (SERP + page fetch) and return its findings, token usage + \`cost_usd\`. With \`response_schema\`, \`message\` is a parsed JSON object. |
| \`get_stats\` | \`{}\` | Read-only aggregate email finder usage/cost metrics. |

**Connecting from Claude Code**:
\`\`\`bash
claude mcp add --transport http clay-cache {{BASE_URL}}/mcp --header "Authorization: Bearer <API_KEY>"
\`\`\`

**Connecting from claude.ai**: Settings → Connectors → Add custom connector → URL \`{{BASE_URL}}/mcp\`, with an \`Authorization: Bearer <API_KEY>\` header.

**\`.mcp.json\`** (for projects that check in MCP config):
\`\`\`json
{
  "mcpServers": {
    "clay-cache": {
      "type": "http",
      "url": "{{BASE_URL}}/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
\`\`\`

See also \`GET /llms.txt\` for a compact, plain-text version of this whole page meant to be pasted directly into an agent's context.

---

<a id="errors-and-limits"></a>
## 13. Errors & Limits

**Error format**: every error is JSON with an \`error\` string field (occasionally with extra context fields like \`handle\`/\`suggestions\` on \`404\`s). Tech Detector fetch failures are the one exception — those return \`200\` with \`success: false\` so pipelines can branch without treating them as transport errors.

**Common status codes**:
| Status | Meaning |
|---|---|
| \`400\` | Bad request — missing/invalid field. Body explains which. |
| \`401\` | Missing/invalid Bearer API key. |
| \`404\` | Referenced client handle (\`dnc_client\`/\`handle\`) doesn't exist. |
| \`409\` | \`POST /clients\` — handle already taken. |
| \`429\` | Rate limit exceeded (see below). |
| \`500\` | Unexpected server error, or missing \`API_KEY\` server config. |
| \`502\` | Upstream provider failure (DeepSeek). |
| \`503\` | Required upstream API key not configured (DeepSeek, or Serper for \`/find-linkedin\`). |
| \`504\` | Target URL timed out (\`/detect-tech\`, 15s limit). |

**Rate limits** (per IP, sliding 60s window, \`express-rate-limit\` with \`RateLimit-*\` response headers):
| Scope | Default limit | Env override | Applies to |
|---|---|---|---|
| Global | 300 req/min | \`RATE_LIMIT_PER_MIN\` | Every route. |
| Costly | 30 req/min | \`COSTLY_RATE_LIMIT_PER_MIN\` | \`/find\`, \`/verify\`, \`/detect-tech\`, \`/copy\`, \`/explore\`, \`/find-linkedin\` (stacked on top of the global limit). |

Exceeding a limit returns \`429\` with the plain-text body \`Too many requests, please try again later.\`

**Body size limit**: JSON request bodies are capped at **1mb** (\`express.json({ limit: '1mb' })\`); oversized bodies are rejected before reaching any controller.

**CORS**: open by default; restricted to \`ALLOWED_ORIGINS\` (comma-separated) when that env var is set.

---

<a id="for-ai-agents"></a>
## 14. For AI Agents

Machine-readable one-liner per endpoint. Base URL: \`{{BASE_URL}}\`. Auth: header \`Authorization: Bearer <API_KEY>\` on every line below (omit only for \`/health\`, \`/docs/api\`, and \`/llms.txt\`).

\`\`\`
${REST_ENDPOINTS_SUMMARY}
\`\`\`

This same service is also reachable as an **MCP server** at \`{{BASE_URL}}/mcp\` (Streamable HTTP, stateless, same Bearer auth) — see [12. MCP Server](#mcp-server). Tools, one-liner each:

\`\`\`
${MCP_TOOLS_SUMMARY}
\`\`\`

${AGENT_RULES}

A plain-text, agent-friendly version of this whole summary (REST + MCP) is also served at \`GET /llms.txt\` (no auth) — convenient to paste directly into an agent's system prompt or fetch at connection time.

---

<a id="pending"></a>
## 15. Pending / Roadmap

Not yet implemented in this API:
- **\`POST /find/batch\`** — batch email finding (array of contacts, background processing).
- **\`POST /verify/batch\`** — batch email verification.
- **Tier 3 verification** — NeverBounce provider.

See \`ROADMAP.md\` in the repo for the full phased plan (hardening, \`/personalize\`, Instantly integration, async jobs, multi-tenant API keys, and more). The MCP server surface mentioned there is now live — see [12. MCP Server](#mcp-server).
`;
