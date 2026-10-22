#!/bin/bash
set -eu
# Shared native safe geometry also maps AeroSpace through NSScreen order.
exec python3 "${CONFIG_DIR:-$HOME/.config/sketchybar}/plugins/display.py"
