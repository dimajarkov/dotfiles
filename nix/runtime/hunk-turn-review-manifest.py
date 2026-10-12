"""Validate and package source-owner installation exports; never synthesize hooks."""

import json
from pathlib import Path
import shlex
import re
import sys

profile, assets, runtime, node = map(Path, sys.argv[1:])
home = assets / "share/home"
missing = []
hooks_path = home / ".codex/hunk-turn-review/hooks.fragment.json"
if hooks_path.is_file():
    hooks = json.loads(hooks_path.read_text())
    for groups in hooks["hooks"].values():
        for group in groups:
            for hook in group["hooks"]:
                argv = shlex.split(hook["command"])
                # Consume the actual source-owned argv-only fragment, replacing
                # its inspected user path with the matching immutable artifact.
                if argv[:2] != ["node", "$HOME/.codex/hunk-turn-review/hook.mjs"]:
                    raise RuntimeError(
                        "Unrecognized source hook command; integration review required"
                    )
                hook["command"] = shlex.join(
                    [
                        str(node / "bin/node"),
                        str(home / ".codex/hunk-turn-review/hook.mjs"),
                        *argv[2:],
                    ]
                )
else:
    hooks = {"hooks": {}}
    missing.append(
        "source-owned Codex hooks.fragment.json and executable bootstrap contract"
    )
plugin = profile / "share/home/.config/herdr/plugins/hunk-turn-review/herdr-plugin.toml"
if not plugin.is_file():
    missing.append(
        "source-owned inspected Herdr herdr-plugin.toml (hunk-turn-review/review)"
    )
minimum = (
    re.search(
        r'^min_herdr_version\s*=\s*"(\d+\.\d+\.\d+)"\s*$', plugin.read_text(), re.M
    )
    if plugin.is_file()
    else None
)
if not minimum:
    missing.append("explicit native Herdr minimum version")
ui = home / ".config/hunk/extensions/human-review/index.ts"
if "registerTurnReview" not in ui.read_text():
    missing.append("source-owned Hunk turn-review CLI/persistence registration")
manifest = {
    "version": 1,
    "missing": missing,
    "runtime": str(runtime / "bin/hunk-turn-review-runtime"),
    "client": str(home / ".local/share/hunk-turn-review/client.mjs"),
    "hooks": hooks,
    "plugin": "share/home/.config/herdr/plugins/hunk-turn-review",
    "herdr": {"minVersion": minimum.group(1) if minimum else None, "protocol": 22},
    "links": {
        ".local/share/hunk-turn-review": "share/home/.local/share/hunk-turn-review",
        ".pi/agent/extensions/hunk-turn-review": "share/home/.pi/agent/extensions/hunk-turn-review",
        ".codex/hunk-turn-review": "share/home/.codex/hunk-turn-review",
        ".config/hunk-turn-review/herdr-plugin": "share/home/.config/herdr/plugins/hunk-turn-review",
    },
}
(profile / "share/hunk-turn-review-install.json").write_text(
    json.dumps(manifest, indent=2) + "\n"
)
