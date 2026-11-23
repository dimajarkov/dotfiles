#!/bin/sh
# Installed as a root-owned regular file. launchd spawns Apple's /bin/sh,
# never an interpreter on the volume whose availability we are waiting for.
attempt=0
while [ "$attempt" -lt 90 ]; do
    if [ -x '@python@' ] && [ -r '@runtime@' ] &&
        '@python@' -I -c 'import json, pathlib, plistlib, pwd, socket, stat, subprocess' >/dev/null 2>&1; then
        exec '@python@' -I '@runtime@' --config '/Library/ArenaCI/config.json' '@mode@'
    fi
    if [ "$attempt" -eq 0 ]; then
        printf '%s\n' 'arena-ci: waiting up to 180s for pinned Nix runtime; inspect Nix volume/mount if persistent' >&2
    fi
    attempt=$((attempt + 1))
    /bin/sleep 2
done
printf '%s\n' 'arena-ci: Nix runtime unavailable; exiting 75 for launchd retry (do not re-register runner)' >&2
exit 75
