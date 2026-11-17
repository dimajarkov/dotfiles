#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec sudo /run/current-system/sw/bin/darwin-rebuild switch --flake .#mac
