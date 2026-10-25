#!/usr/bin/env python3
"""Private display-label state; AeroSpace identities are never mutated."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import time
import unicodedata

MAX_BYTES = 65536
MAX_LABEL = 40


class LabelError(ValueError):
    """A value-safe error suitable for showing without logging user text."""


class BusyError(LabelError):
    """A naming dialog already owns the non-queuing prompt lane."""


def normalize(value):
    if not isinstance(value, str) or any(
        unicodedata.category(c).startswith("C") or c in "\r\n" for c in value
    ):
        raise LabelError("Labels cannot contain control or formatting characters.")
    value = unicodedata.normalize("NFC", value).strip()
    if not value or len(value) > MAX_LABEL:
        raise LabelError("Enter a label between 1 and 40 characters.")
    return value


def private_file(fd):
    info = os.fstat(fd)
    if (
        info.st_uid != os.getuid()
        or not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
    ):
        raise LabelError("Label state must be an owner-private regular file.")


class Store:
    def __init__(self, root=None):
        self.root = (
            Path(root)
            if root is not None
            else Path.home() / ".local/state/sketchybar/workspace-labels"
        )

    @contextlib.contextmanager
    def directory(self, create=True):
        # Walk from / using directory descriptors, never following any symlink.
        path = self.root.absolute()
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:]:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise LabelError(
                    "The label state directory must be owner-private (0700)."
                )
            yield fd
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def locked(self, directory, name="labels.lock", wait=True):
        fd = os.open(
            name,
            os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
            0o600,
            dir_fd=directory,
        )
        try:
            private_file(fd)
            deadline = time.monotonic() + (2 if wait else 0)
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        error = LabelError if wait else BusyError
                        raise error("Another label operation is in progress.") from None
                    time.sleep(0.01)
            yield
        finally:
            os.close(fd)

    def _read(self, directory):
        try:
            fd = os.open(
                "workspace-labels.json",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=directory,
            )
        except FileNotFoundError:
            return {"version": 1, "revision": 0, "labels": {}}
        try:
            private_file(fd)
            with os.fdopen(fd, "rb", closefd=False) as source:
                data = source.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise LabelError(
                    "Label state is too large; the original file was preserved."
                )
            state = json.loads(data)
            if (
                not isinstance(state, dict)
                or set(state) != {"version", "revision", "labels"}
                or type(state["version"]) is not int
                or state["version"] != 1
                or type(state["revision"]) is not int
                or not 0 <= state["revision"] < 2**63
                or not isinstance(state["labels"], dict)
                or len(state["labels"]) > 256
            ):
                raise ValueError
            for key, value in state["labels"].items():
                if (
                    not isinstance(key, str)
                    or not key
                    or len(key) > 256
                    or any(unicodedata.category(c).startswith("C") for c in key)
                    or normalize(value) != value
                ):
                    raise ValueError
            return state
        except (ValueError, UnicodeError):
            raise LabelError(
                "Label state is invalid or unsupported; the original file was preserved."
            ) from None
        finally:
            os.close(fd)

    def read(self):
        try:
            with self.directory(create=False) as directory, self.locked(directory):
                return self._read(directory)
        except FileNotFoundError:
            return {"version": 1, "revision": 0, "labels": {}}

    def update(self, workspace, value, workspaces, revision):
        with self.directory() as directory, self.locked(directory):
            state = self._read(directory)
            if state["revision"] != revision:
                raise LabelError(
                    "Labels changed while the dialog was open; please try again."
                )
            if (
                not isinstance(workspace, str)
                or not workspace
                or len(workspace) > 256
                or any(unicodedata.category(c).startswith("C") for c in workspace)
            ):
                raise LabelError("This workspace name cannot have a saved label.")
            if workspace not in workspaces:
                raise LabelError("This workspace is no longer available.")
            value = normalize(value) if value is not None else None
            if value == workspace:
                value = None
            effective = value or workspace
            others = (set(workspaces) | set(state["labels"])) - {workspace}
            folded = unicodedata.normalize("NFC", effective).casefold()
            if any(
                folded
                in {
                    unicodedata.normalize("NFC", other).casefold(),
                    unicodedata.normalize(
                        "NFC", state["labels"].get(other, other)
                    ).casefold(),
                }
                for other in others
            ):
                raise LabelError("That label is already used by another workspace.")
            updated = dict(state["labels"])
            if value is None:
                updated.pop(workspace, None)
            else:
                updated[workspace] = value
            if updated == state["labels"]:
                return False
            state = {"version": 1, "revision": revision + 1, "labels": updated}
            data = json.dumps(state, ensure_ascii=False).encode()
            if len(data) > MAX_BYTES or len(updated) > 256:
                raise LabelError("There are too many saved workspace labels.")
            name = ".labels-" + secrets.token_hex(16)
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory,
            )
            try:
                with os.fdopen(fd, "wb", closefd=False) as output:
                    output.write(data)
                    output.flush()
                    os.fsync(fd)
                os.replace(
                    name,
                    "workspace-labels.json",
                    src_dir_fd=directory,
                    dst_dir_fd=directory,
                )
                os.fsync(directory)
            finally:
                os.close(fd)
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(name, dir_fd=directory)
            return True


AEROSPACE = "/opt/homebrew/bin/aerospace"
PROMPT = Path(__file__).resolve().with_name("workspace_label_prompt.applescript")


def edit(action, workspace, shortcut="", store=None, execute=subprocess.run):
    """Run off the selection lane; only a separate prompt lock spans human input."""
    store = store or Store()

    def call(args, timeout=8):
        return execute(
            args, capture_output=True, text=True, timeout=timeout, check=True
        ).stdout

    def inventory():
        rows = json.loads(call([AEROSPACE, "list-workspaces", "--all", "--json"]))
        if not isinstance(rows, list):
            raise LabelError("Workspace information is unavailable.")
        names = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("workspace"), str):
                raise LabelError("Workspace information is unavailable.")
            names.add(row["workspace"])
        return names

    try:
        if action not in {"rename", "reset"}:
            raise LabelError("Unknown label action.")
        with (
            store.directory() as directory,
            store.locked(directory, "prompt.lock", wait=False),
        ):
            state = store.read()
            if workspace not in inventory():
                raise LabelError("This workspace is no longer available.")
            value = None
            if action == "rename":
                answer = call(
                    [
                        "/usr/bin/osascript",
                        str(PROMPT),
                        "rename",
                        workspace,
                        state["labels"].get(workspace, workspace),
                        shortcut if shortcut.isascii() and shortcut.isdecimal() else "",
                    ],
                    timeout=190,
                )
                # Strip only the osascript record terminator, never user whitespace.
                answer = answer.removesuffix("\n")
                if answer == "CANCEL":
                    return 0
                if not answer.startswith("SAVE\n"):
                    raise LabelError("The label dialog returned an invalid response.")
                value = answer[5:]
            changed = store.update(workspace, value, inventory(), state["revision"])
            if changed:
                # Persistence succeeded even if the bar is temporarily unavailable.
                with contextlib.suppress(OSError, subprocess.SubprocessError):
                    call(["sketchybar", "--trigger", "aerospace_state_change"])
        return 0
    except BusyError:
        return 0  # Repeated clicks must not queue dialogs or error alerts.
    except (LabelError, OSError, ValueError, subprocess.SubprocessError) as error:
        message = (
            str(error)
            if isinstance(error, LabelError)
            else "Unable to complete the label operation. Check private state permissions or reopen the popup and try again."
        )
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            call(["/usr/bin/osascript", str(PROMPT), "error", message], timeout=40)
        return 1


def main(argv=None, execute=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("rename", "reset"))
    parser.add_argument("workspace")
    parser.add_argument("shortcut", nargs="?", default="")
    args = parser.parse_args(argv)
    # SketchyBar arms a 60-second alarm before exec. Replace that inherited
    # deadline with the native dialog's 180-second timeout and subprocess bounds.
    signal.alarm(0)
    return edit(
        args.action, args.workspace, args.shortcut, execute=execute or subprocess.run
    )


if __name__ == "__main__":
    raise SystemExit(main())
