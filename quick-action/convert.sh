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

ok=()
errors=()
for f in "$@"; do
  if pdf=$("$MD2PDF" "$f" 2>&1); then
    ok+=("$pdf")
  else
    errors+=("${f:t}: ${pdf#md2pdf: }")
  fi
done

if (( ${#errors} )); then
  notify "md2pdf: ${#errors} failed" "${errors[1]}"
elif (( ${#ok} == 1 )); then
  open "${ok[1]}"
else
  notify "md2pdf" "Created ${#ok} PDFs"
fi
