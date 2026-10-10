#!/usr/bin/env python3
"""Safely move ~/.agents/skills onto the writable dotfiles skill directory."""

from __future__ import annotations

import argparse
import ctypes
import errno
import os
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Sequence


class MigrationError(Exception):
    """A safe migration could not be completed."""


def _is_ignored_cache(name: str, entry_stat: os.stat_result) -> bool:
    if name in {".DS_Store", "__pycache__"}:
        return True
    return stat.S_ISREG(entry_stat.st_mode) and name.endswith((".pyc", ".pyo"))


def _same_bytes(left: Path, right: Path) -> bool:
    with left.open("rb") as left_file, right.open("rb") as right_file:
        while True:
            left_chunk = left_file.read(1024 * 1024)
            right_chunk = right_file.read(1024 * 1024)
            if left_chunk != right_chunk:
                return False
            if not left_chunk:
                return True


def _is_managed_child_link(source: Path, canonical_root: Path, child_name: str) -> bool:
    canonical_child = canonical_root / child_name
    try:
        child_stat = canonical_child.lstat()
        if not stat.S_ISDIR(child_stat.st_mode):
            return False
        return source.resolve(strict=True) == canonical_child.resolve(strict=True)
    except (OSError, RuntimeError):
        return False


def _same_symlink_target(
    source: Path,
    canonical: Path,
    source_root: Path,
    canonical_root: Path,
) -> bool:
    try:
        source_target = source.resolve(strict=False)
        canonical_target = canonical.resolve(strict=False)
        source_root_resolved = source_root.resolve(strict=True)
        source_relative_target = source_target.relative_to(source_root_resolved)
    except (OSError, RuntimeError):
        return False
    except ValueError:
        return source_target == canonical_target
    return (canonical_root / source_relative_target).resolve(
        strict=False
    ) == canonical_target


def _compare_tree(
    source_root: Path,
    canonical_root: Path,
    source_dir: Path,
    canonical_dir: Path,
    relative: Path = Path(),
) -> None:
    try:
        with os.scandir(source_dir) as scanner:
            entries = sorted(scanner, key=lambda entry: entry.name)
    except OSError as error:
        raise MigrationError(f"Cannot inspect {source_dir}: {error}") from error

    for entry in entries:
        source = Path(entry.path)
        child_relative = relative / entry.name
        display_path = child_relative.as_posix()
        try:
            source_stat = source.lstat()
        except OSError as error:
            raise MigrationError(
                f"Cannot inspect local path {display_path}: {error}"
            ) from error

        if _is_ignored_cache(entry.name, source_stat):
            continue
        if (
            not relative.parts
            and stat.S_ISLNK(source_stat.st_mode)
            and _is_managed_child_link(source, canonical_root, entry.name)
        ):
            continue

        canonical = canonical_dir / entry.name
        try:
            canonical_stat = canonical.lstat()
        except OSError as error:
            raise MigrationError(
                f"Local path {display_path} is missing from the canonical skills "
                "directory"
            ) from error

        if stat.S_ISDIR(source_stat.st_mode):
            if not stat.S_ISDIR(canonical_stat.st_mode):
                raise MigrationError(
                    f"Local directory {display_path} is not a directory in the "
                    "canonical skills directory"
                )
            _compare_tree(
                source_root, canonical_root, source, canonical, child_relative
            )
        elif stat.S_ISREG(source_stat.st_mode):
            if not stat.S_ISREG(canonical_stat.st_mode):
                raise MigrationError(
                    f"Local file {display_path} is not a regular file in the "
                    "canonical skills directory"
                )
            if (stat.S_IMODE(source_stat.st_mode) & 0o111) != (
                stat.S_IMODE(canonical_stat.st_mode) & 0o111
            ):
                raise MigrationError(
                    f"Executable mode differs for local file {display_path}"
                )
            try:
                matches = _same_bytes(source, canonical)
            except OSError as error:
                raise MigrationError(
                    f"Cannot compare local file {display_path}: {error}"
                ) from error
            if not matches:
                raise MigrationError(
                    f"File contents differ for local file {display_path}"
                )
        elif stat.S_ISLNK(source_stat.st_mode):
            if not stat.S_ISLNK(canonical_stat.st_mode):
                raise MigrationError(
                    f"Local symlink {display_path} is not a symlink in the canonical "
                    "skills directory"
                )
            try:
                source_target = os.readlink(source)
                canonical_target = os.readlink(canonical)
            except OSError as error:
                raise MigrationError(
                    f"Cannot compare local symlink {display_path}: {error}"
                ) from error
            if source_target != canonical_target or not _same_symlink_target(
                source, canonical, source_root, canonical_root
            ):
                raise MigrationError(
                    f"Symlink targets differ for local path {display_path}"
                )
        else:
            raise MigrationError(
                f"Unsupported local filesystem entry at {display_path}; "
                "only files, directories, and symlinks can be checked"
            )


