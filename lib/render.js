// Markdown → HTML rendering shared by the CLI and the md2pdf.me website.

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';

export const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// `hljs` is passed in so the CLI can use every language while the website
// ships the smaller common-languages bundle.
export function createRenderer({ hljs }) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      code = code.replace(/\n$/, '');
      const body =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
          : escapeHtml(code);
      return `<pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${body}</code></pre>`;
    },
  });
  md.use(anchor, { slugify: (s) => s.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/\s/g, '-') })
    .use(footnote)
    .use(taskLists, { label: true })
    .use(emoji);
  return md;
}

// The document title: the first level-one heading, else the fallback.
export const titleOf = (markdown, fallback) => markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? fallback;

// A complete printable HTML document. `css` is the style's stylesheet text.
export function buildDocument({ bodyHtml, title, css, pageSize = 'Letter', head = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${head}
<style>
${css}
@page { size: ${pageSize}; }
</style>
</head>
<body>
<article class="markdown-body">
${bodyHtml}
</article>
</body>
</html>`;
}
