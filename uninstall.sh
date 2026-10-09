#!/bin/zsh
# Removes the md2pdf launcher and Finder Quick Action installed by install.sh.

rm -f "$HOME/.local/bin/md2pdf"
rm -rf "$HOME/Library/Services/Convert to PDF.workflow"
/System/Library/CoreServices/pbs -update 2>/dev/null || true
echo "md2pdf uninstalled."
