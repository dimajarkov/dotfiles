"""Generate the exact release-relative patch without altering the leased source."""

import argparse
import hashlib
import json
import pathlib
import subprocess

BASE = "7991d3034af1d2116e9c77db31265e409a73bd9f"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=pathlib.Path)
args = parser.parse_args()
source = args.source.resolve(strict=True)
root = pathlib.Path(__file__).resolve().parents[2]


def git(*argv):
    return subprocess.check_output(["git", "-C", source, *argv])


subprocess.run(
    ["git", "-C", source, "merge-base", "--is-ancestor", BASE, "HEAD"], check=True
)
patch = git("diff", "--binary", "--no-ext-diff", BASE, "--", ".")
for name in sorted(
    git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
):
    if not name:
        continue
    result = subprocess.run(
        [
            "git",
            "-C",
            source,
            "diff",
            "--no-index",
            "--binary",
            "--no-ext-diff",
            "--",
            "/dev/null",
            name.decode(),
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode != 1:
        raise RuntimeError(result.stderr.decode())
    patch += result.stdout
destination = root / "nix/patches/hunk-review-persistence.patch"
destination.write_bytes(patch)
# No timestamp: identical source produces identical packaging artifacts.
(root / "nix/patches/hunk-review-persistence.json").write_text(
    json.dumps(
        {
            "baseline": BASE,
            "sourceHead": git("rev-parse", "HEAD").decode().strip(),
            "patchSha256": hashlib.sha256(patch).hexdigest(),
            "bunCompiler": "1.4.2",
            "sourceState": "review-required-snapshot",
        },
        indent=2,
    )
    + "\n"
)
print(
    f"Generated {destination}: {len(patch)} bytes, sha256 {hashlib.sha256(patch).hexdigest()}"
)
