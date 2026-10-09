#!/usr/bin/env node
// md2pdf: convert Markdown files to PDF using headless Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { full as emoji } from 'markdown-it-emoji';
import hljs from 'highlight.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Each style is a list of CSS files inlined into the page, in order.
// To add a style, drop a CSS file in styles/ and register it here.
const STYLES = {
  github: [
    require.resolve('github-markdown-css/github-markdown-light.css'),
    require.resolve('highlight.js/styles/github.css'),
    join(ROOT, 'styles', 'github.css'),
  ],
};

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const USAGE = `Usage: md2pdf [options] <file.md>...

Converts each Markdown file to a PDF saved next to it.

Options:
  -o, --output <file>    Output path (only with a single input file)
  -s, --style <name>     Style to use (${Object.keys(STYLES).join(', ')}; default: github)
      --css <file>       Extra CSS file applied after the style
  -p, --page-size <size> Letter, A4, Legal, ... (default: Letter)
      --open             Open the PDF when done
      --html             Also write the intermediate .html (for debugging styles)
  -h, --help             Show this help

Environment:
  CHROME_PATH            Path to a Chrome/Chromium binary to use`;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('Could not find Chrome. Install Google Chrome or set CHROME_PATH.');
  return found;
}

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function createRenderer() {
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

function buildHtml({ markdown, title, baseDir, style, extraCss, pageSize }) {
  const css = [...STYLES[style], ...(extraCss ? [extraCss] : [])]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const body = createRenderer().render(markdown);
  // <base> makes relative image/link paths resolve against the Markdown file's folder.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="${pathToFileURL(baseDir + '/').href}">
<style>
${css}
@page { size: ${pageSize}; }
</style>
</head>
<body>
<article class="markdown-body">
${body}
</article>
</body>
</html>`;
}

function runChrome(chrome, htmlPath, pdfPath) {
  // A throwaway profile keeps headless Chrome separate from any Chrome you have open.
  const profile = mkdtempSync(join(tmpdir(), 'md2pdf-chrome-'));
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    '--virtual-time-budget=10000',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      rmSync(profile, { recursive: true, force: true });
      if (code === 0 && existsSync(pdfPath)) resolvePromise();
      else reject(new Error(`Chrome failed (exit ${code}):\n${stderr.trim()}`));
    });
  });
}

async function convert(input, opts, chrome) {
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) throw new Error(`No such file: ${input}`);
  const markdown = readFileSync(inputPath, 'utf8');
  const stem = basename(inputPath, extname(inputPath));
  const pdfPath = resolve(opts.output ?? join(dirname(inputPath), `${stem}.pdf`));
  const title = markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? stem;

  const html = buildHtml({
    markdown,
    title,
    baseDir: dirname(inputPath),
    style: opts.style,
    extraCss: opts.css && resolve(opts.css),
    pageSize: opts['page-size'],
  });

  const workDir = mkdtempSync(join(tmpdir(), 'md2pdf-'));
  try {
    const htmlPath = join(workDir, `${stem}.html`);
    writeFileSync(htmlPath, html);
    if (opts.html) writeFileSync(pdfPath.replace(/\.pdf$/i, '') + '.html', html);
    await runChrome(chrome, htmlPath, pdfPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return pdfPath;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        style: { type: 'string', short: 's', default: 'github' },
        css: { type: 'string' },
        'page-size': { type: 'string', short: 'p', default: 'Letter' },
        open: { type: 'boolean' },
        html: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`md2pdf: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values: opts, positionals: files } = parsed;

  if (opts.help || files.length === 0) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  if (!STYLES[opts.style]) {
    console.error(`md2pdf: unknown style "${opts.style}". Available: ${Object.keys(STYLES).join(', ')}`);
    process.exit(2);
  }
  if (opts.output && files.length > 1) {
    console.error('md2pdf: --output can only be used with a single input file');
    process.exit(2);
  }

  const chrome = findChrome();
  let failed = 0;
  for (const file of files) {
    try {
      const pdf = await convert(file, opts, chrome);
      console.log(pdf);
      if (opts.open) spawn('open', [pdf], { stdio: 'ignore', detached: true }).unref();
    } catch (err) {
      failed++;
      console.error(`md2pdf: ${file}: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
