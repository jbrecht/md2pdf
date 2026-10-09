# md2pdf

Convert Markdown files to GitHub-styled PDFs on macOS — from the terminal or by right-clicking in Finder.

Markdown is rendered to HTML with [markdown-it](https://github.com/markdown-it/markdown-it) and printed to PDF by your installed Google Chrome running headless. Supports tables, task lists, footnotes, emoji shortcodes, syntax-highlighted code, raw HTML, and images referenced relative to the Markdown file.

## Install

Requires Node.js and Google Chrome (Chromium, Edge or Brave also work).

```sh
./install.sh
```

This installs:

- `~/.local/bin/md2pdf` — the command-line tool
- **Convert to PDF** Quick Action — right-click any `.md` file in Finder → **Quick Actions → Convert to PDF**

Re-run `install.sh` if you move this folder or remove the Node version it was installed with. `./uninstall.sh` removes both.

> Tip: assign a keyboard shortcut in **System Settings → Keyboard → Keyboard Shortcuts → Services → Files and Folders → Convert to PDF**.

## Usage

```sh
md2pdf notes.md                 # → notes.pdf next to notes.md
md2pdf *.md                     # convert several at once
md2pdf notes.md -o ~/out.pdf    # choose the output path
md2pdf notes.md -p A4           # page size (default: Letter)
md2pdf notes.md --open          # open the PDF when done
md2pdf notes.md --css my.css    # layer extra CSS on top of the style
md2pdf notes.md --html          # also write the intermediate HTML (for tweaking CSS)
```

From Finder, a single file opens in Preview when done; multiple files show a notification.

## Styles

Styles are registered in the `STYLES` map in `bin/md2pdf.js`: each is a list of CSS files inlined into the page in order. The `github` style combines `github-markdown-css`, highlight.js's GitHub theme, and print tweaks in `styles/github.css`.

To add one, create `styles/<name>.css` (the content is wrapped in `<article class="markdown-body">`), register it in `STYLES`, and use `md2pdf -s <name>`. For one-off tweaks, `--css` is enough.

## Development

```sh
npm test    # end-to-end tests against test/fixtures
```

Set `CHROME_PATH` to use a specific browser binary.
