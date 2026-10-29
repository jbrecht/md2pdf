// End-to-end tests: run the real CLI against fixtures and inspect the PDFs.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument, createRenderer, cssString, headingText } from '../lib/render.js';

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

for (const style of ['github', 'classic', 'academic', 'modern', 'report', 'resume']) {
  test(`${style} style gives each callout family its own look`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
    copyFileSync(join(FIXTURES, 'callouts.md'), join(dir, 'callouts.md'));
    const r = run('-s', style, '--html', join(dir, 'callouts.md'));
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(dir, 'callouts.html'), 'utf8');
    // Each family's color: GitHub's border-left-color, or the --callout variable our styles define.
    const colorOf = (family) =>
      html.match(new RegExp(`\\.markdown-alert(?:\\.markdown-alert)?-${family} \\{\\s*(?:--callout|border-left-color): ([^;]+);`))?.[1] ??
      (family === 'note' ? html.match(/\.markdown-alert \{\s*--callout: ([^;]+);/)?.[1] : undefined);
    const colors = ['note', 'tip', 'important', 'warning', 'caution', 'quote'].map(colorOf);
    assert.ok(colors.every(Boolean), `missing a family color: ${colors}`);
    assert.equal(new Set(colors).size, 6, `families share a color: ${colors}`);
    if (style !== 'github') assert.match(html, /\.markdown-alert-title \{[^}]*color: var\(--callout\);/);
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
