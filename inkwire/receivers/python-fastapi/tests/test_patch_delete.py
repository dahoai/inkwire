from tests.conftest import error_code


def read(api, entry_id):
    response = api.get(f"/api/content/{entry_id}")
    assert response.status_code == 200
    return response.json(), response.headers["etag"]


def test_patch_with_if_match_returns_the_full_entry(api, create):
    created = create(external_id="p-1", title="Before", markdown="keep body")
    _, etag = read(api, created["id"])
    response = api.patch(
        f"/api/content/{created['id']}", json={"title": "After"}, headers={"if-match": etag}
    )
    assert response.status_code == 200
    assert response.headers["etag"] != etag
    body = response.json()
    assert body["title"] == "After"
    assert body["markdown"] == "keep body"


def test_patch_with_a_stale_etag_is_412_and_writes_nothing(api, create):
    created = create(external_id="p-2", title="First", markdown="x")
    _, etag = read(api, created["id"])
    assert api.patch(
        f"/api/content/{created['id']}", json={"title": "Second"}, headers={"if-match": etag}
    ).status_code == 200

    stale = api.patch(
        f"/api/content/{created['id']}", json={"title": "Racer"}, headers={"if-match": etag}
    )
    assert stale.status_code == 412
    assert error_code(stale) == "stale"
    entry, _ = read(api, created["id"])
    assert entry["title"] == "Second"


def test_patch_without_if_match_is_allowed(api, create):
    created = create(external_id="p-3", title="No guard", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={"excerpt": "Added"})
    assert response.status_code == 200
    assert response.json()["excerpt"] == "Added"


def test_patch_if_match_accepts_weak_and_quoted_forms(api, create):
    created = create(external_id="p-4", title="Weak", markdown="x")
    _, etag = read(api, created["id"])
    weak = "W/" + etag
    assert api.patch(f"/api/content/{created['id']}", json={"excerpt": "w"}, headers={"if-match": weak}).status_code == 200
    assert api.patch(f"/api/content/{created['id']}", json={"excerpt": "any"}, headers={"if-match": "*"}).status_code == 200


def test_patch_if_match_as_a_compressing_proxy_rewrote_it(api, create):
    created = create(external_id="p-4b", title="Proxied", markdown="x")
    url = f"/api/content/{created['id']}"
    _, etag = read(api, created["id"])
    bare = etag.strip('"')
    assert api.patch(url, json={"excerpt": "a"}, headers={"if-match": f'W/"{bare}-gzip"'}).status_code == 200  # Caddy, then Cloudflare
    _, now = read(api, created["id"])
    now = now.strip('"')
    assert api.patch(url, json={"excerpt": "b"}, headers={"if-match": f'"{now}-tar"'}).status_code == 412  # only encodings
    assert api.patch(url, json={"excerpt": "b"}, headers={"if-match": f'"{bare}-br"'}).status_code == 412  # an old one stays stale
    assert api.patch(url, json={"excerpt": "b"}, headers={"if-match": f'"{now}-br"'}).status_code == 200


def test_patch_seo_merges_per_key(api, create):
    created = create(
        external_id="p-5", title="SEO", markdown="x", seo={"title": "Search title", "description": "Search description"}
    )
    response = api.patch(f"/api/content/{created['id']}", json={"seo": {"noindex": True}})
    assert response.status_code == 200
    entry = api.get(f"/api/content/{created['id']}").json()
    assert entry["seo"] == {
        "title": "Search title",
        "description": "Search description",
        "noindex": True,
        "og_title": "Search title",
        "og_description": "Search description",
    }


def test_patch_seo_image_url_null_drops_the_override(api, create):
    created = create(
        external_id="p-6",
        title="SEO image",
        markdown="x",
        cover_image_url="https://images.test/cover.jpg",
        seo={"image_url": "https://images.test/og.jpg"},
    )
    api.patch(f"/api/content/{created['id']}", json={"seo": {"image_url": None}})
    entry = api.get(f"/api/content/{created['id']}").json()
    assert entry["seo"]["image_url"] == "https://images.test/cover.jpg"


