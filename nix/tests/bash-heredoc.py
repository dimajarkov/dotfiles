"""Exercise the selected Bash's real heredoc redirection with bounded children."""

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import tempfile


def run(binary, flags, script, env):
    process = subprocess.Popen(
        [binary, *flags, "-c", script],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        # The child created this session, and no unrelated process is targeted.
        if process.poll() is None and os.getpgid(process.pid) == process.pid:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)
        raise AssertionError(
            f"{binary} {flags}: owned heredoc group {process.pid} timed out"
        )
    assert process.returncode == 0, (binary, flags, process.returncode, err.decode())
    return out


def pipe_capacity():
    reader, writer = os.pipe()
    try:
        os.set_blocking(writer, False)
        return {
            "pipe_buf": os.fpathconf(writer, "PC_PIPE_BUF"),
            "accepted": os.write(writer, b"x" * 65536),
        }
    finally:
        os.close(reader)
        os.close(writer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bash", nargs="+")
    parser.add_argument("--cat", default="/bin/cat")
    parser.add_argument("--expected-version")
    args = parser.parse_args()
    rows = []
    with tempfile.TemporaryDirectory(prefix="bash-heredoc-") as directory:
        home = Path(directory) / "home"
        temporary = Path(directory) / "tmp"
        home.mkdir()
        temporary.mkdir()
        env = {
            "HOME": str(home),
            "TMPDIR": str(temporary),
            "PATH": str(Path(args.cat).parent),
            "LANG": "en_US.UTF-8",
        }
        for binary in args.bash:
            for flags in (["--noprofile", "--norc"], ["--noprofile", "--norc", "-i"]):
                version = run(
                    binary,
                    flags,
                    'printf \'%s.%s.%s\' "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}" "${BASH_VERSINFO[2]}"',
                    env,
                ).decode()
                if args.expected_version:
                    assert version == args.expected_version, (binary, version)
                for size in (512, 513, 4096, 65536, 65537, 131073):
                    body = b"x" * (size - 1) + b"\n"
                    script = (
                        f"{shlex.quote(args.cat)} <<'EXACT_EOF'\n"
                        + body.decode()
                        + "EXACT_EOF\n"
                    )
                    assert run(binary, flags, script, env) == body, (
                        binary,
                        flags,
                        size,
                    )
                body = "Unicode: λ 日本語 🚢\nLiteral: $PATH ${HOME} `printf bad` \\ \" ' EOF\n\n".encode()
                script = (
                    f"{shlex.quote(args.cat)} <<'EXACT_EOF'\n"
                    + body.decode()
                    + "EXACT_EOF\n"
                )
                assert run(binary, flags, script, env) == body, (
                    binary,
                    flags,
                    "unicode/literal/EOF",
                )
                # Above the original 65536-byte ceiling, inspect the actual
                # unlinked private tempfile as well as the complete payload.
                probe = "import json,os,sys; s=os.fstat(0); print(json.dumps({'mode':s.st_mode,'links':s.st_nlink,'data':sys.stdin.read()}))"
                body = "z" * 65536 + "\n"
                script = f"{shlex.quote(sys.executable)} -c {shlex.quote(probe)} <<'EXACT_EOF'\n{body}EXACT_EOF\n"
                result = json.loads(run(binary, flags, script, env))
                assert result["data"] == body
                assert stat.S_ISREG(result["mode"]), result["mode"]
                assert result["mode"] & 0o077 == 0, result["mode"]
                assert result["links"] == 0, result["links"]
                assert not list(temporary.iterdir()), (
                    "Heredoc left temporary files behind",
                    [p.name for p in temporary.iterdir()],
                )
                rows.append(
                    {
                        "binary": str(Path(binary).resolve()),
                        "flags": flags,
                        "version": version,
                        "cases": 8,
                    }
                )
    print(
        json.dumps(
            {"result": "passed", "pipe": pipe_capacity(), "runs": rows}, indent=2
        )
    )


if __name__ == "__main__":
    main()
