import pytest

from tests.conftest import error_code


def test_list_returns_summaries_and_a_cursor(api, create):
    create(external_id="l-1", title="Alpha one", markdown="alpha", status="published")
    create(external_id="l-2", title="Beta two", markdown="beta")
    response = api.get("/api/content?limit=2")
    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 2
    item = body["items"][0]
    for field in ("id", "external_id", "kind", "title", "slug", "url", "status", "excerpt", "tags", "published_at", "updated_at"):
        assert field in item
    assert "markdown" not in item
    assert "next_cursor" in body


def test_list_filters(api, create):
    create(external_id="f-1", title="Draft one", markdown="x", tags=["seo", "ai"], excerpt="drafty")
    create(external_id="f-2", title="Published two", markdown="x", status="published", tags=["seo"])
    create(external_id="f-3", title="Other", markdown="x", kind="page", status="published")

    drafts = api.get("/api/content?status=draft").json()["items"]
    assert {i["title"] for i in drafts} == {"Draft one"}

    pages = api.get("/api/content?kind=page").json()["items"]
    assert [i["title"] for i in pages] == ["Other"]

    tagged = api.get("/api/content?tag=ai").json()["items"]
    assert [i["title"] for i in tagged] == ["Draft one"]

    by_external = api.get("/api/content?external_id=f-2").json()["items"]
    assert [i["title"] for i in by_external] == ["Published two"]
    assert len(by_external) == 1

    slug = by_external[0]["slug"]
    by_slug = api.get(f"/api/content?slug={slug}").json()["items"]
    assert [i["id"] for i in by_slug] == [by_external[0]["id"]]


def test_search_is_case_insensitive_over_title_excerpt_and_markdown(api, create):
    create(external_id="s-1", title="The Needle", markdown="nothing")
    create(external_id="s-2", title="Body", markdown="a needle inside")
    create(external_id="s-3", title="Excerpt", markdown="nothing", excerpt="NEEDLE summary")
    found = api.get("/api/content?search=needle").json()["items"]
    assert {i["title"] for i in found} == {"The Needle", "Body", "Excerpt"}


def test_limit_defaults_to_20_and_clamps_at_100(api, create):
    for index in range(3):
        create(external_id=f"lim-{index}", title=f"Entry {index}")
    assert len(api.get("/api/content").json()["items"]) == 3
    assert len(api.get("/api/content?limit=1").json()["items"]) == 1
    assert len(api.get("/api/content?limit=500").json()["items"]) == 3


@pytest.mark.parametrize("raw", ["abc", "0", "-5", "1.5"])
def test_limit_must_be_a_positive_integer(api, raw):
    response = api.get(f"/api/content?limit={raw}")
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_empty_limit_means_the_default(api):
    assert api.get("/api/content?limit=").status_code == 200


def test_status_filter_must_be_known(api):
    response = api.get("/api/content?status=archived")
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_cursor_round_trip(api, create):
    for index in range(3):
        create(external_id=f"c-{index}", title=f"Cursor {index}")
    first = api.get("/api/content?limit=2").json()
    assert len(first["items"]) == 2
    assert first["next_cursor"]
    second = api.get(f"/api/content?limit=2&cursor={first['next_cursor']}").json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None
    ids = {i["id"] for i in first["items"]} | {i["id"] for i in second["items"]}
    assert len(ids) == 3


def test_bad_cursor_is_400(api):
    response = api.get("/api/content?cursor=not-a-cursor")
    assert response.status_code == 400
    assert error_code(response) == "invalid_payload"


def test_get_returns_the_full_entry_with_an_etag(api, create):
    created = create(
        external_id="g-1",
        title="Get me",
        markdown="original body",
        excerpt="Get excerpt",
        cover_image_url="https://images.test/cover.jpg",
        canonical_url="https://origin.test/post",
        tags=["seo"],
        author={"name": "Isaac", "email": "i@example.test"},
        seo={"title": "SEO title", "noindex": True},
    )
    response = api.get(f"/api/content/{created['id']}")
    assert response.status_code == 200
    assert response.headers["etag"]
    entry = response.json()
    assert entry["markdown"] == "original body"
    assert entry["title"] == "Get me"
    assert entry["seo"] == {
        "title": "SEO title",
        "description": "Get excerpt",
        "image_url": "https://images.test/cover.jpg",
        "noindex": True,
        "og_title": "SEO title",
        "og_description": "Get excerpt",
    }
    assert entry["canonical_url"] == "https://origin.test/post"
    assert entry["author"] == {"name": "Isaac", "email": "i@example.test"}


def test_effective_seo_defaults(api, create):
    created = create(external_id="seo-1", title="Plain title", markdown="x")
    entry = api.get(f"/api/content/{created['id']}").json()
    assert entry["seo"] == {
        "title": "Plain title",
        "description": "Plain title",
        "noindex": False,
        "og_title": "Plain title",
        "og_description": "Plain title",
    }


def test_get_unknown_id_is_404(api):
    response = api.get("/api/content/no-such-id")
    assert response.status_code == 404
    assert error_code(response) == "not_found"


def test_read_only_key_can_list_drafts(api, create):
    create(external_id="ro-draft", title="A draft")
    response = api.get("/api/content?status=draft", key="audit-key")
    assert response.status_code == 200
    assert [item["title"] for item in response.json()["items"]] == ["A draft"]


def test_discovery_advertises_the_wired_features(api):
    body = api.get("/api/inkwire").json()
    assert body["inkwire"] == 1
    assert body["features"] == ["upsert", "list", "get", "update", "delete", "terms", "media", "media_list", "media_update", "revisions", "warnings", "redirects", "translations"]
    assert body["kinds"] == ["post", "page"]
    assert body["limits"] == {"markdown_bytes": 1000, "media_bytes": 1024, "revisions": 50}
    assert body["site"] == {"name": "Acme", "url": "https://acme.test"}


def test_unknown_api_path_is_a_protocol_404(api):
    response = api.get("/api/nope")
    assert response.status_code == 404
    assert error_code(response) == "not_found"
    assert response.headers["inkwire-version"] == "1"
