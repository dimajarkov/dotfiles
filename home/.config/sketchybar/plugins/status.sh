#!/bin/bash
set -eu
source "${CONFIG_DIR:-$HOME/.config/sketchybar}/colors.sh"

case "${NAME:-}" in
  clock)
    sketchybar --set "$NAME" label="$(/bin/date '+%H:%M')"
    ;;
  date)
    sketchybar --set "$NAME" label="$(/bin/date '+%d %b')"
    ;;
  battery)
    state=$(/usr/bin/pmset -g batt) || state=""
    percentage=$(printf '%s\n' "$state" | /usr/bin/awk -F ';' '/InternalBattery/ {sub(/.*[[:space:]]/, "", $1); sub(/%$/, "", $1); print $1}')
    if [[ ! "$percentage" =~ ^[0-9]+$ ]]; then
      sketchybar --set "$NAME" drawing=off
      exit 0
    fi
    color="$TEXT"
    icon=
    if [[ "$state" == *"AC Power"* ]]; then
      icon=
      color="$GREEN"
    elif (( percentage <= 20 )); then
      icon=
      color="$RED"
    elif (( percentage <= 50 )); then
      icon=
    fi
    sketchybar --set "$NAME" drawing=on icon="$icon" icon.color="$color" label.color="$color" label="$percentage%"
    ;;
  volume)
    volume="${INFO:-}"
    if [[ "${SENDER:-}" != volume_change || ! "$volume" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      # CoreAudio-backed system query, no application automation permission needed.
      volume=$(/usr/bin/osascript -e 'output volume of (get volume settings)' 2>/dev/null) || volume=""
    fi
    if [[ ! "$volume" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      sketchybar --set "$NAME" label="--" icon=
      exit 0
    fi
    volume="${volume%.*}"
    icon=
    (( volume == 0 )) && icon=
    sketchybar --set "$NAME" icon="$icon" label="$volume%"
    ;;
esac
