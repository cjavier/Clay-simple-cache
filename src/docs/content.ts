export const apiDocumentation = `# Identity Cache & Enrichment API

## Overview
This API allows storing, retrieving, and resolving identity profiles (People) and companies.
It uses a "best-effort" resolution strategy based on multiple identifiers (Email, LinkedIn, Phone, Domain).

## Base URL
\`{{BASE_URL}}\`

## Authentication
All endpoints (except \`/health\` and \`/docs/api\`) require an API Key passed via the \`Authorization\` header using the **Bearer** scheme.

**Header**: \`Authorization\`
**Value**: \`Bearer <your_api_key>\`

Example:
\`\`\`bash
curl -H "Authorization: Bearer your_secret_key" {{BASE_URL}}/profiles?email=test@example.com
\`\`\`

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`401\` | \`{ "error": "Unauthorized: Missing or malformed Authorization header" }\` | Header is missing or does not start with \`Bearer \`. |
| \`401\` | \`{ "error": "Unauthorized: Invalid API Key" }\` | The token does not match the server's API key. |

---

## Endpoints

### 1. Upsert Profile
**POST** \`/profiles\`

Create or update a profile record. The API will try to find an existing profile by any of the provided identifiers. If found, it merges the new data into the existing record. Otherwise, it creates a new profile.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`email\` | String | No* | Person's email. Will be lowercased. |
| \`linkedin_url\` | String | No* | LinkedIn profile URL. Slug will be extracted and full URL stored. |
| \`linkedin_profile\` | String | No* | Alias for \`linkedin_url\`. |
| \`phone\` | String | No* | Phone number. Will be normalized to E.164. |
| \`...\` | Any | No | Any additional fields will be stored in the \`data\` object. |

*At least one of \`email\`, \`linkedin_url\`, or \`phone\` is required.*

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "email | linkedin_slug | linkedin_url | phone_e164 | new",
  "profile_id": "uuid-string",
  "saved_data": {
    "id": "uuid-string",
    "email": "normalized-email | null",
    "linkedin_slug": "slug | null",
    "linkedin_url": "full-url | null",
    "phone_e164": "+E.164 | null",
    "data": { "...additional fields..." }
  }
}
\`\`\`

---

### 2. Get Profile
**GET** \`/profiles\`

Retrieve a profile by identifier.

**Query Parameters**:
| Param | Description |
|---|---|
| \`email\` | Search by email. |
| \`linkedin\` | Search by LinkedIn URL or slug. |
| \`phone\` | Search by phone (E.164 or loose format). |

**Response — Found (JSON)**:
\`\`\`json
{
  "id": "uuid-string",
  "email": "string | null",
  "linkedin_slug": "string | null",
  "phone": "string (E.164) | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`

**Response — Not Found (200, JSON)**:
\`\`\`json
{
  "result": null,
  "message": "No records found",
  "search_criteria": {
    "email": "normalized value or undefined",
    "linkedin_url": "value or undefined",
    "linkedin_slug": "value or undefined",
    "phone_e164": "value or undefined"
  }
}
\`\`\`

---

### 3. Upsert Company
**POST** \`/companies\`

Create or update a company record. The API will try to find an existing company by domain or LinkedIn slug. If found, it merges the new data. Otherwise, it creates a new company.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`domain\` | String | No* | Company website domain (e.g. "google.com"). |
| \`linkedin_url\` | String | No* | Company LinkedIn URL. |
| \`...\` | Any | No | Any additional fields will be stored in the \`data\` object. |

*At least one of \`domain\` or \`linkedin_url\` is required.*

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "domain | linkedin_slug | new",
  "company_id": "uuid-string",
  "saved_data": {
    "id": "uuid-string",
    "domain": "normalized-domain | null",
    "linkedin_slug": "slug | null",
    "data": { "...additional fields..." }
  }
}
\`\`\`

---

### 4. Get Company
**GET** \`/companies\`

Retrieve a company by identifier.

**Query Parameters**:
| Param | Description |
|---|---|
| \`domain\` | Search by domain. |
| \`linkedin\` | Search by LinkedIn URL or slug. |

**Response — Found (JSON)**:
\`\`\`json
{
  "id": "uuid-string",
  "domain": "string | null",
  "linkedin_slug": "string | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`

