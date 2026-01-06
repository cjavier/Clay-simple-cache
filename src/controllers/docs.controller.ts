import { Request, Response } from 'express';
import { apiDocumentation } from '../docs/content';

export const docsController = {
  async get(req: Request, res: Response): Promise<void> {
    const baseUrl = req.protocol + '://' + req.get('host');
    const safeContent = apiDocumentation
      .replace('{{BASE_URL}}', baseUrl)
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
