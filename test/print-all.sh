#!/bin/bash
# Prints every style × every Markdown input, at Letter and at A4, into one folder, for comparing two
# checkouts with kit:pdf-check's `pdfcheck.py diff`.
#
#   test/print-all.sh OUT_DIR [CHECKOUT]
#
# CHECKOUT (default: this one) is the checkout whose CLI, styles and style list print. The inputs,
# test/fixtures/*.md and README.md, always come from this checkout, so both sides of a comparison print
# the same Markdown. Each PDF is OUT_DIR/<style>-<input>-<size>.pdf; OUT_DIR must be new or empty.

set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
[ $# -ge 1 ] || { echo "usage: test/print-all.sh OUT_DIR [CHECKOUT]" >&2; exit 2; }
out=$1
cli="${2:-$here}/bin/md2pdf.js"
[ -f "$cli" ] || { echo "print-all: no CLI at $cli" >&2; exit 2; }
checkout=$(cd "${2:-$here}" && pwd)
if [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "print-all: $out isn't empty; use a fresh folder" >&2; exit 2; fi
mkdir -p "$out"

# A config file that doesn't exist, so the user's default style can't change anything.
export MD2PDF_CONFIG="$out/.no-config.json"
styles=$(node "$cli" --list-styles | cut -c3-)
inputs=("$here"/test/fixtures/*.md "$here/README.md")

failed=0
count=0
for style in $styles; do
  for input in "${inputs[@]}"; do
    name=$(basename "$input" .md)
    for size in Letter A4; do
      pdf="$out/$style-$name-$size.pdf"
      if node "$cli" "$input" -o "$pdf" -s "$style" -p "$size" >/dev/null; then
        count=$((count + 1))
      else
        failed=$((failed + 1))
      fi
    done
  done
done

echo "print-all: $count PDFs from $checkout in $out$([ "$failed" -eq 0 ] || echo ", $failed failed")"
[ "$failed" -eq 0 ]
