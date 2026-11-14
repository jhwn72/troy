#!/bin/zsh
# Start BlueBubbles and keep the Mac awake automatically at login (for the hackathon demo).
#   ./scripts/autostart.sh on       install and start
#   ./scripts/autostart.sh off      stop and remove (do this after the hackathon)
#   ./scripts/autostart.sh status
# The Troy server's own agent (com.troy.server) is managed by the Troy server setup; "off" removes it too if present.
set -euo pipefail
LA="$HOME/Library/LaunchAgents"
BB="com.troy.bluebubbles"
CAF="com.troy.caffeinate"
SERVER="com.troy.server"
uid=$(id -u)

write_agents() {
  mkdir -p "$LA"
  # BlueBubbles: open once at login. No KeepAlive, so quitting it to reinstall the helper isn't fought by launchd.
  cat > "$LA/$BB.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$BB</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>/Applications/BlueBubbles.app</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  # caffeinate: keep display, idle, disk and system awake; restart if it ever exits.
  cat > "$LA/$CAF.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$CAF</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-dimsu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
}

case "${1:-status}" in
  on)
    write_agents
    for a in $BB $CAF; do launchctl bootout "gui/$uid/$a" 2>/dev/null || true; launchctl bootstrap "gui/$uid" "$LA/$a.plist"; done
    echo "Auto-start ON: BlueBubbles at login, caffeinate always running."
    ;;
  off)
    for a in $BB $CAF $SERVER; do
      launchctl bootout "gui/$uid/$a" 2>/dev/null || true
      rm -f "$LA/$a.plist"
    done
    echo "Auto-start OFF: agents removed. BlueBubbles keeps running until you quit it; the Mac can sleep normally again."
    ;;
  status)
    for a in $BB $CAF $SERVER; do
      if [[ -f "$LA/$a.plist" ]]; then
        launchctl print "gui/$uid/$a" >/dev/null 2>&1 && echo "$a: installed, loaded" || echo "$a: installed, not loaded"
      else
        echo "$a: not installed"
      fi
    done
    ;;
  *) echo "usage: $0 on|off|status"; exit 1 ;;
esac
