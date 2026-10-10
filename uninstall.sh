#!/bin/zsh
# Removes the md2pdf launcher and Finder Quick Action installed by install.sh.

rm -f "$HOME/.local/bin/md2pdf"
rm -rf "$HOME/.config/md2pdf"
rm -rf "$HOME/Library/Services/Convert to PDF.workflow"

# Remove the keyboard shortcut from the Services preferences.
prefs=$(mktemp -t md2pdf-pbs)
defaults export pbs "$prefs"
if plutil -remove "NSServicesStatus.(null) - Convert to PDF - runWorkflowAsService" "$prefs" 2>/dev/null; then
  defaults import pbs "$prefs"
fi
rm -f "$prefs"
/System/Library/CoreServices/pbs -update 2>/dev/null || true
echo "md2pdf uninstalled."