def test_patch_null_clears_optional_fields(api, create):
    created = create(
        external_id="p-7",
        title="Clear me",
        markdown="x",
        excerpt="An excerpt",
        tags=["a", "b"],
        cover_image_url="https://images.test/c.jpg",
        canonical_url="https://origin.test/p",
        author={"name": "Isaac"},
        seo={"noindex": True},
        published_at="2026-01-02T03:04:05Z",
    )
    response = api.patch(
        f"/api/content/{created['id']}",
        json={
            "excerpt": None,
            "tags": None,
            "cover_image_url": None,
            "canonical_url": None,
            "author": None,
            "seo": None,
            "published_at": None,
        },
    )
    assert response.status_code == 200
    entry = api.get(f"/api/content/{created['id']}").json()
    assert entry["excerpt"] is None
    assert entry["tags"] == []
    assert entry["cover_image_url"] is None
    assert entry["canonical_url"] is None
    assert entry["author"] is None
    assert entry["seo"]["noindex"] is False
    assert entry["published_at"] != "2026-01-02T03:04:05Z"


def test_patch_cannot_change_external_id(api, create):
    created = create(external_id="p-8", title="Fixed", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={"external_id": "sneaky"})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_empty_patch_is_400(api, create):
    created = create(external_id="p-9", title="Empty", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_patch_slug_onto_a_taken_slug_is_409(api, create):
    created = create(external_id="p-10", title="Mine", markdown="x")
    create(external_id="p-owner", title="Owner", markdown="x", slug="taken-slug")
    response = api.patch(f"/api/content/{created['id']}", json={"slug": "taken-slug"})
    assert response.status_code == 409
    assert error_code(response) == "conflict"


def test_patch_slug_changes_the_url(api, create):
    created = create(external_id="p-11", title="Rename", markdown="x")
    before = api.get(f"/api/content/{created['id']}").json()
    response = api.patch(f"/api/content/{created['id']}", json={"slug": "new-name"})
    assert response.status_code == 200
    assert response.json()["slug"] == "new-name"
    assert response.json()["url"] != before["url"]
    assert response.json()["url"].endswith("/new-name")


def test_patch_kind_to_another_held_kind(api, create):
    created = create(external_id="p-12", title="Move", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={"kind": "page"})
    assert response.status_code == 200
    assert response.json()["kind"] == "page"
    assert "/page/" not in response.json()["url"]
    moved = api.get(f"/api/content/{response.json()['id']}")
    assert moved.status_code == 200
    assert moved.json()["kind"] == "page"


def test_patch_kind_to_an_unheld_kind_is_400(api, create):
    created = create(external_id="p-13", title="Move", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={"kind": "changelog"})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_patch_unknown_field_is_400(api, create):
    created = create(external_id="p-14", title="Unknown", markdown="x")
    response = api.patch(f"/api/content/{created['id']}", json={"bogus": 1})
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_patch_unknown_id_is_404(api):
    response = api.patch("/api/content/no-such-id", json={"title": "x"})
    assert response.status_code == 404
    assert error_code(response) == "not_found"


def test_patch_markdown_is_sanitized_and_size_checked(api, create, config):
    created = create(external_id="p-15", title="Body", markdown="x")
    too_big = api.patch(
        f"/api/content/{created['id']}", json={"markdown": "y" * (config.limits.markdown_bytes + 1)}
    )
    assert too_big.status_code == 413
    assert error_code(too_big) == "too_large"
    ok = api.patch(f"/api/content/{created['id']}", json={"markdown": "## New\n\n<script>x</script>"})
    assert ok.status_code == 200
    assert "<script" not in ok.json()["html"]


def test_delete_removes_the_entry(api, create):
    created = create(external_id="d-1", title="Delete me", markdown="x")
    _, etag = read(api, created["id"])
    response = api.delete(f"/api/content/{created['id']}", headers={"if-match": etag})
    assert response.status_code == 200
    assert response.json() == {"id": created["id"], "deleted": True}
    gone = api.get(f"/api/content/{created['id']}")
    assert gone.status_code == 404
    assert error_code(gone) == "not_found"


def test_delete_honours_if_match(api, create):
    created = create(external_id="d-2", title="Guarded", markdown="x")
    _, etag = read(api, created["id"])
    api.patch(f"/api/content/{created['id']}", json={"title": "Changed"})
    stale = api.delete(f"/api/content/{created['id']}", headers={"if-match": etag})
    assert stale.status_code == 412
    assert error_code(stale) == "stale"
    assert api.get(f"/api/content/{created['id']}").status_code == 200


def test_delete_unknown_id_is_404(api):
    response = api.delete("/api/content/no-such-id")
    assert response.status_code == 404
    assert error_code(response) == "not_found"
