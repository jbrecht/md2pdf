## Producing the PDF

md2pdf's PDFs come from the CLI, `node bin/md2pdf.js <file.md> -o <out.pdf> -s <style> [-p A4]`, which prints with headless Chrome's `--print-to-pdf`. It needs Google Chrome (or Chromium, Edge, Brave or Chrome Canary, whichever it finds first, or `CHROME_PATH`), no server and no port.

`test/print-all.sh OUT_DIR [CHECKOUT]` prints the whole set: every style `--list-styles` names × `test/fixtures/*.md` and `README.md`, at Letter and at A4, as `OUT_DIR/<style>-<input>-<size>.pdf`. With eleven styles that's 66 PDFs in about 55 seconds. CHECKOUT is the checkout whose CLI and styles print; the inputs always come from the checkout the script is in, so both sides print the same Markdown. It ignores your default style, refuses an OUT_DIR that isn't empty (a stale PDF would be compared), and exits 1 if any print fails.

`$SCRATCH` below is your session's scratchpad. Shell variables don't carry over between Bash calls, so write its absolute path in. Run from the branch's checkout:

    git fetch -q origin && git worktree add --detach "$SCRATCH/main" origin/main
    (cd "$SCRATCH/main" && npm ci)
    test/print-all.sh "$SCRATCH/main-pdfs" "$SCRATCH/main"
    test/print-all.sh "$SCRATCH/branch-pdfs"
    pdfcheck.py diff "$SCRATCH/main-pdfs" "$SCRATCH/branch-pdfs" --out "$SCRATCH/diff-png"

The diff takes about 15 seconds. A new style shows as a PDF only one folder has; a style that is meant to change shows its own PDFs and no others. When you're done, `git worktree remove --force "$SCRATCH/main"`. The CLI starts nothing that outlives it.

## Notes

- Measured 2026-11-13 (Chrome 157, PDFKit at 100 dpi), all 66 PDFs:
  - Printing `main` twice: 0 differ. No input is unstable, so any difference is real.
  - A planted wrong style (classic's README saved as gothic's): reported as `pages 14 vs 13` with 18–56% of each page changed, exit 1.
  - Classic's blockquote border from 2px to 3px: exactly the four classic PDFs of `sample` and `callouts`, each on page 2 (about 0.3–0.5% of the page), exit 1.
- The PDF files differ byte for byte between runs: `/CreationDate` and `/ModDate` hold the print time. Compare pixels, never bytes.
- Nothing printed shows the date or depends on the clock. The CLI renders neither Mermaid nor math (a ```` ```mermaid ```` block prints as code, and KaTeX is only a dev dependency), and the running headers and footers show only page counters and the document title.
- macOS appearance shouldn't change the output: no style uses `prefers-color-scheme`, and the GitHub style's CSS sets `color-scheme: light`. Headless Chrome reports `prefers-color-scheme: light` with the Mac in light mode; dark mode is untested.
- What does depend on the machine: the Chrome version (it updates itself, so print both sides back to back) and the Mac's own fonts. Academic, Classic, Modern, Report, Resume and GitHub set their text in system fonts (Palatino, Iowan Old Style, Avenir Next, Charter, Helvetica Neue, the system UI font). Gothic, Sandwake, Elvish, Cyberpunk and Worksheet bundle their text fonts, and Sandwake and Cyberpunk their code fonts too. Every style still falls back to Mac fonts for some characters: Menlo in all eleven, Lucida Grande in all but GitHub and Gothic, Times New Roman in Academic, Classic, Gothic and Report, and Arial in Modern and Resume.
- Without poppler, `pdfcheck.py fonts` misses fonts Chrome embeds as Type 3: the system UI font (`.SFNS`) that GitHub's body text uses, and Apple Color Emoji. For GitHub it lists only Menlo.
- The throwaway Chrome profile (`md2pdf-chrome-*` in `$TMPDIR`) and the work folder are removed after a print that succeeds, or when Chrome starts and fails. A Chrome that can't start leaves its profile behind, and an interrupt leaves both (#86).
