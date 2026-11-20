"""Newest first by ``updated_at`` (ties by ``id``), paged with a keyset cursor, in both stores."""

import asyncio

import pytest

from inkwire_receiver import InkwireError, ListFilter
from inkwire_receiver.store import decode_cursor, encode_cursor, recency_key

KEY = "default"


def run(coro):
    return asyncio.run(coro)


def entry(slug, updated_at, **extra):
    return {
        "id": "",
        "kind": "post",
        "title": slug.title(),
        "slug": slug,
        "markdown": "body",
        "html": "",
        "external_id": f"ext-{slug}",
        "status": "published",
        "published_at": "2020-01-01T00:00:00Z",
        "updated_at": updated_at,
        "version": 1,
        **extra,
    }


def ids(items):
    return [item["id"] for item in items]


def test_content_is_ordered_by_updated_at_not_published_at(any_store):
    # b was published first but edited last
    run(any_store.save(KEY, entry("a", "2026-01-01T00:00:00.000Z", published_at="2026-03-01T00:00:00Z")))
    run(any_store.save(KEY, entry("b", "2026-02-01T00:00:00.000Z", published_at="2026-01-01T00:00:00Z")))
    items, _ = run(any_store.list(KEY, ListFilter()))
    assert ids(items) == ["post:b", "post:a"]


def test_ties_on_updated_at_break_by_id_ascending(any_store):
    for slug in ("charlie", "alpha", "bravo"):
        run(any_store.save(KEY, entry(slug, "2026-01-01T00:00:00.000Z")))
    items, _ = run(any_store.list(KEY, ListFilter()))
    assert ids(items) == ["post:alpha", "post:bravo", "post:charlie"]


def test_the_cursor_is_a_keyset_so_inserts_between_pages_do_not_repeat_or_skip(any_store):
    for n in range(5):
        run(any_store.save(KEY, entry(f"e{n}", f"2026-01-0{n + 1}T00:00:00.000Z")))
    page1, cursor = run(any_store.list(KEY, ListFilter(limit=2)))
    assert ids(page1) == ["post:e4", "post:e3"] and cursor
    run(any_store.save(KEY, entry("newest", "2026-02-01T00:00:00.000Z")))  # lands before page 1
    page2, cursor = run(any_store.list(KEY, ListFilter(limit=2, cursor=cursor)))
    assert ids(page2) == ["post:e2", "post:e1"] and cursor
    run(any_store.remove(KEY, "post:e0"))  # the next one disappears
    page3, cursor = run(any_store.list(KEY, ListFilter(limit=2, cursor=cursor)))
    assert page3 == [] and cursor is None


def test_the_last_page_has_no_cursor_and_a_full_page_that_ends_the_set_does_not_invent_one(any_store):
    for n in range(4):
        run(any_store.save(KEY, entry(f"e{n}", f"2026-01-0{n + 1}T00:00:00.000Z")))
    page, cursor = run(any_store.list(KEY, ListFilter(limit=4)))
    assert len(page) == 4 and cursor is None


def test_category_filter_in_both_stores(any_store):
    run(any_store.save(KEY, entry("in", "2026-01-01T00:00:00.000Z", categories=["Guides", "News"])))
    run(any_store.save(KEY, entry("out", "2026-01-02T00:00:00.000Z", categories=["Other"])))
    run(any_store.save(KEY, entry("none", "2026-01-03T00:00:00.000Z")))
    items, _ = run(any_store.list(KEY, ListFilter(category="News")))
    assert ids(items) == ["post:in"]
    assert items[0]["categories"] == ["Guides", "News"]


@pytest.mark.parametrize("cursor", ["!!!", "bm90LWpzb24", "eyJvIjoxfQ", "W10", "eyJrIjoxfQ"])
def test_a_bad_content_cursor_is_invalid_payload(any_store, cursor):
    with pytest.raises(InkwireError) as raised:
        run(any_store.list(KEY, ListFilter(cursor=cursor)))
    assert raised.value.code == "invalid_payload"


def test_a_bad_content_cursor_is_a_400_through_the_app(api):
    response = api.get("/api/content?cursor=!!!")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_payload"


def test_cursor_round_trip():
    assert decode_cursor(encode_cursor("a|b")) == "a|b"


def test_recency_key_sorts_newer_first_then_by_id():
    keys = [
        recency_key("2026-01-01T00:00:00.000Z", "b"),
        recency_key("2026-01-01T00:00:00.000Z", "a"),
        recency_key("2026-06-01T00:00:00.000Z", "z"),
        recency_key("2025-01-01T00:00:00Z", "a"),
    ]
    assert sorted(keys) == [keys[2], keys[1], keys[0], keys[3]]
    # an offset and a Z mean the same moment
    assert recency_key("2026-01-01T02:00:00+02:00", "x") == recency_key("2026-01-01T00:00:00.000Z", "x")


def test_the_list_endpoint_pages_newest_first_through_the_app(api, create):
    import time

    for n in range(3):
        create(external_id=f"o-{n}", title=f"Order {n}", status="published")
        time.sleep(0.003)
    first = api.get("/api/content?limit=2").json()
    assert [i["title"] for i in first["items"]] == ["Order 2", "Order 1"]
    second = api.get(f"/api/content?limit=2&cursor={first['next_cursor']}").json()
    assert [i["title"] for i in second["items"]] == ["Order 0"] and second["next_cursor"] is None
