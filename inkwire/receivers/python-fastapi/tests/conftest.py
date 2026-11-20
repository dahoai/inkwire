import asyncio
import base64
import os
import sys
from pathlib import Path

import httpx
import pytest

# The app module builds a default app on import (uvicorn app:app); keep that side-effect free.
os.environ.setdefault("INKWIRE_API_KEYS", "dev-key,audit-key:ro")
os.environ.setdefault("INKWIRE_STORE", "memory")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from inkwire_receiver.app import create_app  # noqa: E402
from inkwire_receiver import (  # noqa: E402
    InkwireConfig,
    Limits,
    MemoryStore,
    Site,
    parse_api_keys,
)

KEYS = parse_api_keys("dev-key,audit-key:ro")
FULL_KEY = "dev-key"
RO_KEY = "audit-key"

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
GIF = b"GIF89a" + b"\x00" * 32
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
AVIF = b"\x00\x00\x00\x20ftypavif" + b"\x00" * 16


def make_config(**overrides) -> InkwireConfig:
    values = dict(
        site=Site(name="Acme", url="https://acme.test"),
        kinds=["post", "page"],
        limits=Limits(markdown_bytes=1000, media_bytes=1024),
        features=["list", "get", "update", "delete", "media"],
    )
    values.update(overrides)
    return InkwireConfig(**values)


class Api:
    """Tiny sync facade over the ASGI app: one isolated request per call."""

    def __init__(self, app):
        self.app = app

    def request(self, method, path, *, key=FULL_KEY, headers=None, **kwargs):
        headers = dict(headers or {})
        if key:
            headers.setdefault("authorization", f"Bearer {key}")
        return asyncio.run(self._send(method, path, headers, kwargs))

    async def _send(self, method, path, headers, kwargs):
        transport = httpx.ASGITransport(app=self.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, headers=headers, **kwargs)

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, json=None, **kwargs):
        return self.request("POST", path, json=json, **kwargs)

    def post_raw(self, path, raw, **kwargs):
        return self.request("POST", path, content=raw, **kwargs)

    def post_media(self, files=None, data=None, **kwargs):
        return self.request("POST", "/api/media", files=files, data=data, **kwargs)

    def patch(self, path, json=None, **kwargs):
        return self.request("PATCH", path, json=json, **kwargs)

    def delete(self, path, **kwargs):
        return self.request("DELETE", path, **kwargs)


def error_code(response) -> str:
    return response.json()["error"]["code"]


@pytest.fixture
def store():
    return MemoryStore(media_url_base="https://media.test")


@pytest.fixture
def config():
    return make_config()


@pytest.fixture
def app(store, config):
    return create_app(store=store, api_keys=KEYS, config=config)


@pytest.fixture
def api(app):
    return Api(app)


@pytest.fixture
def create(api):
    """POST a valid entry and return its response body."""

    def _create(**payload):
        body = {
            "external_id": payload.pop("external_id", "ext-" + str(abs(hash(repr(payload))) % 10**8)),
            "title": payload.pop("title", "A title"),
            "markdown": payload.pop("markdown", "# Body"),
        }
        body.update(payload)
        response = api.post("/api/content", json=body)
        assert response.status_code == 200, response.text
        return response.json()

    return _create
