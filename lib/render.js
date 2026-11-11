// Markdown → HTML rendering shared by the CLI and the md2pdf.me website.

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';
import callouts from './callouts.js';
import wikilinks from './wikilinks.js';

// YAML front matter: a `---` line at the very start of the document, closed by another `---` line.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
// A YAML property, `key: value`.
const YAML_KEY = /^[^\s#:-][^:]*:(?:[ \t]|$)/;
// Any other line properties can have: a `- item`, an indented continuation or a # comment.
const YAML_OTHER = /^(?:-(?:[ \t]|$)|[ \t]+\S|#)/;

// The front matter block at the start of `markdown` and the YAML inside it, or null. A `---…---` block
// that isn't YAML properties is Markdown after a divider, as AI answers write it. A # line could be a
// comment or a heading, and a - line a list, so the first other line must be a property.
function frontMatterOf(markdown) {
  const [block, yaml = ''] = markdown.match(FRONT_MATTER) ?? [];
  if (!block) return null;
  const lines = yaml.split(/\r?\n/).filter((line) => line.trim());
  const first = lines.find((line) => !line.trimStart().startsWith('#'));
  const yamlShaped = lines.every((line) => YAML_KEY.test(line) || YAML_OTHER.test(line));
  if (lines.length && !(yamlShaped && first && YAML_KEY.test(first))) return null;
  return { block, yaml };
}

// Leaves front matter (Obsidian, Jekyll, Hugo) out of the output instead of rendering it as a rule and a heading.
function frontMatter(md) {
  md.block.ruler.before('table', 'front_matter', (state, startLine, endLine, silent) => {
    if (startLine !== 0) return false;
    const block = frontMatterOf(state.src)?.block;
    if (!block) return false;
    if (!silent) state.line = block.replace(/\n$/, '').split('\n').length;
    return true;
  });
}

// Heading ids, which [[#Heading]] links must match.
const slugify = (s) => s.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/\s/g, '-');

export const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// `hljs` is passed in so the CLI can use every language while the website
// ships the smaller common-languages bundle. `math` ({ texmath, katex }) is optional:
// the website loads it on demand when a document contains formulas. `html: false` escapes raw HTML in
// the Markdown instead of passing it through; use it for Markdown you didn't write.
export function createRenderer({ hljs, math, html = true }) {
  const md = new MarkdownIt({
    html,
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
  md.use(anchor, { slugify })
    .use(footnote)
    .use(taskLists, { label: true })
    .use(emoji)
    .use(callouts)
    .use(wikilinks, { slugify })
    .use(frontMatter);
  if (math) {
    md.use(math.texmath, {
      engine: math.katex,
      // LaTeX writes \( \) and \[ \]; AI assistants and most Markdown editors use $ and $$.
      delimiters: ['brackets', 'dollars', 'beg_end'],
      // Require a space before an opening $ so prices like "$5 and $10" stay text.
      outerSpace: true,
      katexOptions: { throwOnError: false, output: 'html' },
    });
    // texmath's outerSpace takes only a space beside a $, so a formula at the start or end of a
    // hard-wrapped line stays text. These run first and also take a line break.
    for (const rule of math.texmath.rules.dollars.inline) {
      md.inline.ruler.before('math_inline_double', `${rule.name}_wrapped`,
        math.texmath.inline({ ...rule, rex: new RegExp(rule.rex), pre: dollarPre, post: dollarPost }));
    }
  }
  return md;
}

// Whether the $ at `at` opens or closes a formula: whitespace or the paragraph's edge is outside it,
// or after a closing $, punctuation that ends a clause.
const dollarPre = (src, _outerSpace, at) => at === 0 || /\s/.test(src[at - 1]);
const dollarPost = (src, _outerSpace, at) => at + 1 >= src.length || /[\s.,;]/.test(src[at + 1]);

let titleParser;

// The document title: the text of the first level-one heading as it renders, else the front matter's
// `title:`, else the fallback.
export function titleOf(markdown, fallback) {
  titleParser ??= createRenderer({});
  const env = {};
  const tokens = titleParser.parse(markdown, env);
  const at = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  const heading = at < 0 ? '' : headingText(titleParser.renderer.render(tokens.slice(at, at + 3), titleParser.options, env));
  const yaml = frontMatterOf(markdown)?.yaml ?? '';
  const title = yaml.match(/^title:[ \t]*(.+?)[ \t]*$/m)?.[1].replace(/^(["'])(.*)\1$/, '$2').trim();
  return heading || title || fallback;
}

// A quoted CSS string, safe inside a <style> element.
export const cssString = (s) =>
  `"${s.replace(/[\\"]/g, '\\$&').replace(/[\0-\x1f\x7f<]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

// The text of the first <h1> in rendered HTML, or '' if there is none.
export function headingText(html) {
  const inner = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  const text = inner.replace(/<[^>]*>/g, '');
  return text.replace(/&(lt|gt|quot|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]).trim();
}

// A complete printable HTML document. `css` is the style's on-screen stylesheet followed by its print
// stylesheet.
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
