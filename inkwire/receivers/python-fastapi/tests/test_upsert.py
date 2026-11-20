from tests.conftest import error_code


def test_create_published(api):
    response = api.post(
        "/api/content",
        json={"external_id": "e1", "title": "First", "markdown": "# Hi", "status": "published"},
    )
    assert response.status_code == 200
    assert response.headers["inkwire-version"] == "1"
    body = response.json()
    assert body["created"] is True
    assert body["status"] == "published"
    assert body["kind"] == "post"
    assert body["slug"] and body["url"].endswith("/blog/" + body["slug"])


def test_upsert_on_external_id(api):
    first = api.post("/api/content", json={"external_id": "up-1", "title": "One", "markdown": "x"})
    second = api.post("/api/content", json={"external_id": "up-1", "title": "Two", "markdown": "y"})
    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["slug"] == second.json()["slug"]


def test_upsert_is_scoped_by_kind(api):
    post = api.post("/api/content", json={"external_id": "same", "title": "Post", "markdown": "x"})
    page = api.post("/api/content", json={"external_id": "same", "kind": "page", "title": "Page", "markdown": "x"})
    assert post.json()["created"] is True
    assert page.json()["created"] is True
    assert page.json()["kind"] == "page"
    assert page.json()["id"] != post.json()["id"]


def test_default_status_is_draft(api):
    response = api.post("/api/content", json={"external_id": "d1", "title": "Draft", "markdown": "x"})
    assert response.json()["status"] == "draft"


def test_auto_slug_dedupes_on_title_collision(api):
    first = api.post("/api/content", json={"external_id": "a1", "title": "Same Title", "markdown": "x"})
    second = api.post("/api/content", json={"external_id": "a2", "title": "Same Title", "markdown": "y"})
    assert second.status_code == 200
    assert first.json()["slug"] == "same-title"
    assert second.json()["slug"] == "same-title-2"


def test_explicit_slug_conflict_is_409(api):
    api.post("/api/content", json={"external_id": "owner", "title": "Owner", "markdown": "x", "slug": "taken"})
    response = api.post(
        "/api/content", json={"external_id": "other", "title": "Other", "markdown": "x", "slug": "taken"}
    )
    assert response.status_code == 409
    assert error_code(response) == "conflict"


def test_explicit_slug_of_the_same_entry_is_fine(api):
    api.post("/api/content", json={"external_id": "mine", "title": "Mine", "markdown": "x", "slug": "mine"})
    response = api.post(
        "/api/content", json={"external_id": "mine", "title": "Mine again", "markdown": "y", "slug": "mine"}
    )
    assert response.status_code == 200
    assert response.json()["slug"] == "mine"


def test_unknown_kind_is_400(api):
    response = api.post(
        "/api/content", json={"external_id": "k1", "kind": "changelog", "title": "x", "markdown": "x"}
    )
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_javascript_urls_are_400(api):
    cover = api.post(
        "/api/content",
        json={"external_id": "u1", "title": "x", "markdown": "x", "cover_image_url": "javascript:alert(1)"},
    )
    canonical = api.post(
        "/api/content",
        json={"external_id": "u2", "title": "x", "markdown": "x", "canonical_url": "javascript:alert(1)"},
    )
    seo = api.post(
        "/api/content",
        json={"external_id": "u3", "title": "x", "markdown": "x", "seo": {"image_url": "javascript:alert(1)"}},
    )
    for response in (cover, canonical, seo):
        assert response.status_code == 400
        assert error_code(response) == "invalid_payload"


def test_unknown_field_is_400(api):
    response = api.post(
        "/api/content", json={"external_id": "f1", "title": "x", "markdown": "x", "bogus": 1}
    )
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_unknown_seo_field_is_400(api):
    response = api.post(
        "/api/content", json={"external_id": "f2", "title": "x", "markdown": "x", "seo": {"keywords": ["x"]}}
    )
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_nulls_are_rejected_on_create(api):
    null_seo = api.post(
        "/api/content", json={"external_id": "n1", "title": "x", "markdown": "x", "seo": None}
    )
    null_override = api.post(
        "/api/content", json={"external_id": "n2", "title": "x", "markdown": "x", "seo": {"title": None}}
    )
    string_noindex = api.post(
        "/api/content", json={"external_id": "n3", "title": "x", "markdown": "x", "seo": {"noindex": "false"}}
    )
    for response in (null_seo, null_override, string_noindex):
        assert response.status_code == 400
        assert error_code(response) == "invalid_payload"


def test_required_fields(api):
    for payload in (
        {"external_id": "r1", "markdown": "x"},
        {"title": "x", "markdown": "x"},
        {"external_id": "r2", "title": "x"},
        {"external_id": "", "title": "x", "markdown": "x"},
        {"external_id": "r3", "title": "x", "markdown": ""},
    ):
        response = api.post("/api/content", json=payload)
        assert response.status_code == 400, payload
        assert error_code(response) == "invalid_payload"


def test_published_at_offset_ok_and_date_only_rejected(api):
    ok = api.post(
        "/api/content",
        json={"external_id": "p1", "title": "x", "markdown": "x", "published_at": "2026-07-22T04:00:00+02:00"},
    )
    bad = api.post(
        "/api/content",
        json={"external_id": "p2", "title": "x", "markdown": "x", "published_at": "2026-07-22"},
    )
    assert ok.status_code == 200
    assert bad.status_code == 400
    assert error_code(bad) == "invalid_payload"


def test_malformed_json_is_400(api):
    response = api.post_raw("/api/content", b"{not valid json")
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_non_object_body_is_400(api):
    response = api.post("/api/content", json=[1, 2, 3])
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_markdown_over_the_limit_is_413(api, config):
    limit = config.limits.markdown_bytes
    response = api.post(
        "/api/content", json={"external_id": "big", "title": "Big", "markdown": "x" * (limit + 1)}
    )
    assert response.status_code == 413
    assert error_code(response) == "too_large"


def test_markdown_html_is_sanitized_on_create(api):
    created = api.post(
        "/api/content",
        json={
            "external_id": "xss",
            "title": "XSS",
            "markdown": "# Hi\n\n<script>alert(1)</script>\n\n<a href=\"javascript:alert(2)\" onclick=\"x()\">go</a>",
        },
    )
    entry = api.get(f"/api/content/{created.json()['id']}").json()
    assert "<script" not in entry["html"]
    assert "javascript:" not in entry["html"]
    assert "onclick" not in entry["html"]


def test_upsert_keeps_slug_and_published_at_when_omitted(api):
    first = api.post(
        "/api/content",
        json={
            "external_id": "keep",
            "title": "Kept",
            "markdown": "x",
            "status": "published",
            "published_at": "2026-01-02T03:04:05Z",
        },
    )
    second = api.post("/api/content", json={"external_id": "keep", "title": "Kept again", "markdown": "y"})
    entry = api.get(f"/api/content/{first.json()['id']}").json()
    assert entry["slug"] == first.json()["slug"]
    assert entry["published_at"] == "2026-01-02T03:04:05Z"
    assert second.json()["created"] is False


def test_response_always_carries_the_version_header(api):
    ok = api.get("/api/content?limit=1")
    failed = api.post("/api/content", json={})
    assert ok.headers["inkwire-version"] == "1"
    assert failed.headers["inkwire-version"] == "1"
