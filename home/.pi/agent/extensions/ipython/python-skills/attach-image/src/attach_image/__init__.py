"""Load on-disk images into model context through notebook attachments."""

import base64
from pathlib import Path

_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"
_MAX_IMAGE_BYTES = 7_000_000
_SIGNATURES = (
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
)


def _mime(data: bytes) -> str | None:
    for mime_type, prefix in _SIGNATURES:
        if data.startswith(prefix):
            return mime_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


async def run(*paths: str) -> str:
    """Attach PNG, JPEG, GIF, or WebP files so the model can see them."""
    import os

    if os.environ.get("PI_MODEL_SUPPORTS_IMAGES") != "1":
        raise RuntimeError("The current Pi model does not support image input")
    if not paths:
        raise ValueError("attach_image requires at least one image path")
    validated = []
    for path in paths:
        filepath = Path(path).expanduser()
        if not filepath.is_file():
            raise FileNotFoundError(f"{path} is not an existing regular file")
        data = filepath.read_bytes()
        if len(data) > _MAX_IMAGE_BYTES:
            raise ValueError(f"{path} exceeds the {_MAX_IMAGE_BYTES // 1_000_000}MB attachment limit")
        mime_type = _mime(data[:16])
        if mime_type is None:
            raise ValueError(f"{path} is not a supported PNG, JPEG, GIF, or WebP image")
        validated.append((filepath.resolve(), mime_type, data))

    from IPython.display import display
    for filepath, mime_type, data in validated:
        display(
            {
                _ATTACHMENT_DISPLAY_MIME: {
                    "mime_type": mime_type,
                    "data": base64.b64encode(data).decode("ascii"),
                    "path": str(filepath),
                },
                "text/plain": f"Loaded image into context: {filepath}",
            },
            raw=True,
        )
    return f"Loaded {len(validated)} image(s) into context: {', '.join(paths)}"


__all__ = ["run"]
