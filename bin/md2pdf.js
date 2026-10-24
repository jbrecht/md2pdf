#!/usr/bin/env node
// md2pdf: convert Markdown files to PDF using headless Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import hljs from 'highlight.js';
import { buildDocument, createRenderer, titleOf } from '../lib/render.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Each style is a list of CSS files inlined into the page, in order.
// To add a style, drop a CSS file in styles/ and register it here; set-style.sh picks it up.
const STYLES = {
  github: [
    require.resolve('github-markdown-css/github-markdown-light.css'),
    require.resolve('highlight.js/styles/github.css'),
    join(ROOT, 'styles', 'github.css'),
  ],
  classic: [join(ROOT, 'styles', 'classic.css')],
  academic: [join(ROOT, 'styles', 'academic.css')],
  modern: [join(ROOT, 'styles', 'modern.css')],
  report: [join(ROOT, 'styles', 'report.css')],
  resume: [join(ROOT, 'styles', 'resume.css')],
};
const FALLBACK_STYLE = 'github';

// Settings shared by the CLI, Finder Quick Action and keyboard shortcut.
const CONFIG_PATH =
  process.env.MD2PDF_CONFIG ??
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'md2pdf', 'config.json');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const usage = (defaultStyle) => `Usage: md2pdf [options] <file.md>...
       md2pdf --set-style <name>
       md2pdf --list-styles

Converts each Markdown file to a PDF saved next to it.

Options:
  -o, --output <file>    Output path (only with a single input file)
  -s, --style <name>     Style to use (${Object.keys(STYLES).join(', ')}; default: ${defaultStyle})
      --css <file>       Extra CSS file applied after the style
  -p, --page-size <size> Letter, A4, Legal, ... (default: Letter)
      --open             Open the PDF when done
      --html             Also write the intermediate .html (for debugging styles)
      --set-style <name> Make <name> the default style (also used by the Finder Quick Action)
      --list-styles      List styles, marking the default
  -h, --help             Show this help

Environment:
  CHROME_PATH            Path to a Chrome/Chromium binary to use
  MD2PDF_CONFIG          Config file (default: ${CONFIG_PATH})`;

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`md2pdf: ignoring unreadable config ${CONFIG_PATH}: ${err.message}`);
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function unknownStyle(name) {
  console.error(`md2pdf: unknown style "${name}". Available: ${Object.keys(STYLES).join(', ')}`);
  process.exit(2);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('Could not find Chrome. Install Google Chrome or set CHROME_PATH.');
  return found;
}

function buildHtml({ markdown, title, baseDir, style, extraCss, pageSize }) {
  const css = [...STYLES[style], ...(extraCss ? [extraCss] : [])]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  return buildDocument({
    bodyHtml: createRenderer({ hljs }).render(markdown),
    title,
    css,
    pageSize,
    // <base> makes relative image/link paths resolve against the Markdown file's folder.
    head: `<base href="${pathToFileURL(baseDir + '/').href}">`,
  });
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
  const title = titleOf(markdown, stem);

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
        style: { type: 'string', short: 's' },
        css: { type: 'string' },
        'page-size': { type: 'string', short: 'p', default: 'Letter' },
        open: { type: 'boolean' },
        html: { type: 'boolean' },
        'set-style': { type: 'string' },
        'list-styles': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`md2pdf: ${err.message}\n\nRun md2pdf --help for usage.`);
    process.exit(2);
  }
  const { values: opts, positionals: files } = parsed;
  const config = readConfig();
  const defaultStyle = STYLES[config.style] ? config.style : FALLBACK_STYLE;

  if (opts['set-style'] !== undefined) {
    if (!STYLES[opts['set-style']]) unknownStyle(opts['set-style']);
    writeConfig({ ...config, style: opts['set-style'] });
    console.log(`Default style is now "${opts['set-style']}".`);
    process.exit(0);
  }
  if (opts['list-styles']) {
    for (const name of Object.keys(STYLES)) console.log(`${name === defaultStyle ? '*' : ' '} ${name}`);
    process.exit(0);
  }
  if (opts.help || files.length === 0) {
    console.log(usage(defaultStyle));
    process.exit(opts.help ? 0 : 2);
  }
  if (config.style && !STYLES[config.style]) {
    console.error(`md2pdf: config style "${config.style}" no longer exists; using ${FALLBACK_STYLE}`);
  }
  opts.style ??= defaultStyle;
  if (!STYLES[opts.style]) unknownStyle(opts.style);
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
