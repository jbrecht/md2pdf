#!/bin/zsh
# Removes the md2pdf launcher and Finder Quick Action installed by install.sh, and the saved style.

set -euo pipefail

if [[ -z ${HOME:-} || $HOME != /* || ! -d $HOME || ${HOME:A} == / ]]; then
  print -r -- "uninstall.sh: HOME (${HOME:-unset}) isn't a home folder; nothing removed." >&2
  exit 1
fi

# A step that can't remove its file says so (rm prints why) and the rest still run.
failed=0
rm -f "$HOME/.local/bin/md2pdf" || failed=1
rm -rf "$HOME/Library/Services/Convert to PDF.workflow" || failed=1

# The saved style is config.json, where the CLI reads it (bin/md2pdf.js): under XDG_CONFIG_HOME when that's
# set, and under ~/.config, where the Quick Action reads it, since Finder doesn't load your shell profile.
# Only that file goes, and its folder if that leaves it empty, so anything else kept beside it stays.
remove_config() {
  local file=$1/config.json
  if [[ -L $file || -f $file ]]; then
    if rm -f -- "$file"; then
      print -r -- "Removed $file"
    else
      failed=1
    fi
  elif [[ -e $file ]]; then
    print -r -- "Kept $file: not a file"
  fi
  rmdir -- "$1" 2>/dev/null || true
}
config_dirs=()
if [[ -n ${XDG_CONFIG_HOME:-} ]]; then
  if [[ $XDG_CONFIG_HOME == /* ]]; then
    config_dirs+=("$XDG_CONFIG_HOME/md2pdf")
  else
    print -r -- "Skipped XDG_CONFIG_HOME ($XDG_CONFIG_HOME): not an absolute path"
  fi
fi
config_dirs+=("$HOME/.config/md2pdf")
for dir in "${(@u)config_dirs:a}"; do
  remove_config "$dir"
done
# A config file you chose yourself is yours to remove.
if [[ -n ${MD2PDF_CONFIG:-} && ( -e $MD2PDF_CONFIG || -L $MD2PDF_CONFIG ) ]]; then
  print -r -- "Kept $MD2PDF_CONFIG (set by MD2PDF_CONFIG)"
fi

# Remove the keyboard shortcut from the Services preferences.
prefs=$(mktemp "${TMPDIR:-/tmp}/md2pdf-pbs.XXXXXX")
trap 'rm -f -- "$prefs"' EXIT
if ! defaults export pbs "$prefs"; then
  print -r -- "Kept the keyboard shortcut: couldn't read the Services preferences" >&2
  failed=1
elif plutil -remove "NSServicesStatus.(null) - Convert to PDF - runWorkflowAsService" "$prefs" 2>/dev/null; then
  defaults import pbs "$prefs" || failed=1
fi
/System/Library/CoreServices/pbs -update 2>/dev/null || true
if (( failed )); then
  print -r -- "md2pdf uninstalled, except what's listed above." >&2
  exit 1
fi
echo "md2pdf uninstalled."
