export const apiDocumentation = `# Identity Cache & Enrichment API

## Overview
This API allows storing, retrieving, and resolving identity profiles (People) and companies. 
It uses a "best-effort" resolution strategy based on multiple identifiers (Email, LinkedIn, Phone, Domain).

## Base URL
\`http://<host>:<port>\`

## Endpoints

### 1. Upsert Profile
**POST** \`/profiles\`

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`email\` | String | No* | Person's email. Will be lowercased. |
| \`linkedin_url\` | String | No* | LinkedIn profile URL. Slug will be extracted. |
| \`phone\` | String | No* | Phone number. Will be normalized to E.164. |

### 2. Get Profile
**GET** \`/profiles\`

**Response (JSON)**:
\`\`\`json
{
  "email": "string | null",
  "linkedin_slug": "string | null",
  "phone": "string (E.164) | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`

---

### 3. Upsert Company
**POST** \`/companies\`

**Purpose**: Create or update a company record.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`domain\` | String | No* | Company website domain (e.g. "google.com"). |
| \`linkedin_url\` | String | No* | Company LinkedIn URL. |
| \`...\` | Any | No | Additional data for the \`data\` field. |

*At least one of \`domain\` or \`linkedin_url\` is required.*

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "domain" | "linkedin_slug" | "new",
  "company_id": "uuid-string"
}
\`\`\`

---

### 4. Get Company
**GET** \`/companies\`

**Purpose**: Retrieve a company by identifier.

**Query Parameters**:
| Param | Description |
|---|---|
| \`domain\` | Search by domain. |
| \`linkedin\` | Search by LinkedIn URL or slug. |

**Response (JSON)**:
\`\`\`json
{
  "domain": "string | null",
  "linkedin_slug": "string | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`
`;
