# md2pdf

Convert Markdown files to beautifully styled PDFs — online at **[md2pdf.me](https://md2pdf.me)**, or on macOS from the terminal or a Finder right-click.

Markdown is rendered to HTML with [markdown-it](https://github.com/markdown-it/markdown-it) and printed to PDF by Chrome (or, on the website, by the visitor's own browser). Supports tables, task lists, footnotes, emoji shortcodes, syntax-highlighted code, raw HTML, and page breaks (`<div class="page-break"></div>`).

## Repository layout

| Path | What it is |
| ---- | ---------- |
| `lib/render.js` | Markdown → HTML rendering shared by the CLI and the website |
| `styles/` | Document styles (`github`, `classic`) shared by both |
| `bin/md2pdf.js` | The command-line tool |
| `quick-action/`, `install.sh`, `set-style.sh` | macOS integration |
| `site/` | The md2pdf.me website (Vite, static, deployed on Vercel) |

# Mac command-line tool

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

Switch the default style — used by the Finder Quick Action, the keyboard shortcut and the `md2pdf` command:

```sh
./set-style.sh            # list styles (* marks the default)
./set-style.sh classic    # make classic the default
```

The choice is saved in `~/.config/md2pdf/config.json`. Use `md2pdf -s <style>` to override it for one conversion.

### Adding a style

Styles are registered in the `STYLES` map in `bin/md2pdf.js`; each is a list of CSS files inlined into the page in order. Create `styles/<name>.css` (the content is wrapped in `<article class="markdown-body">`), register it in `STYLES`, and it's available to `-s` and `set-style.sh`. Use `md2pdf --html` to get the intermediate HTML for tweaking in a browser. For one-off tweaks, `--css` is enough.

# Website (md2pdf.me)

A static site in `site/`: the converter on `/`, a Markdown guide on `/guide/` and a privacy policy on `/privacy/`. Conversion happens entirely in the visitor's browser: the preview is a sandboxed iframe styled with the same CSS as the CLI, and *Download PDF* prints it with the browser's own PDF engine. Empty `@page` margin boxes in each style keep browsers from adding their own date/URL headers.

```sh
npm install              # installs the CLI and site workspaces
npm run dev -w site      # http://localhost:5173
npm run build -w site    # → site/dist
```

Deployed on Vercel (see `vercel.json`).

## Ads

Ads are off until you configure Google AdSense through environment variables (in Vercel's project settings, or `site/.env.local` for local builds):

| Variable | Value |
| -------- | ----- |
| `VITE_ADSENSE_CLIENT` | Your publisher ID, `ca-pub-…`. Adds the AdSense script and verification tag to every page and generates `/ads.txt`. That's enough for AdSense to review the site and for Auto ads. |
| `VITE_ADSENSE_SLOT_TOOL` | Ad unit below the converter |
| `VITE_ADSENSE_SLOT_CONTENT` | Ad unit in the converter page's content |
| `VITE_ADSENSE_SLOT_GUIDE` | Ad unit at the end of the guide |

Slots without an ID are removed from the page; in `npm run dev` they show as dashed placeholders. For visitors in the EEA, UK and Switzerland, set up Google's consent message under **Privacy & messaging** in AdSense; no code changes are needed.

## Development

```sh
npm test    # CLI end-to-end tests against test/fixtures
```

Set `CHROME_PATH` to use a specific browser binary.
