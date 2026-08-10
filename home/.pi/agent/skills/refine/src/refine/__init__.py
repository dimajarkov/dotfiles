"""Queue continual harness refinement requests for the Pi host."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _request_path() -> Path:
    value = os.environ.get("PI_REFINEMENT_REQUEST_FILE")
    if not value:
        raise RuntimeError("refine is available only inside a Pi IPython session")
    return Path(value).expanduser()


def _read() -> dict[str, Any] | None:
    path = _request_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _write(value: dict[str, Any]) -> None:
    path = _request_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


async def status() -> dict[str, Any]:
    """Return the queued refinement state."""
    request = _read()
    return {"pending": bool(request and request.get("pending")), "in_flight": False, "request": request}


async def run(instructions: str | None = None, global_: bool = False) -> dict[str, Any]:
    """Queue one refinement request for the Pi host to process at turn end."""
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(f"instructions must be str or None, got {type(instructions).__name__}")
    if not isinstance(global_, bool):
        raise TypeError(f"global_ must be bool, got {type(global_).__name__}")
    current = _read() or {}
    current.update({"pending": True, "instructions": instructions, "global": global_})
    _write(current)
    return {"scheduled": True}


def cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Queue a Pi continual refinement")
    parser.add_argument("instructions", nargs="?")
    parser.add_argument("--global", dest="global_", action="store_true")
    args = parser.parse_args()
    print(asyncio.run(run(args.instructions, args.global_)))
