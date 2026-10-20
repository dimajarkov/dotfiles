#!/bin/bash
# Compatibility entry point; the Python controller owns the complete snapshot.
set -eu
exec python3 "${CONFIG_DIR:-$HOME/.config/sketchybar}/plugins/workspaces.py" render
