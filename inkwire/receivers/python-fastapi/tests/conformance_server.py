"""The receiver the black-box conformance run talks to.

    uvicorn tests.conformance_server:app --port 4010
    INKWIRE_CONFORMANCE_STORE=memory uvicorn tests.conformance_server:app --port 4010

A FileStore in a throw-away directory (the run must see the real frontmatter / media
sidecar code), or a MemoryStore when ``INKWIRE_CONFORMANCE_STORE=memory``; two keys (``dev-key`` read-write,
``audit-key`` read-only), kinds ``post`` and ``page``, and limits small enough that the
runner's ``$overLimit`` cases stay cheap.

The media ``{url}`` variant is stubbed: the runner sends
``https://example.test/imgs/ok.png``, which is unregistrable by design, so the guarded
fetcher is replaced by a fake that answers with one PNG. Everything else — validation,
SVG refusal, the byte cap — is the real code.
"""

from __future__ import annotations

import os
import tempfile

from tests.conftest import PNG

os.environ.setdefault("INKWIRE_SITE_NAME", "Conformance")
os.environ.setdefault("INKWIRE_SITE_URL", "https://conformance.test")
os.environ.setdefault("INKWIRE_MEDIA_URL_BASE", "/inkwire-media")

from inkwire_receiver import FileStore, InkwireConfig, InkwireError, Limits, MemoryStore, Site  # noqa: E402
from inkwire_receiver.app import create_app  # noqa: E402

MARKDOWN_LIMIT = 100_000
MEDIA_LIMIT = 10_000


async def stub_fetcher(url: str):
    """Answer any URL the runner uses with a real 1×1 PNG; keep the scheme check honest."""
    if not url.startswith(("http://", "https://")):
        raise InkwireError("invalid_payload", "media: url must use http:// or https://")
    return PNG, url.rsplit("/", 1)[-1] or "image", "image/png"


if os.environ.get("INKWIRE_CONFORMANCE_STORE", "file") == "memory":
    store = MemoryStore(media_url_base="/inkwire-media", fetcher=stub_fetcher)
else:
    store = FileStore(tempfile.mkdtemp(prefix="inkwire-conformance-"), fetcher=stub_fetcher, max_media_bytes=MEDIA_LIMIT)

app = create_app(
    store=store,
    api_keys="dev-key,audit-key:ro",
    config=InkwireConfig(
        site=Site(name="Conformance", url="https://conformance.test"),
        kinds=["post", "page"],
        limits=Limits(markdown_bytes=MARKDOWN_LIMIT, media_bytes=MEDIA_LIMIT),
    ),
)
