#!/bin/zsh
# Run by the Finder "Convert to PDF" Quick Action with the selected files as arguments.
# Quick Actions don't load your shell profile, so md2pdf is called by absolute path.

MD2PDF="$HOME/.local/bin/md2pdf"

notify() {
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$@"
}

if [[ ! -x "$MD2PDF" ]]; then
  notify "md2pdf" "md2pdf is not installed. Run install.sh in the md2pdf project."
  exit 1
fi

# stdout is the PDF's path alone; a conversion that works can still print warnings on stderr.
log=$(mktemp -t md2pdf-quick-action) || exit 1
ok=()
errors=()
for f in "$@"; do
  if pdf=$("$MD2PDF" "$f" 2>"$log"); then
    ok+=("$pdf")
  else
    # The error is the last thing printed, after any warnings, as "md2pdf: <file>: <error>".
    err=$(<"$log")
    prefix="md2pdf: $f: "
    errors+=("${f:t}: ${${err##*$prefix}#md2pdf: }")
  fi
done
rm -f "$log"

if (( ${#errors} )); then
  notify "md2pdf: ${#errors} failed" "${errors[1]}"
elif (( ${#ok} == 1 )); then
  open "${ok[1]}"
else
  notify "md2pdf" "Created ${#ok} PDFs"
fi
