#!/bin/bash
set -eu
export LC_TIME=C
case "${NAME:-}" in
  clock)
    sketchybar --set "$NAME" label="$(/bin/date '+%H:%M')"
    ;;
  date)
    sketchybar --set "$NAME" label="$(/bin/date '+%a %d %b')"
    ;;
  battery)
    exec python3 "${CONFIG_DIR:-$HOME/.config/sketchybar}/plugins/metrics.py" battery
    ;;
esac
