"""Materialize managed Codex roles as regular files, which native dispatch requires."""

import argparse
import os
from pathlib import Path
import tempfile
import tomllib


def install(source: Path, destination: Path) -> None:
    roles = sorted(source.glob("*.toml"))
    if not roles:
        raise ValueError(f"No role definitions found in {source}")
    # Validate the whole source set before replacing any installed role.
    for role in roles:
        data = tomllib.loads(role.read_text())
        if data.get("name") != role.stem or not all(
            isinstance(data.get(key), str) and data[key].strip()
            for key in ("name", "description", "developer_instructions")
        ):
            raise ValueError(f"Invalid standalone role definition: {role}")
        target = destination / role.name
        if target.is_symlink() and target.resolve() != role.resolve():
            raise ValueError(f"Refusing to replace an unrelated symlink: {target}")
        if target.exists() and not target.is_file():
            raise ValueError(f"Role destination is not a file: {target}")

    destination.mkdir(parents=True, exist_ok=True)
    for role in roles:
        target = destination / role.name
        content = role.read_bytes()
        if not target.is_symlink() and target.is_file() and target.read_bytes() == content:
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=f".{role.name}.", dir=destination)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        print(f"Installed Codex role: {role.stem}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    arguments = parser.parse_args()
    install(arguments.source, arguments.destination)
