import pytest

import asyncio

from inkwire_receiver import InkwireError, Limits, MemoryStore, assert_public_url, sniff_image
from tests.conftest import KEYS, PNG, AVIF, GIF, JPEG, SVG, WEBP, Api, create_app, error_code, make_config


def media_app(**store_kwargs):
    store = MemoryStore(media_url_base="https://media.test", **store_kwargs)
    return Api(create_app(store=store, api_keys=KEYS, config=make_config())), store


def test_multipart_png_upload(api):
    response = api.post_media(files={"file": ("px.png", PNG, "image/png")}, data={"alt": "One pixel"})
    assert response.status_code == 200
    body = response.json()
    assert body["id"]
    assert body["url"].startswith("https://media.test/")
    assert body["url"].endswith(".png")
    assert body["alt"] == "One pixel"


def test_multipart_without_alt_omits_it(api):
    response = api.post_media(files={"file": ("px.png", PNG, "image/png")})
    assert response.status_code == 200
    assert "alt" not in response.json()


def test_every_allowed_image_type_is_accepted(api):
    for name, data, content_type in (
        ("a.jpg", JPEG, "image/jpeg"),
        ("a.png", PNG, "image/png"),
        ("a.gif", GIF, "image/gif"),
        ("a.webp", WEBP, "image/webp"),
        ("a.avif", AVIF, "image/avif"),
    ):
        response = api.post_media(files={"file": (name, data, content_type)})
        assert response.status_code == 200, (name, response.text)
        assert response.json()["url"].split(".")[-1] in ("jpg", "png", "gif", "webp", "avif")


def test_svg_is_refused_by_name_type_and_content(api):
    by_name = api.post_media(files={"file": ("x.svg", PNG, "image/png")})
    by_type = api.post_media(files={"file": ("x.png", PNG, "image/svg+xml")})
    by_content = api.post_media(files={"file": ("x.png", SVG, "image/png")})
    xml_header = api.post_media(files={"file": ("x.png", b'<?xml version="1.0"?><svg/>', "image/png")})
    for response in (by_name, by_type, by_content, xml_header):
        assert response.status_code == 400, response.text
        assert error_code(response) == "invalid_payload"


def test_non_image_content_is_refused(api):
    text = api.post_media(files={"file": ("notes.png", b"just some text, not an image", "image/png")})
    wrong_type = api.post_media(files={"file": ("a.png", PNG, "application/octet-stream")})
    for response in (text, wrong_type):
        assert response.status_code == 400
        assert error_code(response) == "invalid_payload"


def test_media_over_the_limit_is_413():
    app = create_app(
        store=MemoryStore(media_url_base="https://media.test"),
        api_keys=KEYS,
        config=make_config(limits=Limits(markdown_bytes=1000, media_bytes=8)),
    )
    api = Api(app)
    response = api.post_media(files={"file": ("px.png", PNG, "image/png")})
    assert response.status_code == 413
    assert error_code(response) == "too_large"


def test_json_url_variant_fetches_through_the_store():
    async def fake_fetch(url):
        assert url == "https://example.test/imgs/ok.png"
        return PNG, "ok.png", "image/png"

    api, store = media_app(fetcher=fake_fetch)
    response = api.post("/api/media", json={"url": "https://example.test/imgs/ok.png", "alt": "An image"})
    assert response.status_code == 200
    body = response.json()
    assert body["alt"] == "An image"
    assert body["url"].startswith("https://media.test/")
    assert store.media_bytes(body["id"])


def test_json_url_variant_rejects_javascript_urls(api):
    response = api.post("/api/media", json={"url": "javascript:alert(1)"})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_json_url_variant_rejects_unknown_fields(api):
    response = api.post("/api/media", json={"url": "https://example.test/a.png", "bogus": 1})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_a_failed_fetch_is_a_clean_invalid_payload():
    async def broken_fetch(url):
        raise RuntimeError("no network in tests")

    api, _ = media_app(fetcher=broken_fetch)
    response = api.post("/api/media", json={"url": "https://example.test/a.png"})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_a_store_without_media_support_says_so():
    class PlainStore(MemoryStore):
        async def media(self, key, upload):  # pragma: no cover - never reached
            raise AssertionError("should not be called")

    store = PlainStore()
    store.media = None  # type: ignore[assignment]
    api = Api(create_app(store=store, api_keys=KEYS, config=make_config()))
    response = api.post_media(files={"file": ("px.png", PNG, "image/png")})
    assert response.status_code == 500
    assert error_code(response) == "internal"


def test_read_only_key_cannot_upload(api):
    response = api.post_media(files={"file": ("px.png", PNG, "image/png")}, key="audit-key")
    assert response.status_code == 403
    assert error_code(response) == "forbidden"


def test_sniffing_magic_bytes():
    assert sniff_image(PNG) == "image/png"
    assert sniff_image(JPEG) == "image/jpeg"
    assert sniff_image(GIF) == "image/gif"
    assert sniff_image(WEBP) == "image/webp"
    assert sniff_image(AVIF) == "image/avif"
    assert sniff_image(SVG) is None
    assert sniff_image(b"short") is None


def test_the_guarded_fetcher_rejects_internal_hosts():
    for url in (
        "http://127.0.0.1/a.png",
        "http://localhost/a.png",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/a.png",
        "http://[::1]/a.png",
        "ftp://example.test/a.png",
        "https://metadata.google.internal/x",
    ):
        with pytest.raises(InkwireError):
            asyncio.run(assert_public_url(url))
