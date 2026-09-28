#!/bin/zsh
# Install (or with "remove", uninstall) the launchd job that starts the
# checker every hour and at login. check.js itself only does real work when
# the last completed run was about 12 hours ago.
set -euo pipefail

LABEL="com.insta-lock-in.checker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

if [[ "${1:-}" == "remove" ]]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/check.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/checker.log</string>
  <key>StandardErrorPath</key><string>$DIR/checker.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: tries every hour, checks Instagram about every 12 hours, logs to $DIR/checker.log"
