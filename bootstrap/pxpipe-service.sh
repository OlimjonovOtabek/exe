#!/usr/bin/env bash
# Run pxpipe as a background service that survives reboots.
#
#   pxpipe-service.sh install     write the service and start it
#   pxpipe-service.sh uninstall   stop it and remove the service
#   pxpipe-service.sh status      print whether the proxy answers
#
# Environment:
#   EXE_PXPIPE_PORT     listen port                      (default 47821)
#   EXE_PXPIPE_MODELS   pxpipe model allowlist           (default claude-fable-5)
#                       a base matches itself and any "<base>-..." id, so
#                       claude-fable-5 covers Fable 5.1. Add claude-opus-5 or
#                       claude-sonnet-5 to image those too. "off" disables imaging.
#
# macOS: launchd agent uz.exe.pxpipe. Linux: systemd user unit exe-pxpipe.service.
# Without systemd (containers), the proxy is started with nohup instead.

set -euo pipefail

PORT="${EXE_PXPIPE_PORT:-47821}"
MODELS="${EXE_PXPIPE_MODELS:-claude-fable-5}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/exe"
LOG_FILE="$LOG_DIR/pxpipe.log"
LABEL="uz.exe.pxpipe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/exe-pxpipe.service"

os="$(uname -s)"

need_bins() {
  PXPIPE_BIN="$(command -v pxpipe || true)"
  NODE_BIN="$(command -v node || true)"
  [ -n "$PXPIPE_BIN" ] || { echo "pxpipe not on PATH. Run: npm install -g pxpipe-proxy" >&2; exit 1; }
  [ -n "$NODE_BIN" ] || { echo "node not on PATH" >&2; exit 1; }
}

wait_for_port() {
  local i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then return 0; fi
    sleep 0.5
  done
  return 1
}

install_mac() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PXPIPE_BIN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PXPIPE_MODELS</key><string>$MODELS</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

uninstall_mac() {
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
}

has_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

install_linux() {
  mkdir -p "$LOG_DIR"
  if has_user_systemd; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT" <<EOF
[Unit]
Description=pxpipe token-saving proxy for Claude Code
After=network-online.target

[Service]
ExecStart=$NODE_BIN $PXPIPE_BIN
Environment=PORT=$PORT
Environment=PXPIPE_MODELS=$MODELS
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now exe-pxpipe.service
  else
    echo "no user systemd here; starting pxpipe with nohup (will not survive a reboot)" >&2
    if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
      PORT="$PORT" PXPIPE_MODELS="$MODELS" setsid nohup "$NODE_BIN" "$PXPIPE_BIN" >> "$LOG_FILE" 2>&1 < /dev/null &
    fi
  fi
}

uninstall_linux() {
  if has_user_systemd && [ -f "$UNIT" ]; then
    systemctl --user disable --now exe-pxpipe.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
  else
    pkill -f "$(command -v pxpipe || echo pxpipe-not-installed)" >/dev/null 2>&1 || true
  fi
}

status() {
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "pxpipe: listening on http://127.0.0.1:$PORT"
    return 0
  fi
  echo "pxpipe: not answering on port $PORT"
  return 1
}

case "${1:-}" in
  install)
    need_bins
    case "$os" in
      Darwin) install_mac ;;
      *) install_linux ;;
    esac
    if wait_for_port; then status; else echo "pxpipe did not start; see $LOG_FILE" >&2; exit 1; fi
    ;;
  uninstall)
    case "$os" in
      Darwin) uninstall_mac ;;
      *) uninstall_linux ;;
    esac
    echo "pxpipe service removed"
    ;;
  status) status ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
