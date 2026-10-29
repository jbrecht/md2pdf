# md2pdf

Convert Markdown to beautifully styled PDFs. This is the rendering engine and macOS command-line tool behind **[md2pdf.me](https://md2pdf.me)**, the free online converter.

- **Just want a PDF?** Use [md2pdf.me](https://md2pdf.me): nothing to install, and your text never leaves your browser.
- **On a Mac and comfortable with a terminal?** Install the command-line tool below. It adds a Finder right-click action and a keyboard shortcut.
- **Building something?** Use the renderer and styles as a dependency (see [Using the renderer](#using-the-renderer)).

Supports GitHub-flavored Markdown: tables, task lists, footnotes, emoji shortcodes, syntax-highlighted code, raw HTML, GitHub alerts and Obsidian callouts (`> [!NOTE]`, `> [!tip] Custom title`), and page breaks (`<div class="page-break"></div>`). Six print styles are included: `github`, `classic`, `academic`, `modern`, `report` and `resume`.

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

Styles are registered in the `STYLES` map in `bin/md2pdf.js`; each is a list of CSS files inlined into the page in order. Create `styles/<name>.css` (the content is wrapped in `<article class="markdown-body">`), register it in `STYLES`, and it's available to `-s` and `set-style.sh`. Use `md2pdf --html` to get the intermediate HTML for tweaking in a browser. For one-off tweaks, `--css` is enough.

The text of the document's first `#` heading (empty if there is none) is available to page margin boxes as `var(--document-title)`, e.g. `@top-left { content: var(--document-title); }`, as the `report` style does.

# Using the renderer

The Markdown renderer and the print styles can be installed straight from GitHub:

```sh
npm install github:jbrecht/md2pdf#v1.1.0
```

```js
import hljs from 'highlight.js';
import { createRenderer, buildDocument, titleOf } from 'md2pdf/render';

const md = createRenderer({ hljs });
const html = buildDocument({
  bodyHtml: md.render(markdown),
  title: titleOf(markdown, 'document'),
  css: classicCss, // e.g. the contents of md2pdf/styles/classic.css
  pageSize: 'A4',
});
```

| Export | What it is |
| ------ | ---------- |
| `md2pdf/render` | `createRenderer({ hljs, math? })`, `buildDocument(...)`, `titleOf(markdown, fallback)`, `escapeHtml(s)`, `cssString(s)`, `headingText(html)` |
| `md2pdf/styles/<name>.css` | The `classic`, `academic`, `modern`, `report` and `resume` styles |
| `md2pdf/styles/github.css` | Print adjustments for the GitHub style; use it after `github-markdown-css` and highlight.js's `github.css` theme |

`createRenderer` takes the highlight.js instance to use (so you can pass a smaller bundle such as `highlight.js/lib/common`) and, optionally, `math: { texmath, katex }` from `markdown-it-texmath` and `katex` to render `\( \)`, `\[ \]`, `$` and `$$` formulas.

# Development

```sh
npm install
npm test    # end-to-end tests against test/fixtures
```

Set `CHROME_PATH` to use a specific browser binary.

# License

[MIT](LICENSE) © 2026 Threepenny Labs LLC
