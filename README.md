# md2pdf

Convert Markdown to beautifully styled PDFs. This is the rendering engine and macOS command-line tool behind **[md2pdf.me](https://md2pdf.me)**, the free online converter.

- **Just want a PDF?** Use [md2pdf.me](https://md2pdf.me): nothing to install, and your text never leaves your browser.
- **On a Mac and comfortable with a terminal?** Install the command-line tool below. It adds a Finder right-click action and a keyboard shortcut.
- **Building something?** Use the renderer and styles as a dependency, to make PDFs ([Using the renderer](#using-the-renderer)) or to show Markdown in your own pages ([Embedding in a web page](#embedding-in-a-web-page)).

Supports GitHub-flavored Markdown: tables, task lists, footnotes, emoji shortcodes, syntax-highlighted code, raw HTML, GitHub alerts and Obsidian callouts (`> [!NOTE]`, `> [!tip] Custom title`), Obsidian wikilinks and embeds (`[[Note|alias]]` prints as plain text, `![[image.png]]` as an image, and an embedded note as a placeholder naming it), YAML front matter (left out of the PDF; its `title:` names the document when there is no `#` heading), and page breaks (`<div class="page-break"></div>`). Six print styles are included: `github`, `classic`, `academic`, `modern`, `report` and `resume`.

# Command-line tool (macOS)

Markdown is rendered to HTML with [markdown-it](https://github.com/markdown-it/markdown-it) and printed to PDF by headless Chrome.

## Install

Requires Node.js and Google Chrome (Chromium, Edge or Brave also work).

```sh
./install.sh
```

This installs:

- `~/.local/bin/md2pdf` — the command-line tool
- **Convert to PDF** Quick Action — right-click any `.md` file in Finder → **Quick Actions → Convert to PDF**
- **⌃⌥⌘P** keyboard shortcut — select `.md` files in Finder and press it

Re-run `install.sh` if you move this folder or remove the Node version it was installed with. `./uninstall.sh` removes all of it.

To use a different shortcut, pass it when installing (`@` ⌘, `~` ⌥, `^` ⌃, `$` ⇧), or set it to empty to skip:

```sh
MD2PDF_SHORTCUT='@$p' ./install.sh   # ⇧⌘P
MD2PDF_SHORTCUT= ./install.sh        # no shortcut
```

You can also change it later in **System Settings → Keyboard → Keyboard Shortcuts → Services → Files and Folders → Convert to PDF**.

## Usage

```sh
md2pdf notes.md                 # → notes.pdf next to notes.md
md2pdf *.md                     # convert several at once
md2pdf notes.md -o ~/out.pdf    # choose the output path
md2pdf notes.md -p A4           # page size (default: Letter)
md2pdf notes.md --open          # open the PDF when done
md2pdf notes.md -s classic      # use a specific style
md2pdf notes.md --css my.css    # layer extra CSS on top of the style
md2pdf notes.md --html          # also write the intermediate HTML (for tweaking CSS)
```

From Finder, a single file opens in Preview when done; multiple files show a notification.

## Styles

| Style     | Look |
| --------- | ---- |
| `github`  | GitHub's Markdown rendering: sans-serif, boxed tables, GitHub syntax colors |
| `classic` | Book-like: Iowan Old Style serif, justified text, small-caps headings, ruled tables, page numbers |
| `academic` | Journal article: Palatino, numbered sections (1, 1.1, 1.1.1), booktabs tables, journal-style footnotes |
| `modern`  | Clean sans-serif (Avenir Next / Segoe UI), generous whitespace, one blue accent |
| `report`  | Business or technical report: title block from the first heading, running header with the title, "Page N of M" footers, gridded tables |
| `resume`  | Compact and one-page friendly: the first heading is your name, the paragraph after it your contact line, `##` headings are ruled section dividers |

Switch the default style — used by the Finder Quick Action, the keyboard shortcut and the `md2pdf` command:

```sh
./set-style.sh            # list styles (* marks the default)
./set-style.sh classic    # make classic the default
```

The choice is saved in `~/.config/md2pdf/config.json`. Use `md2pdf -s <style>` to override it for one conversion.

### Adding a style

Styles are registered in the `STYLES` map in `bin/md2pdf.js`; each is a list of CSS files inlined into the page in order. A style has two files:

- `styles/<name>.css`, the on-screen look. The content is wrapped in `<article class="markdown-body">`, and every rule must be scoped to it: no `:root`, `html`, `body` or `@page` rules, so the style can be embedded in other pages.
- `styles/print/<name>.css`, the print-only rules: `@page` margins, running headers and page numbers, and `html, body` margins.

Register it in `STYLES` and add its page margin to `pageMargins` in `lib/styles.js`, and it's available to `-s` and `set-style.sh`. Use `md2pdf --html` to get the intermediate HTML for tweaking in a browser. For one-off tweaks, `--css` is enough.

The text of the document's first `#` heading (empty if there is none) is available to page margin boxes as `var(--document-title)`, e.g. `@top-left { content: var(--document-title); }`, as the `report` style does.

A style declares the [shared variables](#variables) in its first rule, `:where(.markdown-body) { … }`, with a comment saying what each one does there, and uses them for every size, gap, color and font they name. Spacing follows two patterns: `line-height: calc(1 + 0.55 * var(--md2pdf-leading))` and `margin: calc(1.8em * var(--md2pdf-space)) 0 …`. `npm test` checks that each variable is declared and changes the document. Page margins aren't included: they stay in the style's `@page` rule, in `styles/print/<name>.css`.

# Using the renderer

The Markdown renderer and the styles are on npm as `@threepenny/md2pdf`. They can also be installed straight from a GitHub release tag (`npm install github:jbrecht/md2pdf#<tag>`).

```sh
npm install @threepenny/md2pdf highlight.js
```

To make a printable page, pass `buildDocument` a style's on-screen and print stylesheets, in that order:

```js
import hljs from 'highlight.js';
import { createRenderer, buildDocument, titleOf } from '@threepenny/md2pdf/render';

const md = createRenderer({ hljs });
const html = buildDocument({
  bodyHtml: md.render(markdown),
  title: titleOf(markdown, 'document'),
  css: classicCss + printCss, // the text of styles/classic.css and styles/print/classic.css
  pageSize: 'A4',
});
```

| Export | What it is |
| ------ | ---------- |
| `@threepenny/md2pdf/render` | `createRenderer({ hljs, math?, html? })`, `buildDocument(...)`, `titleOf(markdown, fallback)` (the first `#` heading, else the front matter's `title:`, else the fallback), `escapeHtml(s)`, `cssString(s)`, `headingText(html)` |
| `@threepenny/md2pdf/styles` | `pageMargins`: each style's `@page` margin at default spacing, e.g. `pageMargins.classic` is `'1in 1.1in 0.9in'` |
| `@threepenny/md2pdf/styles/<name>.css` | Each style's on-screen look, scoped to `.markdown-body`. For `github`, load `github-markdown-css/github-markdown-light.css` first |
| `@threepenny/md2pdf/styles/print/<name>.css` | Each style's print rules: page margins, running headers and page numbers. Load it after the on-screen file, only in a page that holds nothing but the document |

`createRenderer` takes the highlight.js instance to use (so you can pass a smaller bundle such as `highlight.js/lib/common`) and, optionally, `math: { texmath, katex }` from `markdown-it-texmath` and `katex` to render `\( \)`, `\[ \]`, `$` and `$$` formulas; formulas also need KaTeX's stylesheet, `katex/dist/katex.min.css`. Raw HTML in the Markdown is passed through unless you pass `html: false`, which escapes it; page breaks (`<div class="page-break"></div>`) are raw HTML, so they then print as text.

### Variables

Every style takes the same variables, set on the `.markdown-body` element. A `--css` file for the CLI can set them too, e.g. `.markdown-body { --md2pdf-leading: 0.8; --md2pdf-space: 0.75; }` to tighten a document. Each style's file lists its defaults.

| Variable | What it sets |
| -------- | ------------ |
| `--md2pdf-font-size` | The body text size; headings and smaller text scale with it. An absolute length (`pt`, `px` or `rem`), since `em` and `%` would compound. 11pt, or 10.5pt in `modern` and `report` and 10pt in `resume` |
| `--md2pdf-leading` | Line spacing: scales each line height's excess over 1. 1 as designed |
| `--md2pdf-space` | The vertical gaps between blocks. 1 as designed |
| `--md2pdf-background` | The document's background, white |
| `--md2pdf-text` | Body text |
| `--md2pdf-muted` | Secondary text, such as footnotes and captions |
| `--md2pdf-accent` | The accent color: links, headings, list markers or callouts, depending on the style |
| `--md2pdf-rule` | Rules, borders and table lines (every style but `github`) |
| `--md2pdf-surface` | A tinted background: inline code and code blocks in `classic` and `modern`, and callouts too in `classic`; inline code, quotes and table headings in `report`. The other styles don't use it |
| `--md2pdf-font` | The body font |
| `--md2pdf-heading-font` | The heading font: the body font, except in `report`, where it's Helvetica and also sets callout titles and tables |
| `--md2pdf-code-font` | The code font |

The styles are designed for light pages; a dark page isn't supported. Page headers and footers in a PDF keep the style's own fonts and colors.

### Upgrading from 1.x

- The variables are renamed (`--leading` is now `--md2pdf-leading`; the body font, `--serif` or in `modern` and `resume` `--sans`, is `--md2pdf-font`; `report`'s `--sans` is `--md2pdf-heading-font`; and so on) and must be set on `.markdown-body`. A value set on `:root`, as the 1.x README suggested, no longer reaches the document.
- The print rules moved to `styles/print/<name>.css`. Pass `buildDocument` both files, or PDFs lose their margins, running headers and page numbers.
- The package is `@threepenny/md2pdf`, so imports change from `md2pdf/…` to `@threepenny/md2pdf/…`, unless you install it under its old name (`npm install md2pdf@npm:@threepenny/md2pdf`).
- The `github` style includes highlight.js's GitHub theme, so you no longer need to load `highlight.js/styles/github.css`.

## Embedding in a web page

Used inside your own pages, md2pdf is a Markdown-to-HTML renderer rather than a PDF exporter: you get its callouts, wikilinks, math, code highlighting and styles, styled to match your site. A style's on-screen stylesheet only styles the element you render into, `class="markdown-body"`. It sets nothing on `:root`, `html` or `body` and has no `@page` rules, so the rest of your page looks and prints as before. Leave out the print stylesheet: it would take over your page's printing.

To see it working, run `npm run demo` in this repo and open http://localhost:3900/demo/. The [demo](demo/index.html) is one static page: an editor, a style picker, and controls that override the size, spacing and accent of its one document. It needs no build step. An import map loads the renderer's dependencies from a CDN instead, so it needs a network connection. It does need a web server, because browsers won't load JavaScript modules from a page opened as a file.

With a bundler such as Vite:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Notes</title>
  <link rel="stylesheet" href="/node_modules/@threepenny/md2pdf/styles/classic.css">
  <style>
    /* Your site's look: on .markdown-body for every document, or on one of them. */
    .markdown-body { --md2pdf-font-size: 12pt; --md2pdf-font: Georgia, serif; }
    #rendered-notes { --md2pdf-accent: #0b5394; --md2pdf-space: 0.75; }
  </style>
</head>
<body>
  <h1>My site</h1>
  <article id="rendered-notes" class="markdown-body"></article>
  <script type="module">
    import hljs from 'highlight.js/lib/common';
    import { createRenderer } from '@threepenny/md2pdf/render';

    // html: false escapes raw HTML, for Markdown you didn't write yourself.
    const md = createRenderer({ hljs, html: false });
    const markdown = '# Notes\n\n> [!tip] Rendered by md2pdf\n> With **callouts**, `code` and [[wikilinks]].\n\n<b>Escaped</b>';
    document.getElementById('rendered-notes').innerHTML = md.render(markdown);
  </script>
</body>
</html>
```

Set the [variables](#variables) on the `.markdown-body` element itself, with any selector or inline (`<article class="markdown-body" style="--md2pdf-font-size: 10pt">`). The style declares its defaults with no specificity, so your rule wins wherever it appears. A value set on `:root` or another element around the document doesn't reach it. One page can hold several documents in the same style, each with its own overrides, but not two different styles.

The document paints its own background, so on a page that isn't white, give it some padding. Your page's own CSS still applies inside the document, for whatever the style doesn't set: a global `strong { color: #c00 }` reddens bold text in the document too. A highlight.js theme on your page is the exception: the styles keep it out of the document's code blocks. Headings get ids from their text (`# Notes` becomes `id="notes"`) so `[[#Notes]]` links work, so give your own elements ids that a heading won't produce.

For Markdown you didn't write, render with `html: false` and also run the output through a sanitizer such as DOMPurify before inserting it. `html: false` escapes raw HTML, and markdown-it refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs in links and images. Neither is enough alone yet ([#32](https://github.com/jbrecht/md2pdf/issues/32)):

- If other code on your page uses markdown-it-task-lists with `labelAfter`, that plugin's shared settings let raw HTML through md2pdf's task-list items.
- Headings become element ids (`# config` gives `id="config"`), which can shadow globals or ids your own scripts rely on.
- Images load from any URL the author chooses. A Content Security Policy's `img-src` limits that.
- With math enabled, a formula can draw outside the document, so clip the element you render into (`overflow: hidden`).

# Development

```sh
npm install
npm test      # end-to-end tests against test/fixtures
npm run demo  # the embedding demo, at http://localhost:3900/demo/
```

Set `CHROME_PATH` to use a specific browser binary.

# License

[MIT](LICENSE) © 2026 Threepenny Labs LLC
