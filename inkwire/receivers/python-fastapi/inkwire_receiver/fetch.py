"""A guarded media fetcher for the ``{url}`` media variant (SSRF: public http(s) hosts only).

``FileStore(fetcher=guarded_fetcher(...))`` is what ``app.py`` wires; an adapter may pass a
stricter fetch of its own. Redirects are not followed, so a public URL cannot bounce the
receiver to an internal host, and the body is capped while streaming.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

from .errors import InkwireError

DEFAULT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_TIMEOUT = 10.0
BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "metadata.google.internal"}


def _public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


async def assert_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise InkwireError("invalid_payload", "media: url must use http:// or https://")
    host = (parsed.hostname or "").strip().lower()
    if not host or host in BLOCKED_HOSTNAMES:
        raise InkwireError("invalid_payload", "media: url must point at a public host")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, parsed.port or 0, type=socket.SOCK_STREAM)
    except OSError:
        raise InkwireError("invalid_payload", "media: could not resolve the url's host") from None
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(_public_address(address) for address in addresses):
        raise InkwireError("invalid_payload", "media: url must point at a public host")


def guarded_fetcher(
    *, max_bytes: int = DEFAULT_MAX_BYTES, timeout: float = DEFAULT_TIMEOUT, client: httpx.AsyncClient | None = None
):
    """Return an async ``fetch(url) -> (bytes, filename, content_type)`` for the media store."""

    async def fetch(url: str):
        await assert_public_url(url)
        owns_client = client is None
        http = client or httpx.AsyncClient(timeout=timeout, follow_redirects=False)
        try:
            async with http.stream("GET", url) as response:
                if response.status_code >= 400:
                    raise InkwireError("invalid_payload", f"media: could not fetch the url ({response.status_code})")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise InkwireError("too_large", f"media: over the receiver's limit of {max_bytes} bytes")
                    chunks.append(chunk)
                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
            filename = urlparse(url).path.rsplit("/", 1)[-1] or "image"
            return b"".join(chunks), filename, content_type
        finally:
            if owns_client:
                await http.aclose()

    return fetch


__all__ = ["DEFAULT_MAX_BYTES", "DEFAULT_TIMEOUT", "assert_public_url", "guarded_fetcher"]
