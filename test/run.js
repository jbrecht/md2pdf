// End-to-end tests: run the real CLI against fixtures and inspect the PDFs.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, existsSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { buildDocument, createRenderer, cssString, headingText, titleOf } from '../lib/render.js';
import { pageMargins } from '../lib/styles.js';
import { relativeUrls, rewriteUrls } from '../lib/css.js';
import mathRules from '../lib/math.js';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'md2pdf.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');

// Point every run at a throwaway config so tests never touch the real default style.
const CONFIG = join(mkdtempSync(join(tmpdir(), 'md2pdf-config-')), 'config.json');
process.env.MD2PDF_CONFIG = CONFIG;

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
// WCAG contrast ratio of two opaque CSS rgb() colors.
function contrast(a, b) {
  const luminance = (rgb) => {
    const [r, g, bl] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const pageCount = (pdf) => readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
// The PostScript names of the fonts a PDF embeds, without their subset prefix (AAAAAA+).
const pdfFonts = (pdf) => [...new Set([...readFileSync(pdf, 'latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/<>[\]()]+)/g)].map((m) => m[1]))];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  copyFileSync(join(FIXTURES, 'sample.md'), join(dir, 'sample.md'));
  mkdirSync(join(dir, 'images'));
  copyFileSync(join(FIXTURES, 'images', 'bar.png'), join(dir, 'images', 'bar.png'));
  return dir;
}

// A document with every kind of block whose spacing a style sets.
const SPACING_DOC = `# Title

Contact line under the title.

## Section

### Subsection

A paragraph long enough to wrap across more than one line of the page, so line height has something to act on here.

A second paragraph straight after the first.

#### Fourth

##### Fifth

###### Sixth

- One
- Two
  - Nested
- [ ] A task
- [x] Another task

1. An item with a paragraph.

   Its second paragraph.

2. Another item.

> A quote.
>
> Its second paragraph.

> [!NOTE]
> A callout.

\`\`\`js
const a = 1;
\`\`\`

| A | B |
| - | - |
| 1 | 2 |

---

![Blue bar](images/bar.png)

# A later title

Text with a footnote.[^1]

[^1]: The footnote.
`;

// Opens an HTML file in headless Chrome and returns what its script put in window.probeOut.
function probeInChrome(htmlFile, dir) {
  const probed = htmlFile.replace(/\.html$/, '.probe.html');
  const report = `<script>
    const pre = document.createElement('pre');
    pre.id = 'probe-out';
    pre.textContent = JSON.stringify(window.probeOut);
    document.body.append(pre);
  </script>`;
  writeFileSync(probed, readFileSync(htmlFile, 'utf8').replace('</body>', `${report}</body>`));
  // The browsers bin/md2pdf.js looks for, in its order.
  const chrome = process.env.CHROME_PATH ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ].find((p) => existsSync(p));
  const r = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'chrome')}`,
    '--window-size=816,1056', '--dump-dom', `file://${probed}`], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
  const json = r.stdout.match(/<pre id="probe-out">([^<]*)<\/pre>/)?.[1];
  assert.ok(json, `no output from Chrome: ${r.stderr}`);
  return JSON.parse(json.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
}

// Each element's vertical margins, line height and font size in px, as Chrome computes them for an
// HTML file written by --html.
function computedSpacing(htmlFile, dir) {
  const probe = `<script>
    window.probeOut = [];
    for (const el of document.querySelectorAll('.markdown-body, .markdown-body *')) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        if (s.display === 'none' || (pseudo && s.content === 'none')) continue;
        probeOut.push({
          what: el.tagName.toLowerCase() + (el.getAttribute('class') ? '.' + el.getAttribute('class').split(' ').join('.') : '') + (pseudo ?? ''),
          top: parseFloat(s.marginTop), bottom: parseFloat(s.marginBottom),
          lineHeight: parseFloat(s.lineHeight) || 0, fontSize: parseFloat(s.fontSize),
        });
      }
    }
  </script>`;
  const probed = htmlFile.replace(/\.html$/, '.spacing.html');
  writeFileSync(probed, readFileSync(htmlFile, 'utf8').replace('</body>', `${probe}</body>`));
  return probeInChrome(probed, dir);
}

const STYLE_NAMES = ['github', 'classic', 'academic', 'modern', 'report', 'resume', 'worksheet', 'gothic', 'sandwake'];

// The CSS a page loads to show a style on screen, without its print rules.
const screenCss = (style) =>
  [...(style === 'github' ? [require.resolve('github-markdown-css/github-markdown-light.css')] : []), join(ROOT, 'styles', `${style}.css`)]
    .map((f) => rewriteUrls(readFileSync(f, 'utf8'), (ref) => new URL(ref, pathToFileURL(f)).href))
    .join('\n');

// Rendered HTML with every element and class the styles target: code with highlighting, callouts,
// footnotes, task lists, tables, headings of every level.
const allFeaturesHtml = () => {
  const md = createRenderer({ hljs });
  return [readFileSync(join(FIXTURES, 'sample.md'), 'utf8'), readFileSync(join(FIXTURES, 'callouts.md'), 'utf8'), SPACING_DOC]
    .map((doc) => md.render(doc))
    .join('\n');
};

// Every computed property of an element and its pseudo-elements, one per line, leaving out the
// properties in `skip`. Of the custom properties, only those in `vars`: an overridden variable is
// inherited by every element under it, so listing them all would show a change even if no rule used it.
// Runs in the page.
const SIGNATURE_JS = `
  function signature(el, vars, skip = []) {
    return [null, '::before', '::after', '::marker'].flatMap((pseudo) => {
      const s = getComputedStyle(el, pseudo);
      return [...[...s].filter((name) => !name.startsWith('--')), ...vars]
        .filter((name) => !skip.includes(name))
        .map((name) => (pseudo ?? '') + ' ' + name + ': ' + s.getPropertyValue(name));
    }).join('\\n');
  }`;

test('converts Markdown to a PDF next to the source file', () => {
  const dir = workspace();
  const out = execFileSync(process.execPath, [CLI, join(dir, 'sample.md')], { encoding: 'utf8' });
  const pdf = join(dir, 'sample.pdf');
  assert.equal(out.trim(), pdf);
  assert.ok(readFileSync(pdf, 'latin1').startsWith('%PDF-'));
  assert.ok(pageCount(pdf) >= 1);
});

test('embeds images referenced by relative path', () => {
  const dir = workspace();
  run(join(dir, 'sample.md'));
  assert.match(readFileSync(join(dir, 'sample.pdf'), 'latin1'), /\/Subtype\s*\/Image/);
});

test('renders GitHub-flavored features into the HTML', () => {
  const dir = workspace();
  run('--html', join(dir, 'sample.md'));
  const html = readFileSync(join(dir, 'sample.html'), 'utf8');
  assert.match(html, /<title>md2pdf Sample Document<\/title>/);
  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /class="footnotes"/);
  assert.match(html, /🚀/);
});

const render = (markdown) =>
  createRenderer({ hljs: { getLanguage: () => undefined } }).render(markdown).replace(/<svg[^]*?<\/svg>/g, '<svg/>');

test('GitHub alerts render as titled boxes in their own family', () => {
  for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const family = type.toLowerCase();
    const title = type[0] + family.slice(1);
    assert.equal(
      render(`> [!${type}]\n> Body *text*.`),
      `<div class="markdown-alert markdown-alert-${family}" data-callout="${family}">\n` +
        `<p class="markdown-alert-title"><svg/>${title}</p>\n<p>Body <em>text</em>.</p>\n</div>\n`,
    );
  }
});

test('Obsidian callouts take a title, ignore fold markers and map types to families', () => {
  assert.equal(
    render('> [!question]- Is it **done**?\n> Not yet.\n>\n> - one'),
    '<div class="markdown-alert markdown-alert-warning" data-callout="question">\n' +
      '<p class="markdown-alert-title"><svg/>Is it <strong>done</strong>?</p>\n<p>Not yet.</p>\n<ul>\n<li>one</li>\n</ul>\n</div>\n',
  );
  assert.match(render('> [!bug]+ Crash on save'), /^<div class="markdown-alert markdown-alert-caution" data-callout="bug">\n<p class="markdown-alert-title"><svg\/>Crash on save<\/p>\n<\/div>/);
  assert.match(render('> [!success]\n> Shipped.'), /markdown-alert-tip" data-callout="success"[^]*>Success<\/p>/);
  assert.match(render('> [!example]\n> x'), /markdown-alert-important/);
  assert.match(render('> [!cite]\n> x'), /markdown-alert-quote/);
});

test('unknown callout types look like notes; ordinary and nested quotes still work', () => {
  assert.match(render('> [!mystery]\n> x'), /markdown-alert-note" data-callout="mystery"[^]*>Mystery<\/p>/);
  assert.equal(render('> Just a quote, [!note] and all.'), '<blockquote>\n<p>Just a quote, [!note] and all.</p>\n</blockquote>\n');
  assert.match(render('> > [!tip]\n> > inner'), /^<blockquote>\n<div class="markdown-alert markdown-alert-tip"[^]*<\/div>\n<\/blockquote>/);
});

test('a callout closes at its own blockquote, around quotes nested in it and inside list items', () => {
  assert.equal(
    render('> [!note]\n> > inner\n>\n> after'),
    '<div class="markdown-alert markdown-alert-note" data-callout="note">\n<p class="markdown-alert-title"><svg/>Note</p>\n' +
      '<blockquote>\n<p>inner</p>\n</blockquote>\n<p>after</p>\n</div>\n',
  );
  assert.equal(
    render('- > [!tip]\n  > x'),
    '<ul>\n<li>\n<div class="markdown-alert markdown-alert-tip" data-callout="tip">\n' +
      '<p class="markdown-alert-title"><svg/>Tip</p>\n<p>x</p>\n</div>\n</li>\n</ul>\n',
  );
});

test('front matter at the start of the document is left out', () => {
  assert.equal(render('---\ntitle: Notes\ntags: [a, b]\n---\n\n# Heading\n\nBody'), '<h1 id="heading" tabindex="-1">Heading</h1>\n<p>Body</p>\n');
  assert.equal(render('---\r\ntitle: Notes\r\n---\r\nBody'), '<p>Body</p>\n');
  assert.equal(render('---\n---\nBody'), '<p>Body</p>\n');
  assert.equal(render('---\ntitle: Notes\n---'), '');
});

test('--- elsewhere, unclosed or longer still renders as before', () => {
  assert.equal(render('Intro\n\n---\n\nAfter'), '<p>Intro</p>\n<hr>\n<p>After</p>\n');
  assert.equal(render('---\nnot closed\n\nBody'), '<hr>\n<p>not closed</p>\n<p>Body</p>\n');
  assert.equal(render('----\nsetext\n----'), '<hr>\n<h2 id="setext" tabindex="-1">setext</h2>\n');
  assert.match(render('> ---\n> quoted\n> ---'), /^<blockquote>\n<hr>/);
});

test('a document that opens with a --- divider keeps its first section', () => {
  assert.equal(
    render('---\n\n# Title\n\ntext\n\n---\n\nend'),
    '<hr>\n<h1 id="title" tabindex="-1">Title</h1>\n<p>text</p>\n<hr>\n<p>end</p>\n',
  );
  assert.equal(render('---\nJust a paragraph.\n---\n'), '<hr>\n<h2 id="just-a-paragraph" tabindex="-1">Just a paragraph.</h2>\n');
  assert.equal(render('---\n# Only a heading\n---\nBody'), '<hr>\n<h1 id="only-a-heading" tabindex="-1">Only a heading</h1>\n<hr>\n<p>Body</p>\n');
  assert.equal(titleOf('---\n\n# Title\n\ntext\n\n---\n\nend', 'stem'), 'Title');
  // An AI answer's opening list, with or without a heading over it.
  assert.equal(
    render('---\n\n## Key takeaways\n\n- One\n- Two\n\n---\n\nMore'),
    '<hr>\n<h2 id="key-takeaways" tabindex="-1">Key takeaways</h2>\n<ul>\n<li>One</li>\n<li>Two</li>\n</ul>\n<hr>\n<p>More</p>\n',
  );
  assert.match(render('---\n- One\n- Two\n---\n\nBody'), /^<hr>\n<ul>\n<li>One<\/li>/);
  // Real front matter: properties, lists, block scalars and comments.
  assert.equal(render('---\ntags:\n  - a\n- b\nnote: |\n  two\n  lines\n# a comment\n---\nBody'), '<p>Body</p>\n');
});

test('titleOf skips front matter and falls back to its title field', () => {
  assert.equal(titleOf('---\ntitle: From YAML\n---\n# From heading', 'stem'), 'From heading');
  assert.equal(titleOf('---\ntitle: From YAML\n---\nNo heading', 'stem'), 'From YAML');
  assert.equal(titleOf('---\n# a YAML comment\ntitle: From YAML\n---\nNo heading', 'stem'), 'From YAML');
  assert.equal(titleOf('---\ntitle: "Quoted: title"\n---\n', 'stem'), 'Quoted: title');
  assert.equal(titleOf("---\nsubtitle: x\ntitle: 'Single'\n---\n", 'stem'), 'Single');
  assert.equal(titleOf('---\ntags: [a]\n---\nNothing', 'stem'), 'stem');
  assert.equal(titleOf('title: Not front matter\n', 'stem'), 'stem');
});

test('titleOf reads the heading as it renders, never a # line in code', () => {
  assert.equal(titleOf('```bash\n# install deps\nnpm i\n```\n\n# Setup guide\n', 'stem'), 'Setup guide');
  assert.equal(titleOf('    # indented code\n\nText', 'stem'), 'stem');
  assert.equal(titleOf('```\n# only in code\n```\n', 'stem'), 'stem');
  assert.equal(titleOf('# Meeting with [[Sam]]', 'stem'), 'Meeting with Sam');
  assert.equal(titleOf('# The **final** plan', 'stem'), 'The final plan');
  assert.equal(titleOf('# Use `npm` & [the docs](https://example.com) <em>now</em> :tada:', 'stem'), 'Use npm & the docs now 🎉');
  assert.equal(titleOf('## Not a title\n\nUnderlined\n===\n', 'stem'), 'Underlined');
});

test('the CLI titles the PDF with the heading as it renders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    writeFileSync(join(dir, 'note.md'), '```bash\n# install deps\n```\n\n# The **final** plan for [[Sam]]\n');
    const r = run('--html', join(dir, 'note.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'note.html'), 'utf8'), /<title>The final plan for Sam<\/title>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('$ math renders beside a line break; prices stay text', async () => {
  const { default: katex } = await import('katex');
  const md = createRenderer({ hljs, math: { katex } });
  const formulas = (src) => md.render(src).match(/<eq>/g)?.length ?? 0;
  assert.equal(formulas('First line ends with $x$\n$y$ starts the second line, and so\non with $z$.'), 3);
  assert.equal(formulas('A formula $x$, then $y$; then $z$.'), 3);
  assert.equal(formulas('It costs $5 and $10.\nOr $5\nand $10.'), 0);
  assert.match(md.render('Displayed\n$$a+b$$\ninline'), /<eqn>/);
});

test('the CLI takes the document title from front matter when there is no heading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  writeFileSync(join(dir, 'note.md'), '---\ntitle: Weekly notes\n---\n\nJust a paragraph.\n');
  const r = run('--html', join(dir, 'note.md'));
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(dir, 'note.html'), 'utf8');
  assert.match(html, /<title>Weekly notes<\/title>/);
  assert.equal(html.match(/<article class="markdown-body">\n([^]*)<\/article>/)[1], '<p>Just a paragraph.</p>\n\n');
});

test('wikilinks render as the text Obsidian shows', () => {
  assert.equal(render('[[Note]] [[Note|alias]] [[Note#Heading]] [[Note#A#B]]'), '<p>Note alias Note &gt; Heading Note &gt; A &gt; B</p>\n');
  assert.equal(render('[[Note#^block-id]] [[ Spaced | Alias ]] [[folder/Note.md]]'), '<p>Note Alias folder/Note.md</p>\n');
  assert.equal(render('[[Note\\|escaped pipe]]'), '<p>escaped pipe</p>\n');
  assert.match(render('| a |\n|---|\n| [[Note\\|in a table]] |'), /<td>in a table<\/td>/);
  assert.equal(render('## My **bold** heading\n\nSee [[#My bold heading]].'),
    '<h2 id="my-bold-heading" tabindex="-1">My <strong>bold</strong> heading</h2>\n<p>See <a href="#my-bold-heading">My bold heading</a>.</p>\n');
  // The link must match the heading's id after typographer and emoji replacements.
  for (const heading of ['A -- B', 'Notes (c) 2024', ':rocket: Launch']) {
    const html = render(`## ${heading}\n\n[[#${heading}]]`);
    assert.equal(html.match(/<a href="#([^"]+)"/)[1], html.match(/<h2 id="([^"]+)"/)[1], heading);
  }
});

test('brackets that are not wikilinks render as before', () => {
  assert.equal(render('\\[[escaped]] `[[code]]` [[unclosed and [[]] [[a\nb]]'), '<p>[[escaped]] <code>[[code]]</code> [[unclosed and [[]] [[a\nb]]</p>\n');
  // AI assistants write citations as [[1]](url): a link whose text is [1].
  assert.equal(render('Cited.[[1]](https://example.com)'), '<p>Cited.<a href="https://example.com">[1]</a></p>\n');
  assert.equal(render('[[|]] ![[|]] ![[|alias]]'), '<p>[[|]] ![[|]] ![[|alias]]</p>\n');
  // Obsidian reads any [[…]] as a wikilink, so bracketed prose outside code loses its brackets too.
  assert.equal(render('the matrix [[1, 2]]'), '<p>the matrix 1, 2</p>\n');
  assert.equal(render('[see [[Note]] here](https://example.com)'), '<p><a href="https://example.com">see Note here</a></p>\n');
});

test('image embeds render as images; other embeds as a labelled placeholder', () => {
  assert.equal(render('![[Pasted image 1.png]]'), '<p><img src="Pasted%20image%201.png" alt="Pasted image 1.png"></p>\n');
  assert.equal(render('![[a.png|A cat]] ![[a.png|300]] ![[a.png|300x200]]'),
    '<p><img src="a.png" alt="A cat"> <img src="a.png" alt="a.png" width="300"> <img src="a.png" alt="a.png" width="300" height="200"></p>\n');
  assert.equal(render('![[Other note]]'), '<p><span class="markdown-embed">Embedded note: Other note</span></p>\n');
  assert.equal(render('![[Other note#Part|Alias]] ![[Slides.pdf]]'),
    '<p><span class="markdown-embed">Embedded note: Other note &gt; Part</span> <span class="markdown-embed">Embedded file: Slides.pdf</span></p>\n');
  assert.equal(render('![[javascript:alert(1).png]]'), '<p><img src="" alt="javascript:alert(1).png"></p>\n');
  assert.equal(render('![[<b>x</b>]]'), '<p><span class="markdown-embed">Embedded note: &lt;b&gt;x&lt;/b&gt;</span></p>\n');
});

test('the CLI loads an embedded image relative to the note', () => {
  const dir = workspace();
  writeFileSync(join(dir, 'note.md'), 'Chart:\n\n![[images/bar.png]]\n');
  const r = run(join(dir, 'note.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'note.pdf'), 'latin1'), /\/Subtype\s*\/Image/);
});

for (const style of STYLE_NAMES) {
  test(`${style} style changes nothing outside the document`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      const css = screenCss(style);
      const vars = [...new Set(css.match(/--[\w-]+/g))];
      const content = allFeaturesHtml();
      // The host page's own content, before and after the document, uses every class the style targets.
      writeFileSync(join(dir, 'host.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>body { margin: 2em; font: 15px Georgia; color: #333; }</style></head>
<body>
<main class="host">${content}</main>
<article class="markdown-body">${content}</article>
<aside class="host">${content}</aside>
<script>${SIGNATURE_JS}
  const vars = ${JSON.stringify(vars)};
  // html and body hold the document, so their sizes change with it.
  const sizes = ['width', 'height', 'inline-size', 'block-size', 'perspective-origin', 'transform-origin'];
  const outside = () => [
    ['html', signature(document.documentElement, vars, sizes)],
    ['body', signature(document.body, vars, sizes)],
    ...[...document.querySelectorAll('.host, .host *')].map((el) =>
      [el.tagName.toLowerCase() + (el.getAttribute('class') ? '.' + el.getAttribute('class').split(' ').join('.') : ''), signature(el, vars)]),
  ];
  const before = outside();
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(css).replaceAll('<', '\\u003c')};
  document.head.append(style);
  const changed = outside().flatMap(([what, after], i) => {
    if (after === before[i][1]) return [];
    const was = new Set(before[i][1].split('\\n'));
    return [what + ' ' + after.split('\\n').filter((line) => !was.has(line)).join(';').slice(0, 300)];
  });
  // Rules that apply outside .markdown-body whatever the host page holds, such as @page.
  const global = [];
  (function walk(rules) {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (const sel of rule.selectorText.split(/,(?![^(]*\\))/)) {
          if (!/^\\s*(\\.markdown-body|:where\\(\\.markdown-body\\))(?![\\w-])/.test(sel)) global.push(sel.trim());
        }
      } else if (rule instanceof CSSGroupingRule && !(rule instanceof CSSPageRule)) walk(rule.cssRules);
      // A bundled font is declared for the whole page, under a family name of md2pdf's own.
      else if (!(rule instanceof CSSFontFaceRule && /^["']?md2pdf /.test(rule.style.getPropertyValue('font-family')))) global.push(rule.cssText.slice(0, 80));
    }
  })(style.sheet.cssRules);
  window.probeOut = { changed: changed.slice(0, 20), global };
</script>
</body></html>`);
      const { changed, global } = probeInChrome(join(dir, 'host.html'), dir);
      assert.deepEqual(global, [], `rules outside .markdown-body: ${global.join(' | ')}`);
      assert.deepEqual(changed, [], `changed outside .markdown-body:\n${changed.join('\n')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${style} style keeps its code blocks under a host page's highlight.js theme`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      // A dark theme, loaded after the style, sets everything a theme can on .hljs and its tokens.
      const theme = readFileSync(require.resolve('highlight.js/styles/atom-one-dark.css'), 'utf8');
      writeFileSync(join(dir, 'host.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body>
<article class="markdown-body">${allFeaturesHtml()}</article>
<script>${SIGNATURE_JS}
  const code = () => [...document.querySelectorAll('.markdown-body pre, .markdown-body pre *')].map((el) => signature(el, []));
  const before = code();
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(theme).replaceAll('<', '\\u003c')};
  document.head.append(style);
  const after = code();
  window.probeOut = {
    elements: before.length,
    changed: after.flatMap((sig, i) => {
      const was = new Set(before[i].split('\\n'));
      const lines = sig.split('\\n').filter((line) => !was.has(line));
      return lines.length ? [document.querySelectorAll('.markdown-body pre, .markdown-body pre *')[i].className + ': ' + lines.join('; ').slice(0, 200)] : [];
    }).slice(0, 10),
  };
</script>
</body></html>`);
      const { elements, changed } = probeInChrome(join(dir, 'host.html'), dir);
      assert.ok(elements > 20, `only ${elements} code elements`);
      assert.deepEqual(changed, [], `the host theme changed:\n${changed.join('\n')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${style} style's documented variables can be overridden for one document`, () => {
    // The variables are the ones declared in the style's first rule, which documents them.
    const own = readFileSync(join(ROOT, 'styles', `${style}.css`), 'utf8');
    const vars = [...own.match(/\n:where\(\.markdown-body\) \{([^}]*)\}/)[1].matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]);
    // Every style uses the same names: all of these, plus a rule color and surface color if it has them.
    const required = ['font-size', 'leading', 'space', 'background', 'text', 'muted', 'accent', 'font', 'heading-font', 'code-font'];
    const optional = ['rule', 'surface'];
    assert.deepEqual(required.filter((name) => !vars.includes(`--md2pdf-${name}`)), [], 'missing');
    assert.deepEqual(vars.filter((v) => ![...required, ...optional].includes(v.replace(/^--md2pdf-/, ''))), [], 'not a shared name');
    const value = (v) =>
      v === '--md2pdf-font-size' ? '20pt' : /-(leading|space)$/.test(v) ? '3' : /font$/.test(v) ? 'fantasy' : 'rgb(255, 0, 255)';
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      const content = allFeaturesHtml();
      // A plain document, one per variable with only that variable overridden, and another plain one.
      const articles = [null, ...vars, null]
        .map((v) => `<article class="markdown-body"${v ? ` style="${v}: ${value(v)}"` : ''}>${content}</article>`)
        .join('\n');
      writeFileSync(join(dir, 'docs.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body>
${articles}
<script>${SIGNATURE_JS}
  const docs = [...document.querySelectorAll('article')].map((a) => [a, ...a.querySelectorAll('*')].map((el) => signature(el, [])));
  const size = (a, sel) => parseFloat(getComputedStyle(sel ? a.querySelector(sel) : a).fontSize);
  window.probeOut = {
    changed: docs.map((doc) => doc.filter((sig, i) => sig !== docs[0][i]).length),
    // Heading and code sizes as a multiple of the text size.
    ratios: [...document.querySelectorAll('article')].map((a) => [size(a, 'h1') / size(a), size(a, 'pre code') / size(a)]),
  };
</script>
</body></html>`);
      const { changed, ratios } = probeInChrome(join(dir, 'docs.html'), dir);
      const unchanged = vars.filter((v, i) => changed[i + 1] === 0);
      assert.deepEqual(unchanged, [], 'overriding these changed nothing');
      assert.equal(changed.at(-1), 0, 'an override on one document changed another');
      const scaled = ratios[vars.indexOf('--md2pdf-font-size') + 1];
      ratios[0].forEach((r, i) => assert.ok(Math.abs(scaled[i] - r) < 0.01, `size ratio ${r} became ${scaled[i]} with --font-size`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${style} style mutes embed placeholders`, () => {
    const css = readFileSync(join(ROOT, 'styles', `${style}.css`), 'utf8');
    assert.match(css, /\.markdown-body \.markdown-embed \{[^}]*color: [^;]+;/);
  });

  test(`${style} style takes its line heights and vertical gaps from --leading and --space`, () => {
    assert.match(readFileSync(join(ROOT, 'styles', `${style}.css`), 'utf8'), /:where\(\.markdown-body\) \{[^}]*--md2pdf-leading: 1;\s*--md2pdf-space: 1;/);
    const dir = workspace();
    try {
      // Different factors, so a gap scaled by --leading or a line height scaled by --space shows up.
      const LEADING = 2;
      const SPACE = 3;
      writeFileSync(join(dir, 'spacing.md'), SPACING_DOC);
      writeFileSync(join(dir, 'none.css'), '');
      writeFileSync(join(dir, 'scaled.css'), `.markdown-body { --md2pdf-leading: ${LEADING}; --md2pdf-space: ${SPACE}; }`);
      const [base, scaled] = ['none', 'scaled'].map((variant) => {
        const md = join(dir, `${variant}.md`);
        copyFileSync(join(dir, 'spacing.md'), md);
        const r = run('-s', style, '--css', join(dir, `${variant}.css`), '--html', md);
        assert.equal(r.status, 0, r.stderr);
        return computedSpacing(join(dir, `${variant}.html`), dir);
      });
      assert.equal(base.length, scaled.length);
      const failures = [];
      base.forEach((b, i) => {
        const s = scaled[i];
        // The task-list checkbox's bottom margin aligns it with its text; it isn't a gap.
        if (!b.what.startsWith('input')) {
          for (const side of ['top', 'bottom']) {
            if (b[side] !== 0 && Math.abs(s[side] - SPACE * b[side]) > 0.5) failures.push(`${b.what} margin-${side} ${b[side]} → ${s[side]}`);
          }
        }
        // --leading scales a line height's excess over the font size.
        const excess = b.lineHeight - b.fontSize;
        if (excess > 0.5 && Math.abs(s.lineHeight - s.fontSize - LEADING * excess) > 0.5) {
          failures.push(`${b.what} line-height ${b.lineHeight} → ${s.lineHeight} (font ${b.fontSize})`);
        }
      });
      assert.deepEqual(failures, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${style} style gives each callout family its own look`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    copyFileSync(join(FIXTURES, 'callouts.md'), join(dir, 'callouts.md'));
    const r = run('-s', style, '--html', join(dir, 'callouts.md'));
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(dir, 'callouts.html'), 'utf8');
    // Each family's color: GitHub's border-left-color, or the --md2pdf-callout variable our styles define.
    const colorOf = (family) =>
      html.match(new RegExp(`\\.markdown-alert(?:\\.markdown-alert)?-${family} \\{\\s*(?:--md2pdf-callout|border-left-color): ([^;]+);`))?.[1] ??
      (family === 'note' ? html.match(/\.markdown-alert \{\s*--md2pdf-callout: ([^;]+);/)?.[1] : undefined);
    const colors = ['note', 'tip', 'important', 'warning', 'caution', 'quote'].map(colorOf);
    assert.ok(colors.every(Boolean), `missing a family color: ${colors}`);
    assert.equal(new Set(colors).size, 6, `families share a color: ${colors}`);
    if (style !== 'github') assert.match(html, /\.markdown-alert-title \{[^}]*color: var\(--md2pdf-callout\);/);
    assert.ok(pageCount(join(dir, 'callouts.pdf')) >= 1);
  });
}

test('--output writes to the given path', () => {
  const dir = workspace();
  const target = join(dir, 'custom name.pdf');
  const r = run('-o', target, join(dir, 'sample.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(target));
});

test('converts multiple files in one call', () => {
  const dir = workspace();
  copyFileSync(join(dir, 'sample.md'), join(dir, 'second.md'));
  const r = run(join(dir, 'sample.md'), join(dir, 'second.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'sample.pdf')) && existsSync(join(dir, 'second.pdf')));
});

test('A4 page size produces a different page box than Letter', () => {
  const dir = workspace();
  run('-o', join(dir, 'a4.pdf'), '-p', 'A4', join(dir, 'sample.md'));
  run('-o', join(dir, 'letter.pdf'), join(dir, 'sample.md'));
  const box = (f) => readFileSync(join(dir, f), 'latin1').match(/\/MediaBox\s*\[([^\]]+)\]/)[1].trim();
  assert.notEqual(box('a4.pdf'), box('letter.pdf'));
});

test('reports a missing file with exit code 1', () => {
  const r = run('/nonexistent/nope.md');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No such file/);
});

test('rejects an unknown style', () => {
  const r = run('-s', 'bogus', join(FIXTURES, 'sample.md'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown style "bogus"/);
});

test('worksheet style keeps the title and its bar on one page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    writeFileSync(join(dir, 'title.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss('worksheet')}</style></head>
<body><article class="markdown-body"><h1>Title</h1></article>
<script>
  const h1 = document.querySelector('h1');
  window.probeOut = { bar: getComputedStyle(h1, '::after').display, breakInside: getComputedStyle(h1).breakInside };
</script></body></html>`);
    const { bar, breakInside } = probeInChrome(join(dir, 'title.html'), dir);
    assert.equal(bar, 'block');
    assert.equal(breakInside, 'avoid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A long web address in each kind of text block, and a table wider than the page.
const WIDE_DOC = `A paragraph with https://example.com/a/very/long/path/that/keeps/going/without/any/spaces/so/it/cannot/wrap?query=string&more=params after it.

- A list item with https://example.com/another/very/long/path/without/spaces/that/runs/past/the/right/margin/of/the/page

> A quote with https://example.com/yet/another/very/long/path/without/spaces/that/runs/past/the/margin/of/the/page

| Plan | Price | Seats | Storage | Support | Uptime | Region | Backups | Audit log | SSO |
| ---- | ----- | ----- | ------- | ------- | ------ | ------ | ------- | --------- | --- |
| Starter | $9 per month | 3 seats | 10 GB storage | Email support | 99.5 percent | United States | Daily backups | Not included | Not included |
`;

for (const style of STYLE_NAMES) {
  test(`${style} style keeps long web addresses and wide tables on the page`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      writeFileSync(join(dir, 'wide.md'), WIDE_DOC);
      const r = run('-s', style, '--html', join(dir, 'wide.md'));
      assert.equal(r.status, 0, r.stderr);
      // Lay the document out at the width it has on Letter paper, between the style's side margins.
      const side = parseFloat(pageMargins[style].split(' ')[1] ?? pageMargins[style]);
      const width = (8.5 - 2 * side) * 96;
      writeFileSync(join(dir, 'wide-probe.html'), readFileSync(join(dir, 'wide.html'), 'utf8').replace('</body>', `<script>
  const article = document.querySelector('.markdown-body');
  article.style.width = '${width}px';
  const right = article.getBoundingClientRect().right + 0.5;
  // A cell is cut off when an element between it and the document clips what overflows it.
  const clipped = [...document.querySelectorAll('td, th')].filter((cell) => {
    for (let el = cell.parentElement; el !== article; el = el.parentElement) {
      if (getComputedStyle(el).overflowX !== 'visible' && cell.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5) return true;
    }
    return false;
  }).length;
  window.probeOut = { clipped, past: [...document.querySelectorAll('p a, li a, blockquote a')].filter((a) => a.getBoundingClientRect().right > right).length };
</script></body>`));
      const { clipped, past } = probeInChrome(join(dir, 'wide-probe.html'), dir);
      assert.equal(past, 0, 'web addresses running past the margin');
      assert.equal(clipped, 0, 'table cells cut off');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const style of STYLE_NAMES) {
  test(`${style} style draws task-list boxes that print clearly and can't be ticked`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      const list = createRenderer({ hljs }).render('- [ ] Empty\n- [x] Ticked\n');
      writeFileSync(join(dir, 'tasks.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body><article class="markdown-body">${list}</article>
<script>
  const [empty, ticked] = [...document.querySelectorAll('.task-list-item input')].map((box) => ({ disabled: box.disabled, s: getComputedStyle(box) }));
  window.probeOut = {
    disabled: empty.disabled && ticked.disabled,
    appearance: [empty.s.appearance, ticked.s.appearance],
    page: getComputedStyle(document.querySelector('.markdown-body')).backgroundColor,
    emptyBorder: empty.s.borderTopColor, emptyBorderWidth: empty.s.borderTopWidth,
    tickedFill: ticked.s.backgroundColor,
  };
</script></body></html>`);
      const box = probeInChrome(join(dir, 'tasks.html'), dir);
      assert.ok(box.disabled, 'boxes can be ticked');
      // Chrome greys out a disabled box it draws itself, whatever accent-color says.
      assert.deepEqual(box.appearance, ['none', 'none']);
      assert.notEqual(box.emptyBorderWidth, '0px');
      // WCAG asks 3:1 of the parts of a control.
      assert.ok(contrast(box.emptyBorder, box.page) >= 3, `empty box border ${box.emptyBorder} on ${box.page}`);
      assert.ok(contrast(box.tickedFill, box.page) >= 3, `ticked box ${box.tickedFill} on ${box.page}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('no style lets a page break between a heading and the rule it draws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    for (const style of STYLE_NAMES) {
      writeFileSync(join(dir, 'h.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body><article class="markdown-body"><p>x</p><h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6></article>
<script>
  window.probeOut = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({
    tag: h.tagName,
    block: ['::before', '::after'].some((p) => getComputedStyle(h, p).content !== 'none' && getComputedStyle(h, p).display === 'block'),
    breakInside: getComputedStyle(h).breakInside,
  }));
</script></body></html>`);
      for (const { tag, block, breakInside } of probeInChrome(join(dir, 'h.html'), dir)) {
        if (block) assert.equal(breakInside, 'avoid', `${style} ${tag}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no style lets a page break between the footnotes line and the first footnote', () => {
  // Styles that draw the line as the section's top border need nothing: Chrome moves a border with
  // the first line under it. A line drawn by ::before is a block of its own.
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const notes = createRenderer({ hljs }).render('Text.[^1]\n\n[^1]: The note.');
    for (const style of STYLE_NAMES) {
      writeFileSync(join(dir, 'fn.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body><article class="markdown-body">${notes}</article>
<script>
  const s = getComputedStyle(document.querySelector('.footnotes'), '::before');
  window.probeOut = { block: s.content !== 'none' && s.display === 'block', breakAfter: s.breakAfter };
</script></body></html>`);
      const { block, breakAfter } = probeInChrome(join(dir, 'fn.html'), dir);
      if (block) assert.equal(breakAfter, 'avoid', style);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worksheet style prints with its bundled fonts', () => {
  // One page, so it has no page number, which is set in Fredoka too.
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    writeFileSync(join(dir, 'one.md'), '# Title\n\nPlain, **bold** and *italic* text.\n');
    const r = run('-s', 'worksheet', join(dir, 'one.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(pageCount(join(dir, 'one.pdf')), 1);
    const fonts = pdfFonts(join(dir, 'one.pdf'));
    for (const face of ['Andika', 'Andika-Bold', 'Andika-Italic', 'FredokaLight-SemiBold']) assert.ok(fonts.includes(face), `${face} not in ${fonts}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gothic style prints with its bundled fonts', () => {
  // One page, so it has no page number, which is set in IM Fell too.
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    writeFileSync(join(dir, 'one.md'), '# Title\n\nPlain, **bold** and *italic* text.\n');
    const r = run('-s', 'gothic', join(dir, 'one.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(pageCount(join(dir, 'one.pdf')), 1);
    const fonts = pdfFonts(join(dir, 'one.pdf'));
    for (const face of ['GrenzeGotisch-SemiBold', 'IM_FELL_English_Roman', 'IM_FELL_English_Italic']) assert.ok(fonts.includes(face), `${face} not in ${fonts}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gothic style sets a drop cap only under a leading title, and a short paragraph holds it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const md = createRenderer({ hljs });
    const doc = (body) => `<article class="markdown-body" style="width: 500px">${md.render(body)}</article>`;
    writeFileSync(join(dir, 'cap.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss('gothic')}</style></head>
<body>${doc('# Title\n\nShort.\n\nThe next paragraph starts at the margin.')}${doc('No title.')}${doc('Text.\n\n# Later title\n\nUnder a later title.')}${doc('# Title\n\n`code` starts this one.')}${doc('# Title\n\n[`createRenderer`](https://example.com) builds it.')}${doc('# Title\n\n**`code`** first.')}${doc('# Title\n\n<kbd>Ctrl</kbd> + C copies.')}
<script>
  const [titled, untitled, later, coded, linked, bolded, keyed] = document.querySelectorAll('.markdown-body');
  const font = (p) => getComputedStyle(p, '::first-letter').fontFamily;
  const next = titled.querySelectorAll('p')[1];
  const range = document.createRange();
  range.selectNodeContents(next.firstChild);
  window.probeOut = {
    indent: range.getClientRects()[0].left - titled.getBoundingClientRect().left,
    titled: font(titled.querySelector('p')),
    untitled: font(untitled.querySelector('p')),
    later: font(later.querySelectorAll('p')[1]),
    coded: font(coded.querySelector('p')),
    linked: font(linked.querySelector('p')),
    bolded: font(bolded.querySelector('p')),
    keyed: font(keyed.querySelector('p')),
  };
</script></body></html>`);
    const cap = probeInChrome(join(dir, 'cap.html'), dir);
    assert.match(cap.titled, /Grenze Gotisch/);
    for (const start of ['coded', 'linked', 'bolded', 'keyed']) assert.doesNotMatch(cap[start], /Grenze Gotisch/, `a paragraph starting with ${start} code has a drop cap`);
    assert.doesNotMatch(cap.untitled, /Grenze Gotisch/);
    assert.doesNotMatch(cap.later, /Grenze Gotisch/);
    assert.ok(Math.abs(cap.indent) < 1, `the paragraph after a short first one starts ${cap.indent}px from the margin`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandwake style prints with its bundled fonts', () => {
  // One page, so it has no running header or folio, which are set in Space Mono too.
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    writeFileSync(join(dir, 'one.md'), '# Title\n\nPlain, **bold**, *italic* and `code` text.\n\n## Section\n');
    const r = run('-s', 'sandwake', join(dir, 'one.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(pageCount(join(dir, 'one.pdf')), 1);
    const fonts = pdfFonts(join(dir, 'one.pdf'));
    for (const face of ['Michroma-Regular', 'Spectral-Regular', 'Spectral-SemiBold', 'Spectral-Italic', 'SpaceMono-Regular', 'SpaceMono-Bold']) assert.ok(fonts.includes(face), `${face} not in ${fonts}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandwake style numbers only the document's own titles as books", () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const html = createRenderer({ hljs }).render('# Title\n\n## One\n\n> # Quoted\n\n> [!note]\n> # In a callout\n\n# Book two\n');
    writeFileSync(join(dir, 'books.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss('sandwake')}</style></head>
<body><article class="markdown-body">${html}</article>
<script>
  window.probeOut = [...document.querySelectorAll('h1')].map((h) => ({
    text: h.textContent.trim(),
    counts: getComputedStyle(h).counterIncrement,
    sets: getComputedStyle(h).counterSet,
    label: getComputedStyle(h, '::before').content,
  }));
</script></body></html>`);
    const [title, quoted, callout, two] = probeInChrome(join(dir, 'books.html'), dir);
    assert.match(title.counts, /md2pdf-book/);
    assert.match(title.sets, /md2pdf-section 0/);
    assert.equal(title.label, 'none', 'the first title has no book label');
    for (const nested of [quoted, callout]) {
      assert.equal(nested.counts, 'none', `${nested.text} counts as a book`);
      assert.equal(nested.sets, 'none', `${nested.text} restarts the sections`);
      assert.equal(nested.label, 'none', `${nested.text} has a book label`);
    }
    assert.match(two.counts, /md2pdf-book/);
    assert.notEqual(two.label, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandwake style sets a drop cap only under a leading title, and a short paragraph holds it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const md = createRenderer({ hljs });
    const doc = (body) => `<article class="markdown-body" style="width: 500px">${md.render(body)}</article>`;
    writeFileSync(join(dir, 'cap.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss('sandwake')}</style></head>
<body>${doc('# Title\n\nShort.\n\nThe next paragraph starts at the margin.')}${doc('No title.')}${doc('Text.\n\n# Later title\n\nUnder a later title.')}${doc('# Title\n\n`code` starts this one.')}${doc('# Title\n\n[`createRenderer`](https://example.com) builds it.')}${doc('# Title\n\n**`code`** first.')}${doc('# Title\n\n<kbd>Ctrl</kbd> + C copies.')}
<script>
  const [titled, untitled, later, coded, linked, bolded, keyed] = document.querySelectorAll('.markdown-body');
  const font = (p) => getComputedStyle(p, '::first-letter').fontFamily;
  const next = titled.querySelectorAll('p')[1];
  const range = document.createRange();
  range.selectNodeContents(next.firstChild);
  window.probeOut = {
    indent: range.getClientRects()[0].left - titled.getBoundingClientRect().left,
    titled: font(titled.querySelector('p')),
    untitled: font(untitled.querySelector('p')),
    later: font(later.querySelectorAll('p')[1]),
    coded: font(coded.querySelector('p')),
    linked: font(linked.querySelector('p')),
    bolded: font(bolded.querySelector('p')),
    keyed: font(keyed.querySelector('p')),
  };
</script></body></html>`);
    const cap = probeInChrome(join(dir, 'cap.html'), dir);
    assert.match(cap.titled, /Michroma/);
    for (const start of ['coded', 'linked', 'bolded', 'keyed']) assert.doesNotMatch(cap[start], /Michroma/, `a paragraph starting with ${start} code has a drop cap`);
    assert.doesNotMatch(cap.untitled, /Michroma/);
    assert.doesNotMatch(cap.later, /Michroma/);
    assert.ok(Math.abs(cap.indent) < 1, `the paragraph after a short first one starts ${cap.indent}px from the margin`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classic style renders with its own stylesheet', () => {
  const dir = workspace();
  const r = run('-s', 'classic', '--html', join(dir, 'sample.md'));
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(dir, 'sample.html'), 'utf8');
  assert.match(html, /Iowan Old Style/);
  assert.doesNotMatch(html, /color-scheme: light/);
  assert.ok(existsSync(join(dir, 'sample.pdf')));
});

for (const [style, marker] of [
  ['academic', /counter\(h2\) "\." counter\(h3\)/],
  ['modern', /Avenir Next/],
  ['report', /content: var\(--document-title\)/],
  ['resume', /h1 \+ p/],
  ['worksheet', /md2pdf Andika/],
  ['gothic', /md2pdf Grenze Gotisch/],
  ['sandwake', /md2pdf Michroma/],
]) {
  test(`${style} style renders with its own stylesheet`, () => {
    const dir = workspace();
    const r = run('-s', style, '--html', join(dir, 'sample.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, 'sample.html'), 'utf8'), marker);
    assert.ok(pageCount(join(dir, 'sample.pdf')) >= 1);
  });
}

for (const style of STYLE_NAMES) {
  test(`the CLI prints ${style} with its print rules`, () => {
    const dir = workspace();
    const r = run('-s', style, '--html', join(dir, 'sample.md'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.match(readFileSync(join(dir, 'sample.html'), 'utf8'), new RegExp(`@page \\{\\s*margin: ${pageMargins[style]};`));
  });

  test(`${style} style colors highlighted code`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    try {
      const code = createRenderer({ hljs }).render('```js\nconst s = "x"; // note\n```');
      writeFileSync(join(dir, 'hl.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${screenCss(style)}</style></head>
<body><article class="markdown-body">${code}</article>
<script>
  const color = (sel) => getComputedStyle(document.querySelector(sel)).color;
  window.probeOut = {
    code: color('pre code'), keyword: color('.hljs-keyword'), string: color('.hljs-string'), comment: color('.hljs-comment'),
    background: ['pre code', 'pre', '.markdown-body', 'body'].map((sel) => getComputedStyle(document.querySelector(sel)).backgroundColor),
  };
</script></body></html>`);
      const c = probeInChrome(join(dir, 'hl.html'), dir);
      for (const token of ['keyword', 'string', 'comment']) assert.notEqual(c[token], c.code, `${token} has the plain code color`);
      // The nearest background that isn't transparent; the page is white without one.
      const background = c.background.find((bg) => !/^rgba\(.*, 0\)$/.test(bg)) ?? 'rgb(255, 255, 255)';
      assert.ok(contrast(c.comment, background) >= 4.5, `comment ${c.comment} on ${background}: ${contrast(c.comment, background).toFixed(2)}:1`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('gives styles the first heading for running headers', () => {
  const dir = workspace();
  const r = run('--html', join(dir, 'sample.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'sample.html'), 'utf8'), /--document-title: "md2pdf Sample Document";/);
});

test('headingText takes the rendered first h1, not its Markdown source', () => {
  assert.equal(headingText('<p>x</p><h1 id="q3">Q3 <strong>Revenue</strong> &amp; “costs” 🚀</h1><h1>Later</h1>'), 'Q3 Revenue & “costs” 🚀');
  assert.equal(headingText('<h2>Only a subheading</h2>'), '');
});

test('the running-header title is the first heading, empty without one, never the file name', () => {
  const doc = (bodyHtml) => buildDocument({ bodyHtml, title: 'file-stem', css: '' });
  assert.match(doc('<h1>Real <em>Title</em></h1>'), /--document-title: "Real Title";/);
  assert.match(doc('<p>No heading</p>'), /--document-title: "";/);
});

test('pageMargins gives each style the margin of its @page rule', () => {
  const listed = run('--list-styles').stdout.match(/^. (\S+)$/gm).map((line) => line.slice(2));
  assert.deepEqual(Object.keys(pageMargins).sort(), listed.sort());
  for (const style of listed) {
    const css = readFileSync(join(ROOT, 'styles', 'print', `${style}.css`), 'utf8');
    const margins = [...css.matchAll(/^@page[^{]*\{([^]*?)^\}/gm)].flatMap(([, body]) => body.match(/^  margin: ([^;]+);/m)?.[1] ?? []);
    assert.deepEqual(margins, [pageMargins[style]], style);
  }
});

test('rewriteUrls rewrites relative url()s and leaves everything else as it was', () => {
  const rewrite = (css) => rewriteUrls(css, (ref) => `file:///s/${ref}`);
  for (const [css, expected] of [
    ['a { src: url("fonts/a.woff2") }', 'a { src: url("file:///s/fonts/a.woff2") }'],
    ["a { src: url('x y.png') }", 'a { src: url("file:///s/x y.png") }'],
    ['a { src: url( b.png ) URL(../c.png) }', 'a { src: url("file:///s/b.png") url("file:///s/../c.png") }'],
    ['a { src: url(100%.png) }', 'a { src: url("file:///s/100%.png") }'],
  ]) assert.equal(rewrite(css), expected);
  for (const css of [
    '/* src: url("fonts/<family>/<file>.woff2") */',
    'a { content: "see url(x.png)" } b { content: \'it\\\'s url(y.png)\' }',
    'a { b: url("fonts/\\66oo.woff2") url(a\\(1\\).png) }',
    'a { b: url(https://example.com/a.png) url("data:image/png;base64,AAAA") url(#clip) url(/abs/b.png) url("") }',
    readFileSync(require.resolve('github-markdown-css/github-markdown-light.css'), 'utf8'),
    // The styles, less those that bundle fonts: their url()s are relative.
    ...STYLE_NAMES.flatMap((s) => [`${s}.css`, `print/${s}.css`].map((f) => readFileSync(join(ROOT, 'styles', f), 'utf8')))
      .filter((css) => relativeUrls(css).length === 0),
  ]) assert.equal(rewrite(css), css);
});

// A stylesheet in a folder of its own, away from the Markdown, with the test fonts in fonts/ beside it.
function stylesheetWithFonts(css) {
  const dir = join(mkdtempSync(join(tmpdir(), 'md2pdf-css-')), 'My Styles é');
  cpSync(join(FIXTURES, 'fonts'), join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'style.css'), css);
  return join(dir, 'style.css');
}
const TEST_FONT_FACES = [['400-normal', 400, 'normal'], ['700-normal', 700, 'normal'], ['400-italic', 400, 'italic']]
  .map(([file, weight, style]) => `@font-face { font-family: "md2pdf Test"; font-weight: ${weight}; font-style: ${style};
  src: url("fonts/comic-neue/comic-neue-latin-${file}.woff2") format("woff2"); }`)
  .join('\n');

test('the CLI loads the fonts a stylesheet bundles, relative to the stylesheet', () => {
  const dir = workspace();
  const css = stylesheetWithFonts(`${TEST_FONT_FACES}\n.markdown-body { font-family: "md2pdf Test", Georgia; }`);
  const r = run('--css', css, join(dir, 'sample.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const fonts = pdfFonts(join(dir, 'sample.pdf'));
  for (const face of ['ComicNeue-Regular', 'ComicNeue-Bold', 'ComicNeue-Italic']) assert.ok(fonts.includes(face), `${face} not in ${fonts}`);
});

test('a font used only in the page header still loads', () => {
  const dir = workspace();
  const css = stylesheetWithFonts(`${TEST_FONT_FACES}\n@page { @top-center { content: "Header"; font-family: "md2pdf Test"; font-weight: 700; } }`);
  const r = run('--css', css, join(dir, 'sample.md'));
  assert.equal(r.status, 0, r.stderr);
  const fonts = pdfFonts(join(dir, 'sample.pdf'));
  assert.ok(fonts.includes('ComicNeue-Bold'), fonts.join(' '));
});

test('a stylesheet URL to a missing file is reported once, and an unreadable one is left to Chrome', () => {
  const dir = workspace();
  copyFileSync(join(dir, 'sample.md'), join(dir, 'second.md'));
  const css = stylesheetWithFonts('@font-face { font-family: "md2pdf Gone"; src: url(fonts/gone.woff2); }\n.markdown-body { background: url(a%2Fb.png); }');
  const r = run('--css', css, join(dir, 'sample.md'), join(dir, 'second.md'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.match(/no such file: fonts\/gone\.woff2/g)?.length, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /a%2Fb/);
});

// What breaks the rules for bundled fonts (README, "Adding a style") in a folder laid out like styles/:
// on-screen stylesheets, print/ stylesheets and fonts/<family>/.
function fontProblems(stylesDir) {
  const problems = [];
  const fontsDir = join(stylesDir, 'fonts');
  for (const sub of ['', 'print'].filter((s) => existsSync(join(stylesDir, s)))) {
    for (const file of readdirSync(join(stylesDir, sub)).filter((f) => f.endsWith('.css')).map((f) => join(sub, f))) {
      const css = readFileSync(join(stylesDir, file), 'utf8');
      const code = css.replace(/\/\*[^]*?\*\//g, '');
      if (/local\(/i.test(code)) problems.push(`${file}: uses local()`);
      if (/font-display\s*:\s*optional/i.test(code)) problems.push(`${file}: uses font-display: optional`);
      const faces = code.match(/@font-face\s*\{[^}]*\}/gi) ?? [];
      if (sub && faces.length) problems.push(`${file}: declares @font-face in a print file`);
      for (const face of faces) {
        const family = face.match(/font-family\s*:\s*["']?([^;"'}]*)/i)?.[1].trim();
        if (!/^md2pdf /.test(family)) problems.push(`${file}: font family "${family}" isn't namespaced`);
      }
      for (const ref of relativeUrls(css)) {
        const target = relative(fontsDir, fileURLToPath(new URL(ref, pathToFileURL(join(stylesDir, file)))));
        if (!/^[^/.][^/]*\/[^/]+\.woff2$/.test(target)) problems.push(`${file}: ${ref} isn't a .woff2 in fonts/<family>/`);
        else if (!existsSync(join(fontsDir, target))) problems.push(`${file}: ${ref} doesn't exist`);
      }
    }
  }
  const families = existsSync(fontsDir) ? readdirSync(fontsDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  for (const { name: family } of families) {
    const files = readdirSync(join(fontsDir, family)).filter((f) => f !== '.DS_Store');
    const license = join(fontsDir, family, 'OFL.txt');
    if (!existsSync(license) || !/SIL Open Font License/.test(readFileSync(license, 'utf8'))) problems.push(`fonts/${family}: has no OFL.txt`);
    for (const f of files.filter((f) => f !== 'OFL.txt')) {
      if (!f.endsWith('.woff2')) problems.push(`fonts/${family}/${f}: only .woff2 files and OFL.txt belong here`);
      else if (readFileSync(join(fontsDir, family, f)).subarray(0, 4).toString('latin1') !== 'wOF2') problems.push(`fonts/${family}/${f}: isn't a woff2 font`);
    }
  }
  return problems;
}

// A folder laid out like styles/ holding `files` ({ path: text }), with the test fonts in fonts/.
function styleTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-styles-'));
  cpSync(join(FIXTURES, 'fonts'), join(dir, 'fonts'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('the styles and test fonts follow the rules for bundled fonts', () => {
  assert.deepEqual(fontProblems(join(ROOT, 'styles')), []);
  assert.deepEqual(fontProblems(FIXTURES), []);
  const face = (rest) => `@font-face { font-family : "md2pdf Test"; ${rest} }`;
  const font = 'fonts/comic-neue/comic-neue-latin-400-normal.woff2';
  assert.deepEqual(fontProblems(styleTree({
    'x.css': `${face(`src: URL( ${font} ) format("woff2");`)}\n/* src: url(fonts/<family>/x.ttf); local(Comic) */`,
    'print/x.css': `@page { @top-center { font-family: "md2pdf Test"; background: url(../${font}); } }`,
    'fonts/.DS_Store': '',
    'fonts/comic-neue/.DS_Store': '',
  })), []);
  for (const [files, problem] of [
    [{ 'x.css': `@FONT-FACE { font-family : Playful; src: url(${font}); }` }, /font family "Playful" isn't namespaced/],
    [{ 'x.css': face('src: local("Comic Neue");') }, /uses local\(\)/],
    [{ 'x.css': face(`src: url(${font}); font-display: optional;`) }, /font-display: optional/],
    [{ 'print/x.css': face(`src: url(../${font});`) }, /@font-face in a print file/],
    [{ 'x.css': face('src: url(fonts/comic-neue/a.ttf);') }, /a\.ttf isn't a \.woff2 in fonts\/<family>\//],
    [{ 'x.css': face(`src: url(../${font});`) }, /isn't a \.woff2 in fonts\/<family>\//],
    [{ 'x.css': face('src: url(fonts/comic-neue/missing.woff2);') }, /missing\.woff2 doesn't exist/],
    [{ 'fonts/comic-neue/ComicNeue-Regular.ttf': 'ttf' }, /only \.woff2 files and OFL\.txt belong here/],
    [{ 'fonts/lfs/a.woff2': 'version https://git-lfs.github.com/spec/v1', 'fonts/lfs/OFL.txt': 'SIL Open Font License' }, /fonts\/lfs\/a\.woff2: isn't a woff2 font/],
    [{ 'fonts/nolicense/a.woff2': readFileSync(join(FIXTURES, font)) }, /fonts\/nolicense: has no OFL\.txt/],
  ]) {
    const problems = fontProblems(styleTree(files));
    assert.equal(problems.length, 1, `${JSON.stringify(Object.keys(files))}: ${problems}`);
    assert.match(problems[0], problem);
  }
});

test('print rules stay out of the on-screen styles', () => {
  for (const style of STYLE_NAMES) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'styles', `${style}.css`), 'utf8').replace(/\/\*[^]*?\*\//g, ''), /@page|:root|^html|^body|--document-title/m, style);
  }
});

test('the demo loads every renderer dependency, at the installed version', () => {
  const page = readFileSync(join(ROOT, 'demo', 'index.html'), 'utf8');
  const { imports } = JSON.parse(page.match(/<script type="importmap">([^]*?)<\/script>/)[1]);
  // The packages render.js imports, directly or through its own modules.
  const libImports = [];
  const seen = new Set();
  (function follow(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)) {
      if (spec.startsWith('.')) follow(join(dirname(file), spec));
      else libImports.push(spec);
    }
  })(join(ROOT, 'lib', 'render.js'));
  assert.ok(seen.size >= 3 && libImports.length >= 3, 'found the renderer imports');
  for (const name of libImports) assert.ok(imports[name], `import map lacks ${name}`);

  const urls = [...Object.values(imports), ...[...page.matchAll(/<link [^>]*href="(https:[^"]+)"/g)].map((m) => m[1])];
  assert.equal(urls.length, 5);
  for (const url of urls) {
    const [, name, version] = url.match(/^https:\/\/(?:esm\.sh|cdn\.jsdelivr\.net\/npm)\/(@?[^@]+)@([^/]+)/);
    const pkg = name === '@highlightjs/cdn-assets' ? 'highlight.js' : name;
    assert.equal(version, require(`${pkg}/package.json`).version, url);
  }
});

test('createRenderer passes raw HTML through unless html is false', () => {
  const opts = { hljs: { getLanguage: () => undefined } };
  assert.equal(createRenderer(opts).render('<b>x</b>'), '<p><b>x</b></p>\n');
  const safe = createRenderer({ ...opts, html: false });
  assert.equal(safe.render('<b>x</b> <img src=x onerror=alert(1)>'), '<p>&lt;b&gt;x&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;</p>\n');
  assert.equal(safe.render('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
  assert.match(safe.render('> [!note]\n> x'), /^<div class="markdown-alert markdown-alert-note"/);
});

// Markdown someone else wrote, rendered the way the README tells a host page to: html: false, an id
// prefix and math. md2pdf.me also passes texmath, which the renderer no longer uses.
async function untrustedRenderer() {
  const { default: katex } = await import('katex');
  return createRenderer({ hljs, html: false, idPrefix: 'doc-', math: { katex, texmath: require('markdown-it-texmath') } });
}
// Other markdown-it instances on the page using the plugins md2pdf used to share state with. The last
// .use of markdown-it-task-lists sets its options for every instance.
async function poisonHostPlugins() {
  const { default: katex } = await import('katex');
  new MarkdownIt().use(require('markdown-it-texmath'), { engine: katex, katexOptions: { trust: true } });
  new MarkdownIt().use(require('markdown-it-task-lists'), { enabled: true, label: true, labelAfter: true });
}

test('task lists render as before', () => {
  assert.equal(render('- [ ] Open\n- [x] Done\n- [X] Also done\n- plain'),
    '<ul class="contains-task-list">\n' +
    '<li class="task-list-item"><label><input class="task-list-item-checkbox" disabled="" type="checkbox"> Open</label></li>\n' +
    '<li class="task-list-item"><label><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Done</label></li>\n' +
    '<li class="task-list-item"><label><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Also done</label></li>\n' +
    '<li>plain</li>\n</ul>\n');
  assert.equal(render('1. [ ] One\n\n2. [x] Two'),
    '<ol class="contains-task-list">\n' +
    '<li class="task-list-item">\n<p><label><input class="task-list-item-checkbox" disabled="" type="checkbox"> One</label></p>\n</li>\n' +
    '<li class="task-list-item">\n<p><label><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Two</label></p>\n</li>\n</ol>\n');
  assert.equal(render('> - [ ] Quoted'),
    '<blockquote>\n<ul class="contains-task-list">\n' +
    '<li class="task-list-item"><label><input class="task-list-item-checkbox" disabled="" type="checkbox"> Quoted</label></li>\n</ul>\n</blockquote>\n');
  assert.match(render('Text.[^1]\n\n[^1]: - [ ] In a note'),
    /<li id="fn1" class="footnote-item"><ul class="contains-task-list">\n<li class="task-list-item"><label><input class="task-list-item-checkbox" disabled="" type="checkbox"> In a note<\/label><\/li>/);
  // markdown-it-task-lists' quirk: an [x] that is a link reference still ticks the box and keeps the link.
  assert.equal(render('- [x] ref\n\n[x]: https://example.com'),
    '<ul class="contains-task-list">\n<li class="task-list-item"><label><input class="task-list-item-checkbox" checked="" disabled="" ' +
    'type="checkbox"><a href="https://example.com">x</a> ref</label></li>\n</ul>\n');
});

test('another markdown-it on the page can\'t change md2pdf\'s task lists', async () => {
  const md = createRenderer({ hljs, html: false });
  await poisonHostPlugins();
  const html = md.render('- [ ] <img src=x onerror=alert(1)>');
  assert.equal(html, '<ul class="contains-task-list">\n<li class="task-list-item"><label><input class="task-list-item-checkbox" disabled="" ' +
    'type="checkbox"> &lt;img src=x onerror=alert(1)&gt;</label></li>\n</ul>\n');
});

test('with html: false, no token carries raw HTML and every markup-writing rule is known', async () => {
  const md = await untrustedRenderer();
  const raw = [];
  const walk = (tokens) => tokens.forEach((t) => {
    if (t.type === 'html_inline' || t.type === 'html_block') raw.push(t.content);
    if (t.children) walk(t.children);
  });
  for (const doc of [readFileSync(join(FIXTURES, 'sample.md'), 'utf8'), readFileSync(join(FIXTURES, 'callouts.md'), 'utf8'), SPACING_DOC]) {
    walk(md.parse(doc, {}));
  }
  assert.deepEqual(raw, []);
  // Each of these writes markup itself rather than through markdown-it's escaping renderer. A new one must
  // escape what it takes from the document, and be added here.
  assert.deepEqual(Object.keys(md.renderer.rules).sort(), [
    'callout_title_close', 'callout_title_open', 'code_block', 'code_inline', 'emoji', 'fence',
    'footnote_anchor', 'footnote_anchor_name', 'footnote_block_close', 'footnote_block_open', 'footnote_caption',
    'footnote_close', 'footnote_open', 'footnote_ref', 'hardbreak', 'html_block', 'html_inline', 'image',
    'math_block', 'math_block_eqno', 'math_inline', 'math_inline_double', 'softbreak', 'task_checkbox',
    'task_label_close', 'task_label_open', 'text', 'wikilink_embed',
  ]);
});

test('idPrefix starts every id and every link to one', () => {
  const md = createRenderer({ hljs, idPrefix: 'doc-' });
  const html = md.render('# Config\n\n# Config\n\nSee [[#Config]], [setup](#config), [top](#) and [site](https://example.com/#x).[^1] ^[Inline, [see](#config).]\n\n[^1]: Note.');
  assert.match(html, /<h1 id="doc-config" tabindex="-1">Config<\/h1>\n<h1 id="doc-config-1" tabindex="-1">Config<\/h1>/);
  assert.match(html, /<a href="#doc-config">Config<\/a>, <a href="#doc-config">setup<\/a>, <a href="#">top<\/a> and <a href="https:\/\/example.com\/#x">site<\/a>/);
  assert.match(html, /<sup class="footnote-ref"><a href="#doc-fn:1" id="doc-fnref:1">\[1\]<\/a><\/sup>/);
  assert.match(html, /<li id="doc-fn:1" class="footnote-item"><p>Note. <a href="#doc-fnref:1" class="footnote-backref">/);
  assert.match(html, /<li id="doc-fn:2" class="footnote-item"><p>Inline, <a href="#doc-config">see<\/a>\./);
  // A heading named after a footnote no longer shares its id.
  assert.match(createRenderer({ hljs, idPrefix: 'doc-' }).render('# fn1\n\nx[^1]\n\n[^1]: n'), /id="doc-fn1"[^]*id="doc-fn:1"/);

  // Two documents on one page share no id.
  const idsOf = (h) => [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const other = createRenderer({ hljs, idPrefix: 'other-' }).render('# Config\n\nx[^1]\n\n[^1]: n');
  assert.deepEqual(idsOf(html).filter((id) => idsOf(other).includes(id)), []);

  // Without it, ids are as they were.
  assert.match(createRenderer({ hljs }).render('# Config\n\nx[^1]\n\n[^1]: n'), /id="config"[^]*href="#fn1" id="fnref1"[^]*<li id="fn1"/);
  for (const bad of ['doc', '1doc-', 'a b-', '"x-', 'doc-"', 3]) {
    assert.throws(() => createRenderer({ hljs, idPrefix: bad }), TypeError, String(bad));
  }
});

test('identical headings are numbered as before', () => {
  assert.equal(render('# a\n# a\n# a-1\n# a\n# b'),
    '<h1 id="a" tabindex="-1">a</h1>\n<h1 id="a-1" tabindex="-1">a</h1>\n<h1 id="a-1-1" tabindex="-1">a-1</h1>\n' +
    '<h1 id="a-2" tabindex="-1">a</h1>\n<h1 id="b" tabindex="-1">b</h1>\n');
});

test('callout types named after Object.prototype members look like notes', () => {
  for (const type of ['__proto__', 'constructor', 'toString']) {
    assert.match(createRenderer({ hljs }).render(`> [!${type}]\n> x`), /^<div class="markdown-alert markdown-alert-note"[^]*<path d="M0 8a8/, type);
  }
});

test('a wikilink containing a line separator renders instead of throwing', () => {
  assert.equal(render('[[a\u2028b]] ![[c\u2029d]] [[e\u2028f|g]]'), '<p>a\u2028b <span class="markdown-embed">Embedded note: c\u2029d</span> g</p>\n');
});

test('math refuses macro definitions and very long formulas, and caps sizes', async () => {
  const md = await untrustedRenderer();
  assert.match(md.render('$\\def\\a{x}\\a$'), /<eq><span class="katex-error" title="Macro definitions aren&#039;t supported" style="color:#cc0000">\\def\\a\{x\}\\a<\/span><\/eq>/);
  assert.match(md.render('$$\\newcommand{\\b}{y}\\b$$'), /katex-error" title="Macro definitions/);
  assert.match(md.render('$\\\\\\let\\a b$'), /katex-error" title="Macro definitions/);
  // \verb\a\ ends at its second backslash, so the \def after it is a definition.
  assert.match(md.render('$\\verb\\a\\\\def\\x{QQ}\\x$'), /katex-error" title="Macro definitions/);
  assert.match(md.render(`$${'x'.repeat(8001)}$`), /katex-error" title="Formulas over 8000 characters aren&#039;t rendered"/);
  assert.doesNotMatch(md.render(`$${'x'.repeat(8000)}$`), /katex-error/);
  // A command that only starts like one isn't a definition.
  assert.doesNotMatch(md.render('$\\default$ $\\letter$'), /Macro definitions/);
  assert.doesNotMatch(md.render('$\\rule{100000em}{100000em}$'), /100000em/);
  assert.doesNotMatch(md.render('$\\raisebox{60em}{x}$'), /-6\d(\.\d+)?em/);
  // An exception from KaTeX, such as nesting too deep for the stack, comes back as text.
  const throwing = createRenderer({ hljs, math: { katex: { renderToString() { throw new RangeError('too deep'); } } } });
  assert.equal(throwing.render('$x<y$'), '<p><eq>x&lt;y:too deep</eq></p>\n');
  assert.doesNotThrow(() => md.render(`$${'\\sqrt{'.repeat(1000)}x${'}'.repeat(1000)}$`));
  // KaTeX's output goes into the page as it is: $& and $$ in it aren't replacement patterns.
  assert.match(md.render('$\\text{\\$\\&}$'), /\$&amp;/);
  assert.doesNotMatch(md.render('$\\href{javascript:alert(1)}{x}$ $\\htmlId{x}{y}$'), /href="javascript|id="x"/);
});

test('math stops rendering once a document has made 10,000,000 characters of HTML', async () => {
  const md = await untrustedRenderer();
  // Without the budget, 120 KB of this is 15.9 MB of HTML.
  const source = '$x_y$ '.repeat(20000);
  const html = md.render(source);
  assert.ok(html.length < 11_000_000, `${html.length} characters`);
  assert.match(html, /^<p><eq><span class="katex">/);
  // Only the first formula past the budget says why.
  assert.equal((html.match(/<eq><span class="katex-error" title="The document&#039;s formulas reached their limit of 10,000,000 characters of HTML" style="color:#cc0000">x_y<\/span><\/eq>/g) ?? []).length, 1);
  assert.match(html, /<eq><span class="katex-error" style="color:#cc0000">x_y<\/span><\/eq><\/p>\n$/);

  // A host can change it. A formula whose HTML would take the document past it shows as its source too:
  // this matrix is over 4,000,000 characters of HTML.
  const { default: katex } = await import('katex');
  const matrix = `$$\\begin{smallmatrix}${'&'.repeat(7900)}\\end{smallmatrix}$$`;
  const capped = createRenderer({ hljs, math: { katex, maxHtml: 10_000 } });
  const small = capped.render(`$a$ $b$\n\n${matrix}\n\n$c$ $$d$$\n\n$$e$$ (1)`);
  assert.ok(small.length < 100_000, `${small.length} characters`);
  assert.equal((small.match(/class="katex"/g) ?? []).length, 2);
  assert.equal((small.match(/class="katex-error"/g) ?? []).length, 4);
  assert.equal((small.match(/reached their limit of 10,000 characters/g) ?? []).length, 1);
  // The budget starts again with each render, even when the env is reused or the tokens rendered twice.
  const env = {};
  capped.render(matrix, env);
  assert.doesNotMatch(capped.render('$x$', env), /katex-error/);
  const tokens = capped.parse(`${matrix}\n\n$x$`, {});
  for (let i = 0; i < 2; i++) assert.match(capped.renderer.render(tokens, capped.options), /^<section><eqn><span class="katex-error" title=/);
  const inline = capped.parseInline(`$x$ ${matrix} $y$`, {})[0].children;
  for (let i = 0; i < 2; i++) assert.match(capped.renderer.renderInline(inline, capped.options), /^<eq><span class="katex">[^]*title=[^]*>y<\/span><\/eq>$/);
  // A render a rule starts inside another spends the same budget.
  const nested = createRenderer({ hljs, math: { katex, maxHtml: 10_000 } });
  nested.renderer.rules.text = (tokens, idx) => {
    const { content } = tokens[idx];
    return content.includes('#') ? nested.renderInline(content.replace(/#/g, '$')) : content;
  };
  assert.match(nested.render(`${matrix}\n\n#z#`), /<p><eq><span class="katex-error" style="color:#cc0000">z<\/span><\/eq><\/p>/);
  // Past the budget, the HTML stays in proportion to the Markdown, as without math.
  const none = createRenderer({ hljs, math: { katex, maxHtml: 0 } });
  const short = '\\(x\\)'.repeat(100000);
  assert.ok(none.render(short).length < 15 * short.length);
  assert.match(none.render('$a$'), /katex-error/);
  assert.doesNotMatch(createRenderer({ hljs, math: { katex, maxHtml: Infinity } }).render(source), /katex-error/);
  for (const maxHtml of [-1, NaN, '100', null]) {
    assert.throws(() => createRenderer({ hljs, math: { katex, maxHtml } }), TypeError, String(maxHtml));
  }
});

test('math in a blockquote and with equation numbers renders as before', async () => {
  const md = await untrustedRenderer();
  const html = md.render('> $$\n> a\n> = b\n> $$\n\n$$c$$ (1)\n\n\\[d\\] (eq. 2)\n\n\\begin{aligned}e\\end{aligned}\n\nInline \\(f\\) and $g$, x$$h$$.');
  assert.equal((html.match(/<section><eqn>/g) ?? []).length, 3);
  assert.equal((html.match(/<section class="eqno"><eqn>/g) ?? []).length, 2);
  assert.match(html, /<span>\(1\)<\/span>[^]*<span>\(eq. 2\)<\/span>/);
  assert.equal((html.match(/<eq>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /&gt;/);
  // A formula ends inside the quote it starts in.
  assert.match(md.render('> \\[x\n\nafter \\]'), /^<blockquote>\n<p>\[x<\/p>\n<\/blockquote>\n<p>after \]<\/p>/);
});

test('math parses as markdown-it-texmath did', async () => {
  const { default: katex } = await import('katex');
  const texmath = require('markdown-it-texmath');
  // md2pdf's math before #32: texmath with these options, and its $ rules again, taking a line break.
  const old = new MarkdownIt().use(texmath, {
    engine: katex, delimiters: ['brackets', 'dollars', 'beg_end'], outerSpace: true, katexOptions: { throwOnError: false, output: 'html' },
  });
  const pre = (src, _outerSpace, at) => at === 0 || /\s/.test(src[at - 1]);
  const post = (src, _outerSpace, at) => at + 1 >= src.length || /[\s.,;]/.test(src[at + 1]);
  for (const rule of texmath.rules.dollars.inline) {
    old.inline.ruler.before('math_inline_double', `${rule.name}_wrapped`, texmath.inline({ ...rule, rex: new RegExp(rule.rex), pre, post }));
  }
  const now = new MarkdownIt().use(mathRules, { katex });
  const shape = (tokens) => tokens.map((t) => [t.type, t.tag, t.content, t.markup, t.info, t.map?.join(), t.nesting, t.children && shape(t.children)]);

  const pieces = ['$', '$', '$$', '\\(', '\\)', '\\[', '\\]', '\\begin{a}', '\\end{a}', '\\begin{ab}', '\\end{ab}', ' (1)', '(', ')',
    ' ', ' ', '\n', '\n', '\n\n', '> ', '\n> ', 'x', '1', '.', ',', '\\', '\\\\', '\t', String.fromCharCode(0x2028), '{', '}', '- ', '1. ',
    '[a](b)', '`', '*'];
  let seed = 32;
  const random = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const docs = [readFileSync(join(FIXTURES, 'sample.md'), 'utf8'), '> $$\n> a\n> $$', '$$x$$ (1)\n\n\\[y\\] (2)', 'x$$y$$ and 1$$2$$3'];
  for (let i = 0; i < 20000; i++) docs.push(Array.from({ length: 1 + random(30) }, () => pieces[random(pieces.length)]).join(''));
  // The same tokens, except where texmath let a displayed formula that started in a quote run on past it.
  const formulaInQuote = (doc) => {
    let depth = 0;
    return old.parse(doc, {}).some((t) => {
      depth += t.type === 'blockquote_open' ? 1 : t.type === 'blockquote_close' ? -1 : 0;
      return depth > 0 && t.type.startsWith('math_block');
    });
  };
  // Or where texmath dropped the text after a displayed formula's closing delimiter (#52): its last line
  // doesn't end in one, or in an equation number.
  const lines = (doc) => doc.split(/\r\n?|\n/);
  const closers = { '$$': '$$', '\\[': '\\]' };
  const textDropped = (doc) =>
    old.parse(doc, {}).some((t) => {
      if (!t.type.startsWith('math_block') || !t.map) return false;
      const line = lines(doc)[t.map[1] - 1] ?? '';
      const closer = closers[t.tag] ?? `\\end{${t.info}}`;
      const rest = line.slice(line.lastIndexOf(closer) + closer.length).trim();
      return rest !== '' && !/^\([^()]*\)$/.test(rest);
    });
  const differ = docs.filter((doc) => JSON.stringify(shape(old.parse(doc, {}))) !== JSON.stringify(shape(now.parse(doc, {}))));
  assert.deepEqual(differ.filter((doc) => !formulaInQuote(doc) && !textDropped(doc)), []);
  assert.ok(docs.length - differ.length > 19000, `${differ.length} of ${docs.length} differ`);
});

test('text after a displayed formula on its line stays in the output (#52)', async () => {
  const { default: katex } = await import('katex');
  const md = createRenderer({ hljs, math: { katex } });
  const words = (markdown) => md.render(markdown).replace(/<[^>]*>/g, ' ');
  for (const markdown of ['$$a$$$$b$$ and more text', '$$a$$ and more text', '\\[a\\] and more text', '\\begin{a}x\\end{a} and more text']) {
    assert.match(words(markdown), /and more text/, markdown);
  }
  // In a quote, after a formula that spans lines.
  assert.match(words('> $$\n> a\n> $$ and more text'), /and more text/);
  // A formula over several lines stays a block, in a quote or list or with a list-like line inside, and the
  // text after it follows as a paragraph.
  assert.match(md.render('$$\n- a\n$$ text\n'), /^<section><eqn>[^]*<\/section><p>text<\/p>\n$/);
  assert.match(md.render('$$\na\n\nb\n$$ text\n'), /^<section><eqn>[^]*<\/section><p>text<\/p>\n$/);
  assert.match(md.render('> $$\n> a\n> $$\n'), /^<blockquote>\n<section><eqn>/);
  assert.match(md.render('- $$\n  a\n  $$\n'), /<li>\n?<section><eqn>/);
  // Short tails, one ending in a backslash.
  assert.match(words('$$a$$ x'), / x\s*$/);
  assert.match(words('$$a$$ \\'), /\\\s*$/);
  // A formula alone on its line, or followed by an equation number, is still a displayed block.
  assert.match(md.render('$$a$$\n'), /^<section><eqn>/);
  assert.match(md.render('$$a$$ (1)\n'), /^<section class="eqno">/);
  assert.match(md.render('$$a$$   \n'), /^<section><eqn>/);
});

test('callouts, inline footnotes and nested formulas stay in proportion and fast (#51, #53)', async () => {
  const { default: katex } = await import('katex');
  const md = createRenderer({ hljs, html: false, idPrefix: 'doc-', math: { katex } });
  const count = (html, text) => html.split(text).length - 1;

  // An icon is about 1 KB, so only the first 200 callouts draw one; the rest keep an empty svg.
  const callouts = '>[!tip]\n\n'.repeat(20000);
  const c = md.render(callouts);
  assert.ok(c.length < callouts.length * 30, `${c.length / callouts.length}x`);
  assert.equal(count(c, '<path'), 200);
  assert.equal(count(c, '<svg class="octicon"'), 20000);
  // The count starts again with each render.
  assert.equal(count(md.render('>[!tip]\n\n'), '<path'), 1);

  // The first 1,000 inline footnotes are footnotes and the rest stay text.
  const n = md.render('^[a] '.repeat(3000));
  assert.equal(count(n, 'class="footnote-item"'), 1000);
  assert.equal(count(n, '^[a]'), 2000);
  assert.ok(md.render('^[]'.repeat(100000)).length < 100000 * 3 * 10);

  // 100 levels nest, 101 don't, in a displayed and an inline formula.
  const braces = (depth) => `${'{'.repeat(depth)}x${'}'.repeat(depth)}`;
  for (const [open, close] of [['$$', '$$'], ['$', '$']]) {
    assert.doesNotMatch(md.render(`${open}${braces(100)}${close}`), /katex-error/);
    assert.match(md.render(`${open}${braces(101)}${close}`), /nested over 100 levels deep/);
  }
  // Formulas nested past 100 levels are refused before KaTeX runs; ordinary nesting renders.
  const nested = (depth) => `$$${'\\frac{'.repeat(depth)}x${'}{y}'.repeat(depth)}$$\n\n`;
  const start = performance.now();
  const deep = md.render(nested(700).repeat(1000));
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${ms} ms`);
  assert.equal(count(deep, 'katex-error'), 1000);
  assert.match(deep, /nested over 100 levels deep/);
  assert.match(md.render(nested(50)), /class="katex-html"/);
  assert.doesNotMatch(md.render(nested(50)), /katex-error/);
  // A brace after a backslash isn't a level.
  assert.doesNotMatch(md.render(`$$${'\\{'.repeat(300)}x${'\\}'.repeat(300)}$$`), /nested over/);
});

// A fenced code block in `lang`.
const fence = (lang, code) => `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;

test('highlightBudget limits the time each render spends highlighting', () => {
  const js = 'let a = 1; // one\nconst b = "two";\n'.repeat(600);
  const whole = createRenderer({ hljs }).render(fence('js', js));
  // Under a budget, a block over 4 KB is highlighted in pieces that join up to the same HTML.
  assert.ok(js.length > 4 * 4096);
  assert.equal(createRenderer({ hljs, highlightBudget: 1e9 }).render(fence('js', js)), whole);
  // A piece without a line break in it ends before 4096 characters rather than inside a surrogate pair,
  // which would leave a half in each of two string spans.
  const emoji = `x = "${'a'.repeat(4090)}\u{1F600}bbb";`;
  assert.doesNotMatch(createRenderer({ hljs, highlightBudget: 1e9 }).render(fence('js', emoji)),
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);

  // Out of budget, code is escaped without colour.
  assert.equal(createRenderer({ hljs, highlightBudget: 0 }).render(fence('js', 'a < "b"')),
    '<pre><code class="hljs language-js">a &lt; &quot;b&quot;</code></pre>\n');
  // html: false sets a budget: the end of a long, slow block is left without colour.
  const slow = createRenderer({ hljs, html: false }).render(fence('ini', `${'a'.repeat(65536)}\nend = 1`));
  assert.ok(slow.endsWith('\nend = 1</code></pre>\n'), 'the end of the block is highlighted');
  // Each render has the whole budget.
  const md = createRenderer({ hljs, highlightBudget: 50 });
  md.render(fence('ini', 'a'.repeat(65536)));
  assert.match(md.render(fence('js', 'let a')), /<span class="hljs-keyword">let<\/span>/);

  for (const bad of [-1, '100', NaN, null]) {
    assert.throws(() => createRenderer({ hljs, highlightBudget: bad }), TypeError, String(bad));
  }
});

test('adversarial Markdown renders in about the time markdown-it takes', async () => {
  const md = createRenderer({ hljs, html: false });
  const withMath = await untrustedRenderer();
  const base = new MarkdownIt();
  const elapsed = (f) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  // Each took seconds or more before #32, most growing with the square of the length.
  const cases = {
    'identical headings': ['# a\n'.repeat(15000), md],
    'unclosed wikilinks': ['[[a]'.repeat(50000), md],
    'callouts': ['> [!note]\n\n'.repeat(40000), md],
    'a long callout marker': [`> [!note]${' '.repeat(80000)}${String.fromCharCode(0x2028)}x`, md],
    'footnotes': [`${Array.from({ length: 20000 }, (_, i) => `x[^${i}]`).join('\n')}\n\n${Array.from({ length: 20000 }, (_, i) => `[^${i}]: n`).join('\n\n')}`, md],
    'unclosed footnote references': [`x[^1] ${'[^'.repeat(60000)}\n\n[^1]: x\n`, md],
    'a task list': ['- [ ] x\n'.repeat(25000), md],
    'inline $ openers': [' $x'.repeat(40000), withMath],
    '\\( openers': ['\\('.repeat(80000), withMath],
    'unclosed environments': ['\\begin{a}\n\n'.repeat(40000), withMath],
    'quoted formulas closed after the quotes': [`${'> \\[x\n\n'.repeat(2000)}\\]`, withMath],
    'quoted list formulas closed after the quotes': [`${'> - \\begin{a}\n\n'.repeat(2000)}\\end{a}`, withMath],
    // Highlighting, which took seconds before #47.
    'ini code': [fence('ini', 'a'.repeat(65536)), md],
    'many ini blocks': [fence('ini', 'a'.repeat(1024)).repeat(400), md],
    'livescript code': [fence('livescript', '$'.repeat(65536)), md],
    'C# code in short lines': [fence('csharp', `${'a '.repeat(60)}\n`.repeat(540)), md],
  };
  const slow = [];
  for (const [name, [src, renderer]] of Object.entries(cases)) {
    const limit = 4 * elapsed(() => base.render(src)) + 500;
    const took = elapsed(() => renderer.render(src));
    if (took >= limit) slow.push(`${name}: ${Math.round(took)} ms, limit ${Math.round(limit)} ms`);
  }
  const took = elapsed(() => titleOf(`---\ntitle: a${' '.repeat(50000)}b\n---\n`, 'stem'));
  if (took >= 500) slow.push(`titleOf: ${Math.round(took)} ms`);
  assert.deepEqual(slow, []);
});

test('a formula can\'t draw outside an element that clips with contain: paint', async () => {
  const md = await untrustedRenderer();
  // Each reaches past the element's edge: left with a negative \kern, right, and a capped \rule. (A
  // raised box makes its line taller instead.)
  const formulas = md.render('$\\mathllap{\\kern{-10em}\\text{LEFT}}$\n\n$\\kern{25em}\\text{RIGHT}$\n\n$\\rule{100000em}{1em}$');
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const html = join(dir, 'clip.html');
    writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(require.resolve('katex/dist/katex.min.css')).href}">
<style>body { margin: 0; } article { position: absolute; left: 200px; top: 300px; width: 400px; height: 450px; }</style>
</head><body><article class="markdown-body">${formulas}</article><script>
  // For each formula, the points outside the article where it's drawn.
  function hits() {
    const box = document.querySelector('article').getBoundingClientRect();
    const all = [...document.querySelectorAll('.katex')];
    const n = all.map(() => 0);
    for (let x = 4; x < innerWidth; x += 8) for (let y = 4; y < innerHeight; y += 8) {
      if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) continue;
      const formula = document.elementFromPoint(x, y)?.closest('.katex');
      if (formula) n[all.indexOf(formula)]++;
    }
    return n;
  }
  const unclipped = hits();
  document.querySelector('article').style.contain = 'paint';
  window.probeOut = { unclipped, clipped: hits() };
</script></body></html>`);
    const { unclipped, clipped } = probeInChrome(html, dir);
    // Without the clip each formula reaches outside, so the check can see it.
    assert.equal(unclipped.length, 3);
    assert.ok(unclipped.every((n) => n > 0), `unclipped: ${unclipped}`);
    assert.deepEqual(clipped, [0, 0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a callout marker line with a line separator stays a quote, as before', () => {
  assert.match(render(`> [!note] Title${String.fromCharCode(0x2028)}more\n> body`), /^<blockquote>/);
});

test('titleOf skips an empty title: line', () => {
  assert.equal(titleOf('---\ntitle:\ntitle: Foo\n---\nNo heading', 'stem'), 'Foo');
});

test('Markdown rendered as the README says gives the page no script, foreign ids or unsafe links', async () => {
  const md = await untrustedRenderer();
  await poisonHostPlugins();
  const attacks = [
    '- [ ] <img src=x onerror=alert(1)>',
    '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a> <form><input name=y></form>',
    '[x](javascript:alert(1)) ![x](javascript:alert(1)) <javascript:alert(1)> [d](data:text/html,x) [v](vbscript:x)',
    '# config\n\n# name\n\n# location\n\nx[^1] ^[inline [y](#config)]\n\n[^1]: n',
    '> [!__proto__]\n> x\n\n> [!note]" onmouseover="x\n> y',
    '[[#<b>]] ![[a.png|1" onerror="x]] ![[x" onerror=".png]] ![[javascript:alert(1).png]]',
    '```"onx=1 name=z\ncode\n```',
    '$\\href{javascript:alert(1)}{x}$ $\\htmlId{x}{y}$ $\\includegraphics{x.png}$ $\\url{javascript:x}$ $$\\def\\a{b}\\a$$ $\\htmlStyle{color:red}{s}$',
    '[top](#) [same](#config) :smile: | a |\n|---|\n| b |',
  ].map((doc) => md.render(doc)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  try {
    const html = join(dir, 'attacks.html');
    writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><article class="markdown-body"></article><script>
  const article = document.querySelector('article');
  article.innerHTML = ${JSON.stringify(attacks).replace(/</g, '\\u003c')};
  const TAGS = new Set(['A', 'BLOCKQUOTE', 'CODE', 'DIV', 'EM', 'EQ', 'EQN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'IMG', 'INPUT', 'LABEL', 'LI', 'OL', 'P', 'PATH', 'PRE', 'SECTION', 'SPAN', 'STRONG', 'SUP', 'SVG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
  const problems = [];
  for (const el of article.querySelectorAll('*')) {
    const tag = el.tagName.toUpperCase();
    if (!TAGS.has(tag)) problems.push('element ' + tag);
    for (const { name, value } of el.attributes) {
      if (/^on/i.test(name) || ['name', 'formaction', 'srcdoc'].includes(name)) problems.push(tag + ' ' + name);
      if (name === 'id' && !value.startsWith('doc-')) problems.push('id ' + value);
      if (name === 'style' && !el.closest('.katex, .katex-error')) problems.push('style on ' + tag);
      if (name === 'href' && !/^(#$|#doc-|https?:|mailto:)/.test(value)) problems.push('href ' + value);
      if (name === 'src' && /^\\s*(javascript|data|vbscript):/i.test(value)) problems.push('src ' + value);
    }
    if (tag === 'INPUT' && !(el.type === 'checkbox' && el.disabled)) problems.push('input ' + el.outerHTML);
  }
  window.probeOut = { problems, elements: article.querySelectorAll('*').length, globals: ['config', 'name', 'location'].filter((k) => window[k] instanceof Element) };
</script></body></html>`);
    const { problems, elements, globals } = probeInChrome(html, dir);
    assert.ok(elements > 50, `rendered ${elements} elements`);
    assert.deepEqual(problems, []);
    assert.deepEqual(globals, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cssString escapes what would end the string or the <style> element', () => {
  assert.equal(cssString('plain'), '"plain"');
  assert.equal(cssString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
  assert.equal(cssString('a</style>b'), '"a\\3c /style>b"');
  assert.equal(cssString('one\ntwo\rthree'), '"one\\a two\\d three"');
});

test('--list-styles marks github as the default when no config exists', () => {
  rmSync(CONFIG, { force: true });
  const r = run('--list-styles');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\* github$/m);
  for (const style of STYLE_NAMES.filter((s) => s !== 'github')) {
    assert.match(r.stdout, new RegExp(`^  ${style}$`, 'm'));
  }
});

test('--set-style changes the default used for conversions', () => {
  rmSync(CONFIG, { force: true });
  assert.equal(run('--set-style', 'classic').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), { style: 'classic' });
  assert.match(run('--list-styles').stdout, /^\* classic$/m);

  const dir = workspace();
  run('--html', join(dir, 'sample.md'));
  assert.match(readFileSync(join(dir, 'sample.html'), 'utf8'), /Iowan Old Style/);

  // An explicit -s still wins over the default.
  run('--html', '-s', 'github', join(dir, 'sample.md'));
  assert.doesNotMatch(readFileSync(join(dir, 'sample.html'), 'utf8'), /Iowan Old Style/);
  rmSync(CONFIG, { force: true });
});

test('--set-style rejects an unknown style and leaves the config alone', () => {
  rmSync(CONFIG, { force: true });
  const r = run('--set-style', 'bogus');
  assert.equal(r.status, 2);
  assert.ok(!existsSync(CONFIG));
});
