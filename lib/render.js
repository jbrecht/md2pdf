// Markdown → HTML rendering shared by the CLI and the md2pdf.me website.

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { full as emoji } from 'markdown-it-emoji';
import callouts from './callouts.js';
import footnotes from './footnotes.js';
import ids, { ID_PREFIX } from './ids.js';
import mathRules from './math.js';
import taskLists from './tasklists.js';
import typography from './typography.js';
import wikilinks from './wikilinks.js';

// YAML front matter: a `---` line at the very start of the document, closed by another `---` line.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
// A YAML property, `key: value`.
const YAML_KEY = /^[^\s#:-][^:]*:(?:[ \t]|$)/;
// Any other line properties can have: a `- item`, an indented continuation or a # comment.
const YAML_OTHER = /^(?:-(?:[ \t]|$)|[ \t]+\S|#)/;

// Windows editors start a file with U+FEFF, which isn't whitespace to markdown-it: left in, the first line
// is no longer a heading or the start of front matter.
const withoutByteOrderMark = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function byteOrderMark(md) {
  md.core.ruler.before('normalize', 'byte_order_mark', (state) => {
    state.src = withoutByteOrderMark(state.src);
  });
}

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

// highlight.js takes time that grows with the square of the length on some code, so under a budget a
// longer block is highlighted in pieces of this many characters.
const PIECE = 4096;

// `code` in pieces of at most PIECE characters, each ending at a line break where there is one, and
// never between the halves of a surrogate pair.
function pieces(code) {
  const out = [];
  for (let start = 0; start < code.length; ) {
    let end = Math.min(start + PIECE, code.length);
    if (end < code.length) {
      const lineEnd = code.lastIndexOf('\n', end - 1);
      if (lineEnd >= start) end = lineEnd + 1;
      else if (/[\uD800-\uDBFF]/.test(code[end - 1])) end--;
    }
    out.push(code.slice(start, end));
    start = end;
  }
  return out;
}

// `hljs` is passed in so the CLI can use every language while the website
// ships the smaller common-languages bundle. `math` ({ katex, maxHtml? }) is optional:
// the website loads it on demand when a document contains formulas. `html: false` escapes raw HTML in
// the Markdown instead of passing it through, and `idPrefix` (letters, digits, _ and -, starting with a
// letter and ending in -) starts every id the document gives an element, and every link to one; use both for Markdown you didn't
// write. `highlightBudget` is the milliseconds each render may spend highlighting code, after which code
// is escaped without colour: 100 with `html: false`, otherwise unlimited.
export function createRenderer({ hljs, math, html = true, idPrefix = '', highlightBudget = html ? Infinity : 100 }) {
  if (idPrefix !== '' && !(typeof idPrefix === 'string' && ID_PREFIX.test(idPrefix))) {
    throw new TypeError(`idPrefix must be letters, digits, _ and -, starting with a letter and ending in -: ${JSON.stringify(idPrefix)}`);
  }
  if (!(typeof highlightBudget === 'number' && highlightBudget >= 0)) {
    throw new TypeError(`highlightBudget must be a number of milliseconds, 0 or more: ${String(highlightBudget)}`);
  }
  let spent = 0;
  const highlight = (code, language) => {
    if (spent >= highlightBudget) return escapeHtml(code);
    const start = performance.now();
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
    spent += performance.now() - start;
    return value;
  };
  const md = new MarkdownIt({
    html,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      code = code.replace(/\n$/, '');
      const body = !(lang && hljs.getLanguage(lang))
        ? escapeHtml(code)
        : highlightBudget === Infinity
          ? highlight(code, lang)
          : pieces(code).map((piece) => highlight(piece, lang)).join('');
      return `<pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${body}</code></pre>`;
    },
  });
  // The budget is for each render.
  const render = md.renderer.render;
  md.renderer.render = function (...args) {
    spent = 0;
    return render.apply(this, args);
  };
  md.use(ids, { slugify, idPrefix })
    .use(footnote)
    .use(footnotes, { idPrefix })
    .use(taskLists)
    .use(typography)
    .use(emoji)
    .use(callouts)
    .use(wikilinks, { slugify })
    .use(frontMatter)
    .use(byteOrderMark);
  if (math) md.use(mathRules, { katex: math.katex, maxHtml: math.maxHtml });
  return md;
}

let titleParser;

// `s` without the spaces and tabs at either end. A regex would take quadratic time on a long run of them.
function trimSpaceTab(s) {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === ' ' || s[start] === '\t')) start++;
  while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return s.slice(start, end);
}

