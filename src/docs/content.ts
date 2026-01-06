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

### 3. Upsert Company
**POST** \`/companies\`

### 4. Get Company
**GET** \`/companies\`
`;
