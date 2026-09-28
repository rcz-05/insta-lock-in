#!/bin/zsh
# Block instagram.com for every browser on this Mac through /etc/hosts.
# Run with sudo. Pass "remove" to undo. The checker is unaffected: it looks
# Instagram's address up itself (see resolverRules in src/setup.js).
set -euo pipefail

HOSTS=/etc/hosts
START="# insta-lock-in start"
END="# insta-lock-in end"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0 ${1:-}"
  exit 1
fi

# Drop any earlier block first, so running this twice is safe.
sed -i '' "/$START/,/$END/d" "$HOSTS"

if [[ "${1:-}" != "remove" ]]; then
  cat >> "$HOSTS" <<BLOCK
$START
0.0.0.0 instagram.com
0.0.0.0 www.instagram.com
0.0.0.0 m.instagram.com
:: instagram.com
:: www.instagram.com
:: m.instagram.com
$END
BLOCK
fi

dscacheutil -flushcache
killall -HUP mDNSResponder 2>/dev/null || true
[[ "${1:-}" == "remove" ]] && echo "Instagram unblocked on this Mac." || echo "Instagram blocked on this Mac. Quit and reopen your browsers."
