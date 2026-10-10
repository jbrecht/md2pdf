#!/bin/zsh
# Sets the default PDF style used by the Finder Quick Action, the keyboard shortcut
# and the md2pdf command (md2pdf -s <style> still overrides it for one conversion).
#
#   ./set-style.sh            list styles (* marks the current default)
#   ./set-style.sh classic    switch to the classic style

set -eu

MD2PDF="$HOME/.local/bin/md2pdf"
[[ -x "$MD2PDF" ]] || { echo "md2pdf is not installed. Run ${0:A:h}/install.sh first." >&2; exit 1; }

if (( $# == 0 )); then
  "$MD2PDF" --list-styles
else
  "$MD2PDF" --set-style "$1"
fi
