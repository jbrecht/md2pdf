// End-to-end tests: run the real CLI against fixtures and inspect the PDFs.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import hljs from 'highlight.js';
import { buildDocument, createRenderer, cssString, headingText, titleOf } from '../lib/render.js';
import { pageMargins } from '../lib/styles.js';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'md2pdf.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');

// Point every run at a throwaway config so tests never touch the real default style.
const CONFIG = join(mkdtempSync(join(tmpdir(), 'md2pdf-config-')), 'config.json');
process.env.MD2PDF_CONFIG = CONFIG;

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const pageCount = (pdf) => readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

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

const STYLE_NAMES = ['github', 'classic', 'academic', 'modern', 'report', 'resume'];

// The CSS a page loads to show a style on screen, without its print rules.
const screenCss = (style) =>
  [...(style === 'github' ? [require.resolve('github-markdown-css/github-markdown-light.css')] : []), join(ROOT, 'styles', `${style}.css`)]
    .map((f) => readFileSync(f, 'utf8'))
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

test('titleOf skips front matter and falls back to its title field', () => {
  assert.equal(titleOf('---\ntitle: From YAML\n---\n# From heading', 'stem'), 'From heading');
  assert.equal(titleOf('---\ntitle: From YAML\n---\nNo heading', 'stem'), 'From YAML');
  assert.equal(titleOf('---\n# a YAML comment\ntitle: From YAML\n---\nNo heading', 'stem'), 'From YAML');
  assert.equal(titleOf('---\ntitle: "Quoted: title"\n---\n', 'stem'), 'Quoted: title');
  assert.equal(titleOf("---\nsubtitle: x\ntitle: 'Single'\n---\n", 'stem'), 'Single');
  assert.equal(titleOf('---\ntags: [a]\n---\nNothing', 'stem'), 'stem');
  assert.equal(titleOf('title: Not front matter\n', 'stem'), 'stem');
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
      else global.push(rule.cssText.slice(0, 80));
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
  window.probeOut = { code: color('pre code'), keyword: color('.hljs-keyword'), string: color('.hljs-string'), comment: color('.hljs-comment') };
</script></body></html>`);
      const c = probeInChrome(join(dir, 'hl.html'), dir);
      for (const token of ['keyword', 'string', 'comment']) assert.notEqual(c[token], c.code, `${token} has the plain code color`);
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
  assert.ok(seen.size >= 3 && libImports.length >= 5, 'found the renderer imports');
  for (const name of libImports) assert.ok(imports[name], `import map lacks ${name}`);

  const urls = [...Object.values(imports), ...[...page.matchAll(/<link [^>]*href="(https:[^"]+)"/g)].map((m) => m[1])];
  assert.equal(urls.length, 7);
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
  for (const style of ['classic', 'academic', 'modern', 'report', 'resume']) {
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
