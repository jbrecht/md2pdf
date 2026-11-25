#!/usr/bin/env node
// md2pdf: convert Markdown files to PDF using headless Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import hljs from 'highlight.js';
import { buildDocument, createRenderer, titleOf } from '../lib/render.js';
import { fitFormulas } from '../lib/fit.js';
import { rewriteUrls } from '../lib/css.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Each style is a list of CSS files inlined into the page, in order: its on-screen styles, then its
// print rules. To add a style, add both files, register it here and add its page margin to lib/styles.js;
// set-style.sh picks it up.
const styleFiles = (name, ...before) => [...before, join(ROOT, 'styles', `${name}.css`), join(ROOT, 'styles', 'print', `${name}.css`)];
const STYLES = {
  github: styleFiles('github', require.resolve('github-markdown-css/github-markdown-light.css')),
  classic: styleFiles('classic'),
  academic: styleFiles('academic'),
  modern: styleFiles('modern'),
  report: styleFiles('report'),
  resume: styleFiles('resume'),
  worksheet: styleFiles('worksheet'),
  gothic: styleFiles('gothic'),
  sandwake: styleFiles('sandwake'),
  elvish: styleFiles('elvish'),
  cyberpunk: styleFiles('cyberpunk'),
};
const FALLBACK_STYLE = 'github';
// Not STYLES[name], which is truthy for names every object inherits, such as toString.
const isStyle = (name) => typeof name === 'string' && Object.hasOwn(STYLES, name);
// The @page sizes md2pdf takes: auto, a paper name, an orientation or both, or one or two lengths. Chrome
// prints a size it can't read at Letter without a word. It also reads calc() and newer units, which
// aren't taken here.
const PAPER = ['a5', 'a4', 'a3', 'b5', 'b4', 'jis-b5', 'jis-b4', 'letter', 'legal', 'ledger'];
const ORIENTATION = ['portrait', 'landscape'];
const LENGTH = /^\+?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:in|cm|mm|q|pt|pc|px|em|rem|ex|ch|vw|vh|vmin|vmax)$/;
function isPageSize(size) {
  const words = size.trim().toLowerCase().split(/\s+/);
  if (words.length > 2) return false;
  if (words.every((w) => LENGTH.test(w)) || size.trim().toLowerCase() === 'auto') return true;
  const count = (list) => words.filter((w) => list.includes(w)).length;
  return count(PAPER) <= 1 && count(ORIENTATION) <= 1 && count(PAPER) + count(ORIENTATION) === words.length;
}
// A checkout installed before KaTeX was a dependency has none until install.sh runs again; it still converts.
const katex = await import('katex').then(
  (m) => m.default,
  (err) => {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  },
);
// Added after the style only when the document has a formula, so a document without math prints as before.
// The rules after KaTeX's keep a displayed formula on one page and put a $$ … $$ (1) equation number at the
// right margin, as md2pdf.me does.
const MATH_CSS = katex && require.resolve('katex/dist/katex.min.css');
const EQUATION_NUMBERS = `
.markdown-body eqn { display: block; break-inside: avoid; }
.markdown-body section.eqno { display: flex; align-items: center; }
.markdown-body section.eqno > eqn { flex: 1; margin-left: 3em; }
.markdown-body section.eqno > span { width: 3em; text-align: right; }`;

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
  -p, --page-size <size> Letter, A4, Legal, "A4 landscape", "5in 8in", ... (default: Letter)
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
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('not a JSON object');
    return config;
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

// A stylesheet's text, with its relative url()s (a style's bundled fonts, say) made absolute: inlined
// into the page, they would otherwise resolve against the Markdown file's folder. Warns once about each
// file they name that doesn't exist.
const warned = new Set();
function readCss(file) {
  return rewriteUrls(readFileSync(file, 'utf8'), (ref) => {
    const url = new URL(ref, pathToFileURL(file));
    let missing = false;
    try {
      missing = !existsSync(fileURLToPath(url));
    } catch {
      // Not a path this system can name, such as one with an encoded slash; let Chrome try it.
    }
    const warning = `md2pdf: ${file}: no such file: ${ref}`;
    if (missing && !warned.has(warning)) {
      warned.add(warning);
      console.error(warning);
    }
    return url.href;
  });
}

function buildHtml({ markdown, title, baseDir, style, extraCss, pageSize }) {
  const bodyHtml = createRenderer({ hljs, ...(katex && { math: { katex } }) }).render(markdown);
  const math = /<eqn?>/.test(bodyHtml) ? [readCss(MATH_CSS) + EQUATION_NUMBERS] : [];
  const css = [...STYLES[style].map(readCss), ...math, ...(extraCss ? [readCss(extraCss)] : [])].join('\n');
  return buildDocument({
    bodyHtml,
    title,
    css,
    pageSize,
    // <base> makes relative image/link paths resolve against the Markdown file's folder.
    // Chrome loads a font used only in a page header or footer too late for the PDF, so start every
    // declared font loading now; the PDF waits for those loads with the rest of the page.
    head: `<base href="${pathToFileURL(baseDir + '/').href}">
<script>document.addEventListener('DOMContentLoaded', () => document.fonts.forEach((f) => f.load().catch(() => {})));</script>${
      // A displayed formula wider than the column shrinks to fit, once its fonts have loaded. It fits
      // whatever column it ends up in, so the printed page needs no second run.
      /<eqn>/.test(bodyHtml)
        ? `
<script>${fitFormulas}
addEventListener('load', () => document.fonts.ready.then(() => fitFormulas()));</script>`
        : ''
    }`,
  });
}

