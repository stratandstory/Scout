#!/bin/bash
# Scout — Mac LaunchAgent installer
# Starts the companion server automatically on login.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"
PLIST_SRC="$SCRIPT_DIR/com.scout.server.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.scout.server.plist"
LOG_DIR="$HOME/.scout"

# Find node
NODE_PATH=$(which node 2>/dev/null || echo "/usr/local/bin/node")
if [ ! -x "$NODE_PATH" ]; then
    echo "Error: node not found. Install Node.js first."
    exit 1
fi

echo "Scout LaunchAgent Installer"
echo "============================"
echo "Server dir:  $SERVER_DIR"
echo "Node:        $NODE_PATH"
echo "Log file:    $LOG_DIR/server.log"
echo ""

# Create log directory
mkdir -p "$LOG_DIR"

# Stop existing service if running
if launchctl list com.scout.server &>/dev/null; then
    echo "Stopping existing Scout service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Generate plist with actual paths
sed -e "s|__SCOUT_SERVER_DIR__|$SERVER_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|/usr/local/bin/node|$NODE_PATH|g" \
    "$PLIST_SRC" > "$PLIST_DEST"

# Load the service
launchctl load "$PLIST_DEST"

echo "Scout is now set to start on login."
echo ""
echo "Commands:"
echo "  Stop:    launchctl unload ~/Library/LaunchAgents/com.scout.server.plist"
echo "  Start:   launchctl load ~/Library/LaunchAgents/com.scout.server.plist"
echo "  Logs:    tail -f ~/.scout/server.log"
echo "  Status:  open http://localhost:8765/dashboard"
