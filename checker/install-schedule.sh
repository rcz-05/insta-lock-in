#!/bin/zsh
# Install (or with "remove", uninstall) the launchd job that starts the
# checker every 15 minutes and at login. check.js itself only does real work
# when the last completed run was about 12 hours ago.
#
# Clock times (StartCalendarInterval), not StartInterval: StartInterval only
# counts time the Mac is awake, so after a night asleep it could wait up to
# another awake hour. Clock times missed during sleep run once, on wake.
# caffeinate -i keeps an awake Mac from idling to sleep mid run.
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
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$DIR/check.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Minute</key><integer>0</integer></dict>
    <dict><key>Minute</key><integer>15</integer></dict>
    <dict><key>Minute</key><integer>30</integer></dict>
    <dict><key>Minute</key><integer>45</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/checker.log</string>
  <key>StandardErrorPath</key><string>$DIR/checker.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: tries every 15 minutes and on wake, checks Instagram about every 12 hours, logs to $DIR/checker.log"
