"""Attach ordinary Herdr Codex TUIs to their own supported native Unix listener."""

import argparse
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", required=True)
parser.add_argument("argv", nargs=argparse.REMAINDER)
options = parser.parse_args()
argv = options.argv[1:] if options.argv[:1] == ["--"] else options.argv
binary = options.binary


def fallback(error):
    print(
        f"Hunk turn review unavailable: {error}; continuing in native Codex",
        file=sys.stderr,
    )
    os.environ.pop("HUNK_TURN_REVIEW_CODEX_ENDPOINT", None)
    os.execv(binary, [binary, *argv])


# Preserve native utility/noninteractive commands, explicit remotes, and opt-out.
# The binary remains owned by Homebrew; this package owns only orchestration.
commands = {
    "agents",
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "plugin",
    "app-server",
    "remote-control",
    "app",
    "completion",
    "update",
    "doctor",
    "queue",
    "archive",
    "delete",
    "migrate-rollouts",
    "unarchive",
    "cloud",
    "features",
    "help",
    "sandbox",
    "debug",
    "apply",
    "a",
    "exec-server",
}
# Inspect only native option/command positions; their values may be named after
# commands. The compatibility normalization below is the only argv rewrite.
value_options = {
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
}


def normalize_legacy_full_auto(arguments):
    """Translate the deprecated option without rewriting option values or prompts."""
    option_positions = set()
    sandbox_override = False
    approval_override = False
    index = 0
    while index < len(arguments):
        value = arguments[index]
        if value == "--":
            break
        if (
            value in {"-s", "--sandbox"}
            or value.startswith(("--sandbox=", "-s"))
            and len(value) > 2
        ):
            sandbox_override = True
        if (
            value in {"-a", "--ask-for-approval"}
            or value.startswith(("--ask-for-approval=", "-a"))
            and len(value) > 2
        ):
            approval_override = True
        if value in value_options:
            index += 2
            continue
        if value == "--full-auto":
            option_positions.add(index)
        index += 1
    if not option_positions:
        return arguments

    defaults = []
    if not sandbox_override:
        defaults.extend(["--sandbox", "workspace-write"])
    if not approval_override:
        defaults.extend(["--ask-for-approval", "on-request"])
    normalized = []
    first_option = min(option_positions)
    for index, value in enumerate(arguments):
        if index == first_option:
            normalized.extend(defaults)
        if index not in option_positions:
            normalized.append(value)
    return normalized


argv = normalize_legacy_full_auto(argv)
bypass = (
    os.environ.get("HERDR_ENV") != "1"
    or os.environ.get("HUNK_TURN_REVIEW_DISABLED") == "1"
)
cwd = Path.cwd()
index = 0
positional_seen = False
while index < len(argv):
    value = argv[index]
    if value == "--":
        break
    if value in {"--version", "-V", "--help", "-h", "--remote"} or value.startswith(
        "--remote="
    ):
        bypass = True
    if value in value_options:
        if index + 1 < len(argv):
            if value in ("-C", "--cd"):
                cwd = Path(argv[index + 1]).expanduser().resolve()
            index += 1
    elif value.startswith("--cd="):
        cwd = Path(value.removeprefix("--cd=")).expanduser().resolve()
    elif value.startswith("-C"):
        cwd = Path(value[2:]).expanduser().resolve()
    elif not value.startswith("-") and not positional_seen:
        positional_seen = True
        bypass = bypass or value in commands
    index += 1
if bypass:
    os.execv(binary, [binary, *argv])
if (
    subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode
    != 0
):
    os.execv(binary, [binary, *argv])
state = Path(
    os.environ.get(
        "HUNK_TURN_REVIEW_STATE",
        str(Path.home() / ".local/state/hunk-turn-review/data"),
    )
)
try:
    node = state.lstat()
    if (
        not stat.S_ISDIR(node.st_mode)
        or node.st_uid != os.getuid()
        or node.st_mode & 0o077
    ):
        raise RuntimeError("Native listener requires installed private feature state")
except (OSError, RuntimeError) as error:
    fallback(error)
try:
    session = Path(tempfile.mkdtemp(prefix="cx-", dir=state)).resolve()
except OSError as error:
    fallback(error)
endpoint = "unix://" + str(session / "native.sock")
environment = {
    **os.environ,
    "HUNK_TURN_REVIEW_CODEX_ENDPOINT": endpoint,
    "HUNK_TURN_REVIEW_CODEX_BINARY": binary,
}
with (session / "native.log").open("xb") as log:
    os.chmod(session / "native.log", 0o600)
    log.write(b"Feature-owned native listener starting\n")
    log.flush()
    try:
        server = subprocess.Popen(
            [binary, "app-server", "--listen", endpoint],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        fallback(error)
    failure = None
    try:
        for attempt in range(200):
            if (session / "native.sock").exists():
                break
            if server.poll() is not None:
                raise RuntimeError(
                    f"Feature native listener exited with code {server.returncode}; inspect {session / 'native.log'}"
                )
            time.sleep(0.05)
        else:
            raise RuntimeError(
                f"Feature native listener timed out; inspect {session / 'native.log'}"
            )
        # Preserve stdin/stdout and the existing TUI, hooks, safeguards and auth.
        tui = subprocess.Popen([binary, "--remote", endpoint, *argv], env=environment)
        previous = {}
        for sig in (signal.SIGTERM, signal.SIGHUP):
            previous[sig] = signal.signal(
                sig, lambda received, _frame: tui.send_signal(received)
            )
        try:
            code = tui.wait()
        except KeyboardInterrupt:
            # Both the foreground TUI and this wrapper receive the terminal signal.
            code = tui.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    except (OSError, RuntimeError) as error:
        failure = error
    finally:
        # Stop only the new process this launcher owns, never a shared daemon.
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.write(
            f"Feature-owned listener stopped with code {server.returncode}\n".encode()
        )
    if failure:
        fallback(failure)
raise SystemExit(code)
