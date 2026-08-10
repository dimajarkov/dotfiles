"""Exact single-occurrence replacement with atomic writes and structured diffs."""

import os
import tempfile
from pathlib import Path

_DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json"


def _identity(stat_result):
    return (stat_result.st_dev, stat_result.st_ino, stat_result.st_size, stat_result.st_mtime_ns)


async def run(path: str, old_str: str, new_str: str) -> str:
    """Replace exactly one occurrence and emit a structured diff."""
    if old_str == "":
        raise ValueError("old_str must not be empty")
    requested = Path(path).expanduser()
    try:
        filepath = requested.resolve(strict=True)
    except FileNotFoundError:
        raise FileNotFoundError(f"{path} is not an existing regular file") from None
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    before = filepath.stat()
    raw = filepath.read_bytes()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{path} is not a UTF-8 text file") from error
    count = content.count(old_str)
    if count == 0:
        raise ValueError(f"string not found in {path}")
    if count > 1:
        raise ValueError(
            f"found {count} occurrences in {path}, need exactly 1 - "
            "widen the snippet to make it unique"
        )

    match_index = content.index(old_str)
    replacement = content[:match_index] + new_str + content[match_index + len(old_str):]
    start_line = content.count("\n", 0, match_index) + 1
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=f".{filepath.name}.", dir=filepath.parent)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(replacement.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, before.st_mode)
        if _identity(filepath.stat()) != _identity(before):
            raise RuntimeError(f"{path} changed while it was being edited; no replacement was made")
        os.replace(temporary, filepath)
        temporary = None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    resolved = str(filepath)
    try:
        from IPython.display import display
        display(
            {
                _DIFF_DISPLAY_MIME: {
                    "version": 1,
                    "path": resolved,
                    "old_str": old_str,
                    "new_str": new_str,
                    "start_line": start_line,
                },
                "text/plain": f"Edited {resolved}",
            },
            raw=True,
        )
    except Exception:
        pass
    return f"Edited {resolved}"


__all__ = ["run"]
