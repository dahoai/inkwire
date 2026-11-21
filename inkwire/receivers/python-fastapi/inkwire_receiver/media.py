"""Image validation for media uploads: content type AND magic bytes, never SVG."""

from __future__ import annotations

from .errors import InkwireError

IMAGE_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
}
EXTENSIONS = {"jpg": "jpg", "jpeg": "jpg", "png": "png", "gif": "gif", "webp": "webp", "avif": "avif"}
SVG_TYPES = {"image/svg+xml", "image/svg"}


def sniff_image(data: bytes) -> str | None:
    """Return the image content type the magic bytes prove, or ``None``."""
    if len(data) < 12:
        return None
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a") or data.startswith(b"GIF"):
        return "image/gif"
    if data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        compatible = data[8:40]
        if brand in (b"avif", b"avis") or b"avif" in compatible or b"avis" in compatible:
            return "image/avif"
    return None


def image_size(data: bytes, mime: str) -> tuple[int, int] | None:
    """Width and height in pixels from the file's header, or ``None`` (same rules as the TS core)."""

    def ok(w: int, h: int) -> tuple[int, int] | None:
        return (w, h) if w > 0 and h > 0 else None

    u16le = lambda i: int.from_bytes(data[i : i + 2], "little")  # noqa: E731
    u16be = lambda i: int.from_bytes(data[i : i + 2], "big")  # noqa: E731
    u24le = lambda i: int.from_bytes(data[i : i + 3], "little")  # noqa: E731
    u32be = lambda i: int.from_bytes(data[i : i + 4], "big")  # noqa: E731
    if mime == "image/png" and len(data) >= 24 and data[12:16] == b"IHDR":
        return ok(u32be(16), u32be(20))
    if mime == "image/gif" and len(data) >= 10:
        return ok(u16le(6), u16le(8))
    if mime == "image/webp" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8 ":
            return ok(u16le(26) & 0x3FFF, u16le(28) & 0x3FFF)
        if chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return ok((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if chunk == b"VP8X":
            return ok(u24le(24) + 1, u24le(27) + 1)
    if mime == "image/jpeg":
        i = 2
        while i + 9 <= len(data):
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if marker == 0xFF:
                i += 1
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD8:
                i += 2
                continue
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return ok(u16be(i + 7), u16be(i + 5))
            i += 2 + u16be(i + 2)
    if mime == "image/avif":
        at = data.find(b"ispe", 0, 65_536)
        if at >= 4 and at + 16 <= len(data):
            return ok(u32be(at + 8), u32be(at + 12))
    return None


def looks_like_svg(data: bytes, filename: str | None = None, content_type: str | None = None) -> bool:
    """SVG is refused by name, by declared type and by content."""
    name = (filename or "").lower()
    if name.endswith(".svg") or name.endswith(".svgz"):
        return True
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared in SVG_TYPES:
        return True
    head = data[:512].lstrip().lower()
    return head.startswith(b"<svg") or head.startswith(b"<?xml") or b"<svg" in head


def validate_image(
    data: bytes, *, filename: str | None = None, content_type: str | None = None, require_declared: bool = False
) -> str:
    """Check an upload and return the canonical content type (jpg/png/gif/webp/avif)."""
    if looks_like_svg(data, filename, content_type):
        raise InkwireError("invalid_payload", "media: SVG is not accepted")
    sniffed = sniff_image(data)
    if sniffed is None:
        raise InkwireError(
            "invalid_payload", "media: only jpeg, png, gif, webp and avif images are accepted"
        )
    declared = (content_type or "").split(";")[0].strip().lower()
    if require_declared:
        if declared not in IMAGE_TYPES:
            raise InkwireError(
                "invalid_payload",
                f"media: unsupported content type '{declared or 'unknown'}' "
                "(expected image/jpeg, image/png, image/gif, image/webp or image/avif)",
            )
    elif declared in SVG_TYPES:
        raise InkwireError("invalid_payload", "media: SVG is not accepted")
    elif declared.startswith("image/") and declared not in IMAGE_TYPES:
        raise InkwireError("invalid_payload", f"media: unsupported content type '{declared}'")
    return sniffed


def extension_for(content_type: str, filename: str | None = None) -> str:
    name = (filename or "").lower()
    suffix = name.rsplit(".", 1)[-1] if "." in name else ""
    if suffix in EXTENSIONS:
        return EXTENSIONS[suffix]
    return IMAGE_TYPES.get((content_type or "").split(";")[0].strip().lower(), "img")


__all__ = [
    "EXTENSIONS",
    "IMAGE_TYPES",
    "SVG_TYPES",
    "extension_for",
    "looks_like_svg",
    "sniff_image",
    "validate_image",
]
