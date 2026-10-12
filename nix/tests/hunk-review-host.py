"""Public packaged host artifact check, without starting a daemon or TUI."""

import json
import pathlib
import subprocess
import sys

host = pathlib.Path(sys.argv[1])
assert (
    subprocess.check_output([host / "bin/hunk", "--version"], text=True).strip()
    == "0.23.0"
)
for skill in ("hunk-review", "hunk-extensions"):
    path = subprocess.check_output(
        [host / "bin/hunk", "skill", "path", skill], text=True
    ).strip()
    assert pathlib.Path(path).is_file(), path
types = (host / "share/hunk/extension-api/types.d.ts").read_text()
assert "HUNK_EXTENSION_API_VERSION = 29" in types
assert "registerReviewPersistence(" in types
provenance = json.loads((host / "share/hunk/provenance.json").read_text())
assert provenance["baseline"] == "7991d3034af1d2116e9c77db31265e409a73bd9f"
assert provenance["bunCompiler"] == "1.4.2"
print("Packaged Hunk 0.23.0 skills and API 29 declarations verified")
