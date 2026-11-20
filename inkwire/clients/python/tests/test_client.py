import json
import httpx
import pytest

from inkwire_client import (
    InkwireClientError,
    capabilities,
    edits,
    get,
    list as list_content,
    publish,
    remove,
    update,
    upload_media,
)


def make_transport(responses):
    calls = {"n": 0, "requests": []}

    def handler(request):
        i = min(calls["n"], len(responses) - 1)
        calls["n"] += 1
        calls["requests"].append(request)
        status, body = responses[i][:2]
        headers = responses[i][2] if len(responses[i]) > 2 else {"inkwire-version": "1"}
        if isinstance(body, bytes):
            return httpx.Response(status, content=body, headers=headers)
        return httpx.Response(status, json=body, headers=headers)

    return httpx.MockTransport(handler), calls


def test_publish_ok(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:1", "external_id": "e", "url": "u", "slug": "s", "status": "published", "created": True})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    r = publish("https://site.test", "k", {"external_id": "e", "title": "T", "markdown": "x"}, retries=1)
    assert r["created"] is True
    assert calls["requests"][0].url.path == "/api/content"


def test_publish_sends_seo_unchanged(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:1", "external_id": "e", "url": "u", "slug": "s", "status": "draft", "created": True})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    seo = {"title": "Search title", "description": "Search description", "image_url": "https://images.test/og.jpg", "noindex": True}
    publish("https://site.test", "k", {"external_id": "e", "title": "T", "markdown": "x", "seo": seo}, retries=1)
    assert json.loads(calls["requests"][0].content)["seo"] == seo


def test_retry_then_success(monkeypatch):
    transport, calls = make_transport([(500, {}), (200, {"id": "post:1", "external_id": "e", "url": "u", "slug": "s", "status": "draft", "created": True})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    r = publish("https://site.test", "k", {"external_id": "e", "title": "T", "markdown": "x"}, retries=3)
    assert r["id"] == "post:1" and calls["n"] == 2


def test_401_raises(monkeypatch):
    transport, calls = make_transport([(401, {"error": {"code": "unauthorized", "message": "no"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as ei:
        publish("https://site.test", "bad", {"external_id": "e", "title": "T", "markdown": "x"})
    assert ei.value.code == "unauthorized" and calls["n"] == 1


def test_retries_zero_makes_one_request(monkeypatch):
    transport, calls = make_transport([(500, {"error": {"code": "server_error", "message": "Internal Server Error"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as ei:
        publish("https://site.test", "k", {"external_id": "e", "title": "T", "markdown": "x"}, retries=0)
    assert ei.value.code == "server_error"
    assert ei.value.http_status == 500
    assert calls["n"] == 1


def test_capabilities_ok(monkeypatch):
    data = {"inkwire": 1, "features": ["upsert", "list"], "kinds": ["post", "page"], "limits": {"markdown_bytes": 1000}}
    transport, calls = make_transport([(200, data)])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    cap = capabilities("https://site.test", "k")
    assert cap["features"] == ["upsert", "list"]
    assert calls["requests"][0].url.path == "/api/inkwire"


def test_capabilities_fallback_on_404(monkeypatch):
    transport, calls = make_transport([(404, {"error": {"code": "not_found", "message": "not found"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    cap = capabilities("https://site.test", "k")
    assert cap == {"features": ["upsert"], "kinds": ["post"], "limits": {}}


def test_list_query_params(monkeypatch):
    transport, calls = make_transport([(200, {"items": [], "next_cursor": None})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    res = list_content("https://site.test", "k", kind="post", status="published", limit=10, search="test")
    assert res == {"items": [], "next_cursor": None}
    req = calls["requests"][0]
    assert req.url.path == "/api/content"
    query = dict(req.url.params)
    assert query["kind"] == "post"
    assert query["status"] == "published"
    assert query["limit"] == "10"
    assert query["search"] == "test"


def test_get_with_etag(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:p-1", "title": "Post 1"}, {"etag": '"etag-123"'})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    item, etag = get("https://site.test", "k", "post:p-1")
    assert item["title"] == "Post 1"
    assert etag == '"etag-123"'
    assert calls["requests"][0].url.raw_path == b"/api/content/post%3Ap-1"


def test_update_with_if_match_and_stale(monkeypatch):
    transport, calls = make_transport([
        (200, {"id": "post:p-1", "title": "Updated"}, {"etag": '"etag-456"'}),
        (412, {"error": {"code": "stale", "message": "stale ETag"}}),
    ])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    item, etag = update("https://site.test", "k", "post:p-1", {"title": "Updated"}, if_match='"etag-123"')
    assert item["title"] == "Updated"
    assert etag == '"etag-456"'
    assert calls["requests"][0].headers["if-match"] == '"etag-123"'

    with pytest.raises(InkwireClientError) as ei:
        update("https://site.test", "k", "post:p-1", {"title": "Racer"}, if_match='"stale-etag"')
    assert ei.value.code == "stale"
    assert ei.value.http_status == 412


def test_remove_ok(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:p-1", "deleted": True})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    res = remove("https://site.test", "k", "post:p-1", if_match='"etag-123"')
    assert res == {"id": "post:p-1", "deleted": True}
    assert calls["requests"][0].method == "DELETE"
    assert calls["requests"][0].headers["if-match"] == '"etag-123"'


def test_upload_media_json(monkeypatch):
    transport, calls = make_transport([(200, {"id": "m-1", "url": "https://site.test/media/img.png", "alt": "A photo"})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    res = upload_media("https://site.test", "k", url="https://ext.test/pic.png", alt="A photo")
    assert res["id"] == "m-1"
    assert calls["requests"][0].url.path == "/api/media"
    assert json.loads(calls["requests"][0].content) == {"url": "https://ext.test/pic.png", "alt": "A photo"}


def test_upload_media_multipart(monkeypatch):
    transport, calls = make_transport([(200, {"id": "m-2", "url": "https://site.test/media/bytes.png", "alt": "Uploaded"})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    png_bytes = b"\x89PNG\r\n\x1a\n"
    res = upload_media("https://site.test", "k", data=(png_bytes, "photo.png", "image/png"), alt="Uploaded")
    assert res["id"] == "m-2"
    assert "multipart/form-data" in calls["requests"][0].headers["content-type"]


def test_edits_helper():
    original = "Hello world! This is a test."
    modified = edits(original, [{"find": "world", "replace": "universe"}])
    assert modified == "Hello universe! This is a test."

    with pytest.raises(InkwireClientError) as ei1:
        edits(original, [{"find": "", "replace": "something"}])
    assert ei1.value.code == "edit_not_found"

    with pytest.raises(InkwireClientError) as ei2:
        edits(original, [{"find": "nonexistent", "replace": "something"}])
    assert ei2.value.code == "edit_not_found"

    with pytest.raises(InkwireClientError) as ei3:
        edits("repeat repeat repeat", [{"find": "repeat", "replace": "once"}])
    assert ei3.value.code == "edit_ambiguous"
