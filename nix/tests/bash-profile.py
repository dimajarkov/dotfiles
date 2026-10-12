"""Verify the feature's Bash and wrapper ownership without activating it."""

import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

profile, runtime_bash, interactive_bash = map(Path, sys.argv[1:])
assert (profile / "bin/bash").resolve() == interactive_bash.resolve()
wrappers = [
    "hunk",
    "hunk-review-host-types",
    "hunk-turn-review-runtime",
    "hunk-turn-review-control",
    "hunk-turn-review",
    "hunk-turn-review-install",
    "codex",
    "pi",
]
for name in wrappers:
    with (profile / "bin" / name).open("rb") as stream:
        interpreter = shlex.split(stream.readline().decode().removeprefix("#!"))
        assert interpreter[0] == str(runtime_bash), (name, interpreter)
for binary in (runtime_bash, interactive_bash):
    source = json.loads(
        (binary.parent.parent / "nix-support/bash-darwin-pipes/source.json").read_text()
    )
    assert source["version"] == "5.3p16"
    assert [p["number"] for p in source["official"]] == [
        f"{n:03}" for n in range(10, 17)
    ]
    assert all(
        p["url"].startswith("https://ftp.gnu.org/gnu/bash/bash-5.3-patches/")
        for p in source["official"]
    )
    config = (
        binary.parent.parent / "nix-support/bash-darwin-pipes/build-config.txt"
    ).read_text()
    assert "-DPIPESIZE_DYNAMIC" in config
with tempfile.TemporaryDirectory(prefix="bash-profile-") as home:
    # System zshenv resets PATH on this host. Model the installed user hook in
    # this private home, after that system initialization, without activation.
    (Path(home) / ".zshenv").write_text(
        f"export PATH={shlex.quote(str(profile / 'bin'))}:$PATH\n"
    )
    env = {"HOME": home, "PATH": f"{profile}/bin:/usr/bin:/bin", "TMPDIR": home}
    result = subprocess.run(
        [
            "/bin/zsh",
            "-d",
            "-c",
            'command -v bash; bash --noprofile --norc -c \'printf "%s\\n" "$BASH_VERSION"\'',
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    selected, version = result.stdout.strip().splitlines()
    assert selected == str(profile / "bin/bash"), selected
    assert version.startswith("5.3.16("), version
    subprocess.run(
        [profile / "bin/hunk-turn-review-install", "--help"],
        env=env,
        capture_output=True,
        timeout=10,
        check=True,
    )
print(
    json.dumps(
        {
            "profile": str(profile),
            "bash": str(interactive_bash),
            "wrappers": wrappers,
            "version": version,
        }
    )
)
