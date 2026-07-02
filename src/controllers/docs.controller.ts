import { Request, Response } from 'express';
import { apiDocumentation } from '../docs/content';

// Only allow characters that can legitimately appear in a Host header
// (hostname/IPv6 literal + optional port). Anything else is rejected to
// prevent the client-controlled Host header from being reflected into the
// HTML response (reflected XSS via Host injection).
const SAFE_HOST_REGEX = /^[a-zA-Z0-9.\-:\[\]]+$/;

export const docsController = {
  async get(req: Request, res: Response): Promise<void> {
    const rawHost = req.get('host') || '';
    const safeHost = SAFE_HOST_REGEX.test(rawHost) ? rawHost : 'localhost:3000';
    const baseUrl = req.protocol + '://' + safeHost;
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
  }
};
