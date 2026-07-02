import { Request, Response } from 'express';
import { apiDocumentation } from '../docs/content';
import { REST_ENDPOINTS_SUMMARY, MCP_TOOLS_SUMMARY, AGENT_RULES } from '../docs/agents';

// Only allow characters that can legitimately appear in a Host header
// (hostname/IPv6 literal + optional port). Anything else is rejected to
// prevent the client-controlled Host header from being reflected into the
// HTML response (reflected XSS via Host injection).
const SAFE_HOST_REGEX = /^[a-zA-Z0-9.\-:\[\]]+$/;

function resolveBaseUrl(req: Request): string {
  const rawHost = req.get('host') || '';
  const safeHost = SAFE_HOST_REGEX.test(rawHost) ? rawHost : 'localhost:3000';
  return req.protocol + '://' + safeHost;
}

function buildLlmsTxt(baseUrl: string): string {
  const restBlock = REST_ENDPOINTS_SUMMARY.replace(/\{\{BASE_URL\}\}/g, baseUrl);
  const mcpBlock = MCP_TOOLS_SUMMARY.replace(/\{\{BASE_URL\}\}/g, baseUrl);
  const rules = AGENT_RULES.replace(/\{\{BASE_URL\}\}/g, baseUrl);

  return `# Clay Cache API

> Identity cache, email finder, tech stack detection, LinkedIn resolution, per-client Do Not Contact (DNC) lists, and DeepSeek-backed AI endpoints (copy generation + a web-research agent), for a GTM outbound agency.

## Docs

- Full human-readable reference (request/response shapes, error codes, curl examples): ${baseUrl}/docs/api
- This file: ${baseUrl}/llms.txt

## Auth

Every endpoint/tool below requires a Bearer API key, except GET /health, GET /docs/api, and this file.
Header: \`Authorization: Bearer <API_KEY>\`

## REST endpoints

Base URL: ${baseUrl}

\`\`\`
${restBlock}
\`\`\`

## MCP server

This service is also an MCP (Model Context Protocol) server:

- URL: ${baseUrl}/mcp
- Transport: Streamable HTTP, stateless (no sessions; GET/DELETE return 405)
- Auth: same Bearer API key as above, sent as a header on the HTTP connection
- Tools (16):

\`\`\`
${mcpBlock}
\`\`\`

## Rules for agents

${rules}
`;
}

export const docsController = {
  async get(req: Request, res: Response): Promise<void> {
    const baseUrl = resolveBaseUrl(req);
    const safeContent = apiDocumentation
      // Global replace: the docs use {{BASE_URL}} many times (once per curl
      // example), and a plain-string .replace() only swaps the first match.
      .replace(/\{\{BASE_URL\}\}/g, baseUrl)
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Identity Cache API Docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-light.min.css" />
  <style>
    body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
  </style>
</head>
<body class="markdown-body">
  <div id="content"></div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    const markdownContent = \`${safeContent}\`;
    document.getElementById('content').innerHTML = marked.parse(markdownContent);
  </script>
</body>
</html>
`;
    res.send(html);
  },

  /**
   * GET /llms.txt — plain-text, machine-readable service summary (llms.txt
   * convention). No auth, same as /docs/api, so agents can discover how to
   * authenticate before making their first authenticated call.
   */
  async llmsTxt(req: Request, res: Response): Promise<void> {
    const baseUrl = resolveBaseUrl(req);
    res.type('text/plain').send(buildLlmsTxt(baseUrl));
  },
};
