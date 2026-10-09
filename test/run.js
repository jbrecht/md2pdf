// End-to-end tests: run the real CLI against fixtures and inspect the PDFs.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'md2pdf.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');

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