// A block scalar's header: > or |, with its chomping and indentation indicators.
const BLOCK_SCALAR = /^[>|][+-]?\d?[+-]?(?:[ \t]+#[^]*)?$/;

// The first `title:` in front matter's YAML that has a value, or ''. A lowercase key only, as YAML's keys
// are case-sensitive. A `>` or `|` block reads as one line, and a quoted value loses its quotes.
function yamlTitle(yaml) {
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^title:(?:[ \t]|$)/.test(lines[i])) continue;
    let value = trimSpaceTab(lines[i].slice('title:'.length));
    // [^]* and not .*, here and below: a line can hold a lone \r or a line separator, which . stops at, and
    // the search would then run again from every #.
    const quoted = value.match(/^(["'])(.*?)\1[ \t]*(?:#[^]*)?$/);
    if (BLOCK_SCALAR.test(value)) {
      const text = [];
      for (let j = i + 1; j < lines.length && (/^[ \t]/.test(lines[j]) || !lines[j].trim()); j++) text.push(lines[j].trim());
      value = text.filter(Boolean).join(' ');
    } else if (quoted) {
      value = quoted[2];
    } else {
      // A # after a space starts a comment.
      value = value.startsWith('#') ? '' : value.replace(/[ \t]#[^]*$/, '');
    }
    if (value.trim()) return value.trim();
  }
  return '';
}

// The document title: the text of the first level-one heading as it renders, else the front matter's
// `title:`, else the fallback.
export function titleOf(markdown, fallback) {
  titleParser ??= createRenderer({});
  const env = {};
  const tokens = titleParser.parse(markdown, env);
  const at = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  const heading = at < 0 ? '' : headingText(titleParser.renderer.render(tokens.slice(at, at + 3), titleParser.options, env));
  return heading || yamlTitle(frontMatterOf(withoutByteOrderMark(markdown))?.yaml ?? '') || fallback;
}

// A quoted CSS string, safe inside a <style> element.
export const cssString = (s) =>
  `"${s.replace(/[\\"]/g, '\\$&').replace(/[\0-\x1f\x7f<]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

const TEX = /<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/;

// `html` with each formula in <eq> or <eqn> as its TeX between $ or $$, taken from KaTeX's MathML. A
// formula without it, such as one that failed to render, is left as it is.
function formulasAsTex(html) {
  for (const [tag, dollars] of [['eq', '$'], ['eqn', '$$']]) {
    const parts = html.split(`</${tag}>`);
    html = parts
      .map((part, i) => {
        if (i === parts.length - 1) return part;
        const at = part.lastIndexOf(`<${tag}>`);
        const tex = at < 0 ? undefined : part.slice(at).match(TEX)?.[1];
        return tex === undefined ? `${part}</${tag}>` : `${part.slice(0, at)}${dollars}${tex}${dollars}`;
      })
      .join('');
  }
  return html;
}

const ENTITIES = { lt: '<', gt: '>', quot: '"', amp: '&', '#x27': "'", '#039': "'" };

// The text of the first <h1> in rendered HTML, or '' if there is none. A formula in it shows as its TeX.
export function headingText(html) {
  const inner = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
  const text = formulasAsTex(inner).replace(/<[^>]*>/g, '');
  return text.replace(/&(lt|gt|quot|amp|#x27|#039);/g, (_, e) => ENTITIES[e]).trim();
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
