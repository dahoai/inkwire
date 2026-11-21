import json
import httpx
import pytest

from inkwire_client import (
    InkwireClientError,
    capabilities,
    edits,
    UNSET,
    get,
    list as list_content,
    list_media,
    publish,
    remove,
    restore,
    revision,
    revisions,
    terms,
    update,
    update_media,
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


def test_revisions_and_restore(monkeypatch):
    transport, calls = make_transport([
        (200, {"items": [{"revision": "r1", "replaced_by": "update"}]}),
        (200, {"revision": "r1", "entry": {"title": "Old"}}),
        (200, {"id": "post.p", "title": "Old"}, {"etag": '"e2"'}),
    ])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    assert revisions("https://site.test", "k", "post.p")["items"][0]["revision"] == "r1"
    assert revision("https://site.test", "k", "post.p", "r1")["entry"]["title"] == "Old"
    item, etag = restore("https://site.test", "k", "post.p", "r1", if_match='"e1"')
    assert (item["title"], etag) == ("Old", '"e2"')
    r = calls["requests"]
    assert [x.url.raw_path for x in r] == [b"/api/content/post.p/revisions", b"/api/content/post.p/revisions/r1", b"/api/content/post.p/restore"]
    assert r[2].method == "POST" and r[2].headers["if-match"] == '"e1"'
    assert json.loads(r[2].content) == {"revision": "r1"}


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


def test_publish_sends_the_new_content_fields_unchanged(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:1", "external_id": "e", "url": "u", "slug": "s", "status": "draft", "created": True})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    payload = {
        "external_id": "e",
        "title": "T",
        "markdown": "x",
        "categories": ["Guides"],
        "cover_image_url": "https://images.test/c.jpg",
        "cover_image_alt": "A red bicycle",
        "seo": {
            "og_title": "Card title",
            "og_description": "Card description",
            "json_ld": '{"@type":"FAQPage"}',
        },
    }
    publish("https://site.test", "k", payload, retries=1)
    assert json.loads(calls["requests"][0].content) == payload


def test_update_sends_nulls_to_clear(monkeypatch):
    transport, calls = make_transport([(200, {"id": "post:p-1"}, {"etag": '"e2"'})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    patch = {"categories": None, "cover_image_alt": None, "seo": {"json_ld": None, "og_title": "Keep"}}
    update("https://site.test", "k", "post:p-1", patch)
    assert json.loads(calls["requests"][0].content) == patch


def test_list_filters_by_category(monkeypatch):
    transport, calls = make_transport([(200, {"items": [], "next_cursor": None})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    list_content("https://site.test", "k", category="Guides", tag="seo", cursor="abc", external_id="e", slug="s")
    query = dict(calls["requests"][0].url.params)
    assert query == {"category": "Guides", "tag": "seo", "cursor": "abc", "external_id": "e", "slug": "s"}


def test_list_leaves_out_filters_that_were_not_given(monkeypatch):
    transport, calls = make_transport([(200, {"items": [], "next_cursor": None})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    list_content("https://site.test", "k")
    assert dict(calls["requests"][0].url.params) == {}


def test_capabilities_pass_the_site_description_and_language_through(monkeypatch):
    data = {
        "inkwire": 1,
        "site": {"name": "Acme", "url": "https://acme.test", "description": "Acme's blog", "language": "en"},
        "features": ["upsert", "terms", "media_list"],
        "kinds": ["post"],
    }
    transport, _ = make_transport([(200, data)])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    cap = capabilities("https://site.test", "k")
    assert cap["site"]["description"] == "Acme's blog" and cap["site"]["language"] == "en"
    assert cap["limits"] == {}


def test_terms_without_filters(monkeypatch):
    items = [{"kind": "tag", "name": "SEO", "slug": "seo", "count": 12}]
    transport, calls = make_transport([(200, {"items": items})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    result = terms("https://site.test", "k")
    assert result == {"items": items}
    request = calls["requests"][0]
    assert request.method == "GET" and request.url.path == "/api/terms"
    assert dict(request.url.params) == {}
    assert request.headers["authorization"] == "Bearer k"


def test_terms_with_filters(monkeypatch):
    transport, calls = make_transport([(200, {"items": []})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    terms("https://site.test", "k", kind="category", search="gui", limit=5)
    assert dict(calls["requests"][0].url.params) == {"kind": "category", "search": "gui", "limit": "5"}


def test_terms_raises_a_typed_error_for_a_bad_kind(monkeypatch):
    transport, _ = make_transport([(400, {"error": {"code": "invalid_payload", "message": "kind: must be 'tag' or 'category'"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as ei:
        terms("https://site.test", "k", kind="color")  # type: ignore[arg-type]
    assert ei.value.code == "invalid_payload" and ei.value.http_status == 400


def test_list_media_query_params(monkeypatch):
    page = {
        "items": [{"id": "m1", "url": "https://site.test/m/a.png", "alt": "A", "title": "T", "mime_type": "image/png", "created_at": "2026-01-01T00:00:00.000Z"}],
        "next_cursor": "c2",
    }
    transport, calls = make_transport([(200, page)])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    assert list_media("https://site.test", "k", search="bike", limit=2, cursor="c1") == page
    request = calls["requests"][0]
    assert request.method == "GET" and request.url.path == "/api/media"
    assert dict(request.url.params) == {"search": "bike", "limit": "2", "cursor": "c1"}


def test_list_media_without_filters(monkeypatch):
    transport, calls = make_transport([(200, {"items": [], "next_cursor": None})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    list_media("https://site.test", "k")
    assert dict(calls["requests"][0].url.params) == {}


def test_list_media_bad_cursor_is_a_typed_error(monkeypatch):
    transport, _ = make_transport([(400, {"error": {"code": "invalid_payload", "message": "cursor"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as ei:
        list_media("https://site.test", "k", cursor="!!!")
    assert ei.value.code == "invalid_payload"


def test_update_media_sends_only_what_was_given(monkeypatch):
    item = {"id": "m1", "url": "https://site.test/m/a.png", "alt": "New", "mime_type": "image/png", "created_at": "2026-01-01T00:00:00.000Z"}
    transport, calls = make_transport([(200, item), (200, item), (200, item)])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    assert update_media("https://site.test", "k", "m1", alt="New") == item
    update_media("https://site.test", "k", "m1", title="Only title")
    update_media("https://site.test", "k", "m1", alt="A", title="T")
    bodies = [json.loads(r.content) for r in calls["requests"]]
    assert bodies == [{"alt": "New"}, {"title": "Only title"}, {"alt": "A", "title": "T"}]
    first = calls["requests"][0]
    assert first.method == "PATCH" and first.url.path == "/api/media/m1"
    assert first.headers["content-type"] == "application/json" and first.headers["authorization"] == "Bearer k"


def test_update_media_none_clears_and_unset_is_not_sent(monkeypatch):
    transport, calls = make_transport([(200, {"id": "m1"}), (200, {"id": "m1"})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    update_media("https://site.test", "k", "m1", alt=None)
    update_media("https://site.test", "k", "m1", alt=None, title="Kept")
    assert [json.loads(r.content) for r in calls["requests"]] == [{"alt": None}, {"alt": None, "title": "Kept"}]


def test_update_media_needs_at_least_one_field(monkeypatch):
    transport, calls = make_transport([(200, {})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as ei:
        update_media("https://site.test", "k", "m1")
    assert ei.value.code == "invalid_payload" and calls["n"] == 0
    with pytest.raises(InkwireClientError):
        update_media("https://site.test", "k", "m1", alt=UNSET, title=UNSET)


def test_update_media_quotes_the_id(monkeypatch):
    transport, calls = make_transport([(200, {"id": "x"})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    update_media("https://site.test", "k", "a/b c", alt="x")
    assert calls["requests"][0].url.raw_path == b"/api/media/a%2Fb%20c"


def test_update_media_errors_are_typed(monkeypatch):
    transport, _ = make_transport([(404, {"error": {"code": "not_found", "message": "no media"}}), (403, {"error": {"code": "forbidden", "message": "read-only"}})])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    with pytest.raises(InkwireClientError) as missing:
        update_media("https://site.test", "k", "nope", alt="x")
    assert (missing.value.code, missing.value.http_status) == ("not_found", 404)
    with pytest.raises(InkwireClientError) as forbidden:
        update_media("https://site.test", "k", "m1", alt="x")
    assert (forbidden.value.code, forbidden.value.http_status) == ("forbidden", 403)


def test_upload_result_carries_type_and_time(monkeypatch):
    answer = {"id": "m-3", "url": "https://site.test/m/p.png", "alt": "Up", "mime_type": "image/png", "created_at": "2026-07-22T04:00:00.000Z"}
    transport, _ = make_transport([(200, answer), (200, answer)])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    from_url = upload_media("https://site.test", "k", url="https://ext.test/p.png", alt="Up")
    from_bytes = upload_media("https://site.test", "k", data=(b"\x89PNG\r\n\x1a\n", "p.png", "image/png"), alt="Up")
    for result in (from_url, from_bytes):
        assert result["mime_type"] == "image/png" and result["created_at"] == "2026-07-22T04:00:00.000Z"


def test_upload_media_needs_url_or_data():
    with pytest.raises(InkwireClientError) as ei:
        upload_media("https://site.test", "k")
    assert ei.value.code == "invalid_payload"


def test_dry_runs_redirects_and_translation_filters(monkeypatch):
    from inkwire_client import list as list_entries, redirect

    warning = {"code": "title_duplicate", "field": "title", "message": "same"}
    transport, calls = make_transport([
        (200, {"id": None, "external_id": "e", "slug": "s", "kind": "post", "status": "draft", "created": True, "dry_run": True, "warnings": [warning]}),
        (200, {"id": "a", "title": "New", "dry_run": True, "warnings": []}),
        (200, {"kind": "post", "slug": "old", "id": "a", "url": "https://site.test/blog/new", "status": "published"}),
        (404, {"error": {"code": "not_found", "message": "nothing redirects"}}),
        (200, {"items": [], "next_cursor": None}),
    ])
    monkeypatch.setattr("inkwire_client._transport", transport, raising=False)
    assert publish("https://site.test", "k", {"external_id": "e", "title": "T", "markdown": "x"}, retries=1, dry_run=True)["warnings"] == [warning]
    entry, etag = update("https://site.test", "k", "a", {"lang": "fr", "translation_key": None}, retries=1, dry_run=True)
    assert entry["dry_run"] is True and etag is None
    assert redirect("https://site.test", "k", "post", "old", retries=1)["id"] == "a"
    assert redirect("https://site.test", "k", "post", "never", retries=1) is None
    list_entries("https://site.test", "k", retries=1, lang="fr", translation_key="home")
    urls = [str(r.url) for r in calls["requests"]]
    assert urls[0].endswith("/api/content?dry_run=true") and urls[1].endswith("/api/content/a?dry_run=true")
    assert urls[2].endswith("/api/redirects?kind=post&slug=old")
    assert "lang=fr" in urls[4] and "translation_key=home" in urls[4]
    assert json.loads(calls["requests"][1].content) == {"lang": "fr", "translation_key": None}
