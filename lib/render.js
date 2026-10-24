// Markdown → HTML rendering shared by the CLI and the md2pdf.me website.

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';

export const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// `hljs` is passed in so the CLI can use every language while the website
// ships the smaller common-languages bundle. `math` ({ texmath, katex }) is optional:
// the website loads it on demand when a document contains formulas.
export function createRenderer({ hljs, math }) {
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
  if (math) {
    md.use(math.texmath, {
      engine: math.katex,
      // ChatGPT writes \( \) and \[ \]; many others use $ and $$.
      delimiters: ['brackets', 'dollars', 'beg_end'],
      // Require a space before an opening $ so prices like "$5 and $10" stay text.
      outerSpace: true,
      katexOptions: { throwOnError: false, output: 'html' },
    });
  }
  return md;
}

// The document title: the first level-one heading, else the fallback.
export const titleOf = (markdown, fallback) => markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? fallback;

// A quoted CSS string, safe inside a <style> element.
export const cssString = (s) =>
  `"${s.replace(/[\\"]/g, '\\$&').replace(/[\0-\x1f\x7f<]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

// The text of the first <h1> in rendered HTML, or '' if there is none.
export function headingText(html) {
  const inner = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  const text = inner.replace(/<[^>]*>/g, '');
  return text.replace(/&(lt|gt|quot|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]).trim();
}

// A complete printable HTML document. `css` is the style's stylesheet text.
// Styles can show the first heading in a running header with `content: var(--document-title)`.
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
:root { --document-title: ${cssString(headingText(bodyHtml))}; }
</style>
</head>
<body>
<article class="markdown-body">
${bodyHtml}
</article>
</body>
</html>`;
}