def _rename_without_replacing(source: Path, destination: Path) -> None:
    """Atomically rename without replacing a concurrently-created destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)

    if sys.platform == "darwin":
        rename_exclusive = getattr(libc, "renamex_np", None)
        if rename_exclusive is None:
            raise OSError(errno.ENOTSUP, "renamex_np is unavailable")
        rename_exclusive.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename_exclusive.restype = ctypes.c_int
        result = rename_exclusive(source_bytes, destination_bytes, 0x00000004)
    elif sys.platform.startswith("linux"):
        rename_exclusive = getattr(libc, "renameat2", None)
        if rename_exclusive is None:
            raise OSError(errno.ENOTSUP, "renameat2 is unavailable")
        rename_exclusive.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        rename_exclusive.restype = ctypes.c_int
        result = rename_exclusive(-100, source_bytes, -100, destination_bytes, 1)
    else:
        raise OSError(errno.ENOTSUP, "atomic no-replace rename is unsupported here")

    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), str(destination))


def _backup_candidate(live_dir: Path) -> Path:
    timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    suffix = secrets.token_hex(4)
    return live_dir.with_name(f"{live_dir.name}.backup-{timestamp}-{suffix}")


def _restore_backup(backup: Path, live_dir: Path) -> str | None:
    try:
        _rename_without_replacing(backup, live_dir)
    except OSError as error:
        return f"Could not restore the original directory without overwriting {live_dir}: {error}"
    return None


def _validate_canonical(canonical_dir: Path) -> Path:
    try:
        canonical = canonical_dir.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MigrationError(
            f"Canonical skills directory does not exist: {canonical_dir}"
        ) from error
    if not canonical.is_dir():
        raise MigrationError(
            f"Canonical skills path is not a directory: {canonical_dir}"
        )
    return canonical


def _migrate(live_dir: Path, canonical_dir: Path, dry_run: bool) -> None:
    canonical = _validate_canonical(canonical_dir)

    if os.path.lexists(live_dir) and live_dir.is_symlink():
        try:
            existing_target = live_dir.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise MigrationError(
                f"Skills path is a broken symlink: {live_dir}"
            ) from error
        if existing_target == canonical:
            print(f"Skills directory already points to {canonical}")
            return
        raise MigrationError(
            f"Refusing to replace unrelated skills symlink {live_dir} -> "
            f"{os.readlink(live_dir)}"
        )

    if os.path.lexists(live_dir) and not live_dir.is_dir():
        raise MigrationError(f"Skills path exists but is not a directory: {live_dir}")

    if live_dir.resolve(strict=False).is_relative_to(canonical):
        raise MigrationError(
            "The live skills path is inside the canonical directory or is the "
            "canonical directory itself; refusing to create a recursive link"
        )

    if os.path.lexists(live_dir):
        live_resolved = live_dir.resolve(strict=True)
        if live_resolved == canonical:
            raise MigrationError(
                "The live skills directory is the canonical directory itself; "
                "refusing to move it"
            )
        try:
            canonical.relative_to(live_resolved)
        except ValueError:
            pass
        else:
            raise MigrationError(
                "The canonical skills directory is inside the live skills directory; "
                "refusing to move it"
            )
        _compare_tree(live_dir, canonical, live_dir, canonical)
    elif os.path.lexists(live_dir.parent) and not live_dir.parent.is_dir():
        raise MigrationError(
            f"Skills parent path is not a directory: {live_dir.parent}"
        )

    if dry_run:
        if os.path.lexists(live_dir):
            backup = _backup_candidate(live_dir)
            print(f"Would preserve the original directory at {backup}")
        print(f"Would link {live_dir} -> {canonical}")
        return

    live_dir.parent.mkdir(parents=True, exist_ok=True)
    if not os.path.lexists(live_dir):
        os.symlink(canonical, live_dir)
        print(f"Linked skills directory: {live_dir} -> {canonical}")
        return

    backup = None
    for _ in range(10):
        candidate = _backup_candidate(live_dir)
        try:
            _rename_without_replacing(live_dir, candidate)
        except FileExistsError:
            continue
        backup = candidate
        break
    if backup is None:
        raise MigrationError(
            "Could not allocate a unique backup path after 10 attempts"
        )

    try:
        _compare_tree(backup, canonical, backup, canonical)
    except MigrationError as error:
        restore_error = _restore_backup(backup, live_dir)
        if restore_error:
            raise MigrationError(
                f"{error}. Original data remains at {backup}. {restore_error}"
            ) from error
        raise MigrationError(f"{error}. Original directory was restored.") from error

    try:
        os.symlink(canonical, live_dir)
    except OSError as error:
        restore_error = _restore_backup(backup, live_dir)
        if restore_error:
            raise MigrationError(
                f"Could not create skills symlink: {error}. Original data remains at "
                f"{backup}. {restore_error}"
            ) from error
        raise MigrationError(
            f"Could not create skills symlink: {error}. Original directory was restored."
        ) from error

    print(f"Linked skills directory: {live_dir} -> {canonical}")
    print(f"Original directory preserved at: {backup}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("live_dir", type=Path, help="live ~/.agents/skills path")
    parser.add_argument("canonical_dir", type=Path, help="dotfiles skills directory")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="check the migration without changing the filesystem",
    )
    arguments = parser.parse_args(argv)
    live_dir = Path(os.path.abspath(os.path.expanduser(arguments.live_dir)))

    try:
        _migrate(live_dir, arguments.canonical_dir.expanduser(), arguments.dry_run)
    except (MigrationError, OSError) as error:
        print(f"migrate-agent-skills: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
