"""``GET /api/terms``: tags and categories derived from the entries."""

import asyncio

import pytest

from inkwire_receiver import ListFilter, parse_api_keys
from inkwire_receiver.handle import TERMS_SCAN_CAP, handle_terms
from tests.conftest import error_code

KEYS = parse_api_keys("dev-key,audit-key:ro")


def terms(api, query="", **kwargs):
    response = api.get(f"/api/terms{query}", **kwargs)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_an_empty_site_has_no_terms(api):
    response = api.get("/api/terms")
    assert response.status_code == 200
    assert response.json() == {"items": []}
    assert response.headers["inkwire-version"] == "1"


def test_terms_count_entries_including_drafts_and_every_kind(api, create):
    create(external_id="t-1", tags=["seo", "ai"], categories=["Guides"], status="published")
    create(external_id="t-2", tags=["seo"], status="draft")
    create(external_id="t-3", kind="page", tags=["seo"], categories=["Guides", "News"])
    assert terms(api) == [
        {"kind": "tag", "name": "seo", "slug": "seo", "count": 3},
        {"kind": "category", "name": "Guides", "slug": "guides", "count": 2},
        {"kind": "tag", "name": "ai", "slug": "ai", "count": 1},
        {"kind": "category", "name": "News", "slug": "news", "count": 1},
    ]


def test_names_differing_only_in_case_are_one_term_with_the_most_used_spelling(api, create):
    create(external_id="c-1", tags=["SEO"])
    create(external_id="c-2", tags=["seo"])
    create(external_id="c-3", tags=["seo"])
    assert terms(api, "?kind=tag") == [{"kind": "tag", "name": "seo", "slug": "seo", "count": 3}]


def test_an_entry_spelling_one_term_twice_counts_once(api, create):
    create(external_id="d-1", tags=["SEO", "seo", "Seo"])
    (term,) = terms(api, "?kind=tag")
    assert term["count"] == 1


def test_a_tag_and_a_category_of_the_same_name_are_two_terms(api, create):
    create(external_id="k-1", tags=["news"], categories=["news"])
    assert {(t["kind"], t["count"]) for t in terms(api)} == {("tag", 1), ("category", 1)}


def test_order_is_count_descending_then_name(api, create):
    create(external_id="o-1", tags=["zeta", "beta", "alpha"])
    create(external_id="o-2", tags=["zeta"])
    assert [t["name"] for t in terms(api, "?kind=tag")] == ["zeta", "alpha", "beta"]


def test_slug_is_the_slugified_name(api, create):
    create(external_id="s-1", tags=["Machine Learning!"], categories=["How-to Guides"])
    assert {t["name"]: t["slug"] for t in terms(api)} == {
        "Machine Learning!": "machine-learning",
        "How-to Guides": "how-to-guides",
    }


def test_kind_filter(api, create):
    create(external_id="f-1", tags=["a"], categories=["b"])
    assert [t["name"] for t in terms(api, "?kind=tag")] == ["a"]
    assert [t["name"] for t in terms(api, "?kind=category")] == ["b"]


def test_search_is_a_case_insensitive_substring(api, create):
    create(external_id="q-1", tags=["Search Engine", "seo"], categories=["Marketing"])
    assert [t["name"] for t in terms(api, "?search=ENGINE")] == ["Search Engine"]
    assert [t["name"] for t in terms(api, "?search=KETING")] == ["Marketing"]
    assert terms(api, "?search=zzz") == []


def test_limit(api, create):
    create(external_id="l-1", tags=["a", "b", "c"])
    assert len(terms(api, "?limit=2")) == 2
    assert len(terms(api, "?limit=500")) == 3
    # more than the maximum is clamped, like content
    assert len(terms(api, "?limit=9999")) == 3


@pytest.mark.parametrize("query", ["?kind=color", "?kind=Tag", "?limit=0", "?limit=-1", "?limit=abc", "?limit=1.5"])
def test_bad_query_is_400(api, query):
    response = api.get(f"/api/terms{query}")
    assert response.status_code == 400, query
    assert error_code(response) == "invalid_payload"
    assert response.headers["inkwire-version"] == "1"


def test_terms_need_a_key(api):
    for key in (None, "wrong-key"):
        response = api.get("/api/terms", key=key)
        assert response.status_code == 401
        assert error_code(response) == "unauthorized"


def test_a_read_only_key_can_read_terms(api, create):
    create(external_id="ro-1", tags=["x"])
    assert [t["name"] for t in terms(api, key="audit-key")] == ["x"]


def test_terms_are_a_read_so_post_is_not_a_route(api):
    response = api.post("/api/terms", json={})
    assert response.status_code == 404


def test_terms_follow_edits(api, create):
    created = create(external_id="e-1", tags=["old"], categories=["Cat"])
    api.patch(f"/api/content/{created['id']}", json={"tags": ["new"], "categories": None})
    assert [(t["kind"], t["name"]) for t in terms(api)] == [("tag", "new")]
    api.delete(f"/api/content/{created['id']}")
    assert terms(api) == []


class PagedStore:
    """A store that only pages ``list``: ``total`` entries, ``page`` per call, all tagged."""

    def __init__(self, total):
        self.total = total
        self.calls = 0

    async def list(self, key, filter: ListFilter):
        self.calls += 1
        start = int(filter.cursor or 0)
        stop = min(start + filter.limit, self.total)
        items = [{"id": f"post:{n}", "tags": ["shared", f"only-{n}"], "categories": ["C"]} for n in range(start, stop)]
        return items, (str(stop) if stop < self.total else None)


def run_terms(store, query=None):
    status, _, body = asyncio.run(
        handle_terms(auth_header="Bearer dev-key", query=query or {"limit": "500"}, keys=KEYS, store=store)
    )
    assert status == 200
    return body["items"]


def test_the_scan_pages_through_the_whole_store():
    store = PagedStore(250)
    items = run_terms(store)
    assert {t["name"]: t["count"] for t in items if t["kind"] == "tag" and t["name"] == "shared"} == {"shared": 250}
    assert store.calls == 3  # 100 + 100 + 50


def test_the_scan_stops_at_ten_thousand_entries():
    store = PagedStore(TERMS_SCAN_CAP + 500)
    items = run_terms(store, {"kind": "category"})
    assert items == [{"kind": "category", "name": "C", "slug": "c", "count": TERMS_SCAN_CAP}]
    assert store.calls == TERMS_SCAN_CAP // 100