// The temp folders that exist right now, and the Chrome printing, so an interrupt can clean up.
const tempDirs = new Set();
let chromeProc = null;

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  tempDirs.delete(dir);
}

// On an interrupt, stop Chrome, wait for it to let go of its profile, remove the temp folders, then
// die of the same signal so the shell sees it. Chrome gets SIGKILL: a Control + C reaches it too, and
// headless Chrome that has had a SIGINT hangs and ignores SIGTERM, outliving md2pdf.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    const die = () => {
      for (const dir of tempDirs) {
        try {
          removeTempDir(dir);
        } catch {
          // Leave a folder that can't be removed rather than miss the others or the signal.
        }
      }
      process.kill(process.pid, signal);
    };
    if (!chromeProc) return die();
    chromeProc.once('close', die);
    chromeProc.kill('SIGKILL');
    setTimeout(die, 5000).unref();
  });
}

function runChrome(chrome, htmlPath, pdfPath) {
  // A throwaway profile keeps headless Chrome separate from any Chrome you have open.
  const profile = makeTempDir('md2pdf-chrome-');
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
    const proc = (chromeProc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    // A Chrome that fails to start emits 'error' first, and main() may exit before its 'close' arrives.
    proc.on('error', (err) => {
      if (chromeProc === proc) chromeProc = null;
      removeTempDir(profile);
      reject(err);
    });
    proc.on('close', (code) => {
      if (chromeProc === proc) chromeProc = null;
      removeTempDir(profile);
      if (code === 0 && existsSync(pdfPath)) resolvePromise();
      else reject(new Error(`Chrome failed (exit ${code}):\n${stderr.trim()}`));
    });
  });
}

// A file's identity, whatever name reaches it: names can differ by case, a symlink or a hard link.
const fileId = (stat) => `${stat.dev}:${stat.ino}`;

// `written` maps each PDF this run has written, by fileId, to the input it came from.
async function convert(input, opts, chrome, written) {
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) throw new Error(`No such file: ${input}`);
  const stem = basename(inputPath, extname(inputPath));
  const pdfPath = resolve(opts.output ?? join(dirname(inputPath), `${stem}.pdf`));
  const target = statSync(pdfPath, { throwIfNoEntry: false });
  if (target && fileId(target) === fileId(statSync(inputPath))) {
    throw new Error('The PDF would replace the file it is made from; give another path with --output');
  }
  if (target && written.has(fileId(target))) {
    throw new Error(`${pdfPath} was already written from ${written.get(fileId(target))}; convert it alone with --output`);
  }
  if (!existsSync(dirname(pdfPath))) throw new Error(`No such folder: ${dirname(pdfPath)}`);
  const markdown = readFileSync(inputPath, 'utf8');
  const title = titleOf(markdown, stem);

  const html = buildHtml({
    markdown,
    title,
    baseDir: dirname(inputPath),
    style: opts.style,
    extraCss: opts.css && resolve(opts.css),
    pageSize: opts['page-size'],
  });

  const workDir = makeTempDir('md2pdf-');
  try {
    const htmlPath = join(workDir, `${stem}.html`);
    writeFileSync(htmlPath, html);
    if (opts.html) writeFileSync(pdfPath.replace(/\.pdf$/i, '') + '.html', html);
    // Chrome prints into the temp folder: printing over a PDF it can't replace, it reports success.
    const printed = join(workDir, 'print.pdf');
    await runChrome(chrome, htmlPath, printed);
    try {
      writeFileSync(pdfPath, readFileSync(printed));
    } catch (err) {
      throw new Error(`Could not write ${pdfPath}: ${err.message.split(',')[0]}`);
    }
  } finally {
    removeTempDir(workDir);
  }
  written.set(fileId(statSync(pdfPath)), input);
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
  const defaultStyle = isStyle(config.style) ? config.style : FALLBACK_STYLE;

  if (opts['set-style'] !== undefined) {
    if (!isStyle(opts['set-style'])) unknownStyle(opts['set-style']);
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
  if (config.style && !isStyle(config.style)) {
    console.error(`md2pdf: config style "${config.style}" no longer exists; using ${FALLBACK_STYLE}`);
  }
  opts.style ??= defaultStyle;
  if (!isStyle(opts.style)) unknownStyle(opts.style);
  if (!isPageSize(opts['page-size'])) {
    console.error(`md2pdf: unknown page size "${opts['page-size']}". Use one of ${PAPER.join(', ')}, alone or with "landscape", or a width and height such as "5in 8in"`);
    process.exit(2);
  }
  if (opts.output && files.length > 1) {
    console.error('md2pdf: --output can only be used with a single input file');
    process.exit(2);
  }

  const chrome = findChrome();
  if (!katex) console.error(`md2pdf: KaTeX isn't installed, so formulas print as their source; run ${join(ROOT, 'install.sh')} again`);
  let failed = 0;
  const written = new Map();
  for (const file of files) {
    try {
      const pdf = await convert(file, opts, chrome, written);
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
