#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec sudo darwin-rebuild switch --flake .#mac
