#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point. The Node harness uses an offline provider and ID-owned cleanup.
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_directory/e2e-scopes.mjs"