**Response — Not Found (200, JSON)**:
\`\`\`json
{
  "result": null,
  "message": "No records found",
  "search_criteria": {
    "domain": "normalized value or undefined",
    "linkedin_slug": "value or undefined"
  }
}
\`\`\`

---

## Email Finder

### 5. Find Email
**POST** \`/find\`

Given a person's name and company domain, finds their most likely email address using pattern permutation and multi-tier API verification.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`first_name\` | String | No* | Person's first name. |
| \`last_name\` | String | No* | Person's last name. |
| \`full_name\` | String | No* | Full name (parsed with LATAM logic). |
| \`domain\` | String | **Yes** | Company domain (e.g. "empresa.com"). |
| \`max_tier\` | Number | No | Max verification tier: 1 or 2 (default: 2). |

*At least one of \`first_name\`, \`last_name\`, or \`full_name\` is required.*

**Response (JSON)**:
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
    "provider": "google_workspace",
    "is_catch_all": false,
    "is_disposable": false,
    "is_free_provider": false
  },
  "permutations_tried": 1,
  "cost_usd": 0.0004,
  "duration_ms": 983
}
\`\`\`

**Possible \`status\` values**: \`valid\`, \`invalid\`, \`catch_all\`, \`unknown\`, \`risky\`, \`disposable\`, \`no_mx\`, \`role_account\`.

---

### 6. Verify Email
**POST** \`/verify\`

Verify an existing email address through the API cascade.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`email\` | String | **Yes** | The email to verify. |
| \`max_tier\` | Number | No | Max verification tier: 1 or 2 (default: 2). |

**Response (JSON)**:
\`\`\`json
{
  "email": "juan@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "domain_info": { ... },
  "cost_usd": 0.0004,
  "duration_ms": 450
}
\`\`\`

---

### 7. Stats
**GET** \`/stats\`

Returns aggregate metrics for the email finder service.

**Response (JSON)**:
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

---

## Tech Detector

### 8. Detect Technologies
**POST** \`/detect-tech\`

Given a URL, fetches the page HTML and detects web technologies in use (analytics, CMS, payments, marketing tools, etc.) via regex pattern matching.

**Authentication**: Required (Bearer token)

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`url\` | String | **Yes** | Full URL to inspect (e.g. "https://example.com"). |

**Example**:
\`\`\`bash
curl -X POST -H "Authorization: Bearer your_secret_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}' \\
  {{BASE_URL}}/detect-tech
\`\`\`

**Response (JSON)**:
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

**Response Fields**:
| Field | Type | Description |
|---|---|---|
| \`cms\` | String | Detected CMS name (with version if available), or empty string. |
| \`ecommerce\` | String | Detected e-commerce platform, or empty string. |
| \`analytics\` | String[] | Analytics and tracking tools detected. |
| \`tag_managers\` | String[] | Tag manager tools detected. |
| \`frameworks\` | String[] | JS frameworks detected (always \`[]\` in current version). |
| \`marketing\` | String[] | Marketing automation / chat / CRM tools detected. |
| \`advertising\` | String[] | Paid advertising pixels detected. |
| \`payments\` | String[] | Payment processors detected. |
| \`cdn\` | String[] | CDN providers detected. |
| \`seo\` | String[] | SEO plugins/tools detected. |
| \`privacy\` | String[] | Cookie consent / privacy tools detected. |
| \`otros\` | String[] | Any other detected technologies. |
| \`resumen\` | String | All detected items joined with \` | \` as a single summary string. |

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`400\` | \`{ "error": "url is required" }\` | The \`url\` field is missing from the request body. |
| \`400\` | \`{ "error": "Invalid URL format" }\` | The provided URL could not be parsed. |
| \`502\` | \`{ "error": "HTTP {status} desde la URL" }\` | The target URL returned a non-2xx HTTP status. |
| \`504\` | \`{ "error": "Timeout al obtener la URL" }\` | The request to the target URL timed out (15s limit). |
| \`500\` | \`{ "error": "..." }\` | Unexpected server error. |

---

## Do Not Contact (DNC)

Manage per-client "Do Not Contact" lists. Each client is identified by a **handle**: the client's name, lowercased, with spaces (and other non-alphanumeric characters) replaced by hyphens and accents stripped. e.g. \`"Acme Corp México"\` → \`acme-corp-mexico\`. The handle is the unified client id.

There are two kinds of DNC list:
- **individual** — specific person emails.
- **domain** — whole company domains. You may also submit an *email* to a domain list: it is decomposed, the domain is blocked, and the original email is stored for reference.

A check matches if the email itself was listed **or** the email's domain is blocked.

### 8. Create Client
**POST** \`/clients\`

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`name\` | String | Yes | Client name. The \`handle\` is derived from it. |
| \`...\` | Any | No | Any additional fields are stored in the client's \`data\` object. |

**Response (JSON)** — \`201 Created\`:
\`\`\`json
{
  "status": "ok",
  "client": {
    "id": "uuid",
    "handle": "acme-corp-mexico",
    "name": "Acme Corp México",
    "data": {},
    "created_at": "...",
    "updated_at": "..."
  }
}
\`\`\`

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`400\` | \`{ "error": "name is required." }\` | Missing/blank \`name\`. |
| \`409\` | \`{ "error": "client_already_exists", ... }\` | A client with that handle already exists. |

### 9. List / Get Clients
**GET** \`/clients\`

Lists all clients. Pass \`?handle=<handle>\` to fetch a single client (the handle is normalized before lookup).

**Response — list**: \`{ "result": <count>, "clients": [ ... ] }\`
**Response — single**: \`{ "result": 1, "client": { ... } }\`

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`404\` | \`{ "error": "client_not_found", "handle": "...", "suggestions": ["..."] }\` | No client with that handle. \`suggestions\` lists similar handles. |

### 10. Upload to a DNC List
**POST** \`/dnc\`

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`handle\` | String | Yes | Client handle. |
| \`list_type\` | String | Yes | \`individual\` or \`domain\`. |
| \`entries\` | String[] | Yes* | Values to add (emails for \`individual\`; emails and/or domains for \`domain\`). |
| \`entry\` / \`email\` / \`domain\` | String | Yes* | Convenience single-value alternatives to \`entries\`. |

*At least one value via \`entries\` or one of \`entry\`/\`email\`/\`domain\` is required.* Invalid values are skipped and reported; duplicates are skipped.

**Response (JSON)** — \`200\`:
\`\`\`json
{
  "status": "ok",
  "handle": "acme",
  "list_type": "domain",
  "added": 1,
  "skipped_duplicates": 0,
  "invalid": [],
  "entries": [
    { "list_type": "domain", "email": "spammer@evilcorp.com", "domain": "evilcorp.com" }
  ]
}
\`\`\`

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`400\` | \`{ "error": "list_type is required and must be one of: individual, domain." }\` | Missing/invalid \`list_type\`. |
| \`400\` | \`{ "error": "At least one entry is required..." }\` | No entries supplied. |
| \`404\` | \`{ "error": "client_not_found", ... }\` | Unknown client handle. |

### 11. Check the DNC List
**POST** \`/dnc/check\`

Check whether an email should not be contacted for a client.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`handle\` | String | Yes | Client handle. |
| \`email\` | String | Yes | Email to check. |

**Response (JSON)** — always \`200\` when the client exists:
\`\`\`json
{
  "handle": "acme",
  "email": "anyone@evilcorp.com",
  "do_not_contact": true,
  "matched_by": "domain"
}
\`\`\`
\`do_not_contact\` is \`true\` if the email is on the list, \`false\` otherwise. \`matched_by\` is \`"email"\`, \`"domain"\`, or \`null\`.

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`400\` | \`{ "error": "email is required." }\` | Missing \`email\`. |
| \`400\` | \`{ "error": "handle is required." }\` | Missing \`handle\`. |
| \`404\` | \`{ "error": "client_not_found", "handle": "...", "suggestions": ["..."] }\` | Unknown client handle. |

### 12. List DNC Entries
**GET** \`/dnc\`

Pass \`?handle=<handle>\` (required) and optionally \`?list_type=individual|domain\`.

**Response**: \`{ "handle": "acme", "result": <count>, "entries": [ ... ] }\`

---

### Pending (Not Yet Implemented)
- **POST /find/batch** — Batch email finding (accepts array of contacts, processes in background).
- **POST /verify/batch** — Batch email verification.
- **Tier 3 verification** — NeverBounce provider ($0.008/email).
`;
