"""The media library: ``GET /api/media``, ``PATCH /api/media/{id}``, the richer upload response, both stores."""

import asyncio

import pytest

from inkwire_receiver import (
    FileStore,
    InkwireConfig,
    MediaListFilter,
    MediaUpload,
    MemoryStore,
    parse_api_keys,
)
from inkwire_receiver.app import create_app
from inkwire_receiver.handle import handle_media_list, handle_media_update
from tests.conftest import GIF, KEYS, PNG, Api, bearer, error_code, make_config

KEY = "default"
ISO_MS = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"


def run(coro):
    return asyncio.run(coro)


def upload(store, filename="px.png", alt=None, data=PNG, content_type="image/png"):
    return run(store.media(KEY, MediaUpload(data=data, filename=filename, content_type=content_type, alt=alt)))


# --- stores (memory and file behave the same) -------------------------------


def test_a_saved_item_carries_type_time_and_alt(any_store):
    item = upload(any_store, alt="One pixel")
    assert item.mime_type == "image/png"
    assert item.alt == "One pixel" and item.title is None
    import re

    assert re.match(ISO_MS, item.created_at)
    assert item.as_dict() == {
        "id": item.id,
        "url": item.url,
        "alt": "One pixel",
        "mime_type": "image/png",
        "width": 1,
        "height": 1,
        "created_at": item.created_at,
    }


def test_list_media_is_newest_first(any_store, clock):
    first = upload(any_store, alt="first")
    second = upload(any_store, alt="second")
    third = upload(any_store, alt="third")
    items, cursor = run(any_store.list_media(KEY, MediaListFilter()))
    assert [i.id for i in items] == [third.id, second.id, first.id]
    assert cursor is None
    assert items[0] == third


def test_list_media_ties_on_created_at_break_by_id(any_store, monkeypatch):
    monkeypatch.setattr("inkwire_receiver.store.now_iso", lambda: "2026-01-01T00:00:00.000Z")
    monkeypatch.setattr("inkwire_receiver.file_store.now_iso", lambda: "2026-01-01T00:00:00.000Z")
    ids = [upload(any_store).id for _ in range(5)]
    items, _ = run(any_store.list_media(KEY, MediaListFilter()))
    assert [i.id for i in items] == sorted(ids)


def test_list_media_pages_with_a_keyset_cursor(any_store, clock):
    made = [upload(any_store, alt=f"n{n}") for n in range(5)]
    newest_first = [m.id for m in reversed(made)]
    page1, cursor = run(any_store.list_media(KEY, MediaListFilter(limit=2)))
    assert [i.id for i in page1] == newest_first[:2] and cursor
    # a newer upload between the pages never repeats or skips an item
    upload(any_store, alt="late")
    page2, cursor = run(any_store.list_media(KEY, MediaListFilter(limit=2, cursor=cursor)))
    assert [i.id for i in page2] == newest_first[2:4] and cursor
    page3, cursor = run(any_store.list_media(KEY, MediaListFilter(limit=2, cursor=cursor)))
    assert [i.id for i in page3] == newest_first[4:] and cursor is None


def test_list_media_search_matches_alt_title_and_filename(any_store, clock):
    by_alt = upload(any_store, filename="a.png", alt="A red BICYCLE")
    by_title = upload(any_store, filename="b.png")
    run(any_store.update_media(KEY, by_title.id, {"title": "Bicycle shop"}))
    by_name = upload(any_store, filename="bicycle-photo.png")
    upload(any_store, filename="other.png", alt="unrelated")

    items, _ = run(any_store.list_media(KEY, MediaListFilter(search="bicycle")))
    assert {i.id for i in items} == {by_alt.id, by_title.id, by_name.id}
    assert run(any_store.list_media(KEY, MediaListFilter(search="no-such-text")))[0] == []


def test_list_media_rejects_a_bad_cursor(any_store):
    from inkwire_receiver import InkwireError

    for cursor in ("!!!", "bm90LWpzb24", "eyJvIjoxfQ"):  # junk, not JSON, JSON without a key
        with pytest.raises(InkwireError) as raised:
            run(any_store.list_media(KEY, MediaListFilter(cursor=cursor)))
        assert raised.value.code == "invalid_payload"


def test_update_media_sets_merges_and_clears(any_store):
    item = upload(any_store, alt="old")
    both = run(any_store.update_media(KEY, item.id, {"alt": "new", "title": "A title"}))
    assert (both.alt, both.title) == ("new", "A title")
    # only the given field changes
    title_only = run(any_store.update_media(KEY, item.id, {"title": "Changed"}))
    assert (title_only.alt, title_only.title) == ("new", "Changed")
    cleared = run(any_store.update_media(KEY, item.id, {"alt": None}))
    assert (cleared.alt, cleared.title) == (None, "Changed")
    # the library sees the change, and id / url / time are stable
    (listed,), _ = run(any_store.list_media(KEY, MediaListFilter()))
    assert listed == cleared
    assert (cleared.id, cleared.url, cleared.created_at, cleared.mime_type) == (
        item.id,
        item.url,
        item.created_at,
        item.mime_type,
    )


def test_update_media_unknown_id_is_none(any_store):
    upload(any_store)
    assert run(any_store.update_media(KEY, "0123456789abcdef", {"alt": "x"})) is None
    assert run(any_store.update_media(KEY, "no-such-media", {"alt": "x"})) is None


def test_a_gif_keeps_its_own_type(any_store):
    assert upload(any_store, filename="a.gif", data=GIF, content_type="image/gif").mime_type == "image/gif"


# --- FileStore: sidecar persistence and path safety -------------------------


def test_filestore_persists_alt_title_filename_mime_and_time_in_a_sidecar(tmp_path):
    import json

    store = FileStore(tmp_path, media_url_base="https://site.test/media")
    item = upload(store, filename="My Photo.PNG", alt="Alt")
    run(store.update_media(KEY, item.id, {"title": "Title"}))
    name = item.url.rsplit("/", 1)[-1]
    meta = json.loads((tmp_path / "media" / f"{name}.meta.json").read_text())
    assert meta["id"] == item.id
    assert meta["filename"] == name
    assert meta["mime_type"] == "image/png"
    assert meta["created_at"] == item.created_at
    assert (meta["alt"], meta["title"]) == ("Alt", "Title")
    assert (meta["width"], meta["height"]) == (1, 1)

    # a fresh store over the same folder (a restart) lists the same item
    again = FileStore(tmp_path, media_url_base="https://site.test/media")
    (listed,), _ = run(again.list_media(KEY, MediaListFilter()))
    assert listed.as_dict() == {
        "id": item.id,
        "url": item.url,
        "alt": "Alt",
        "title": "Title",
        "mime_type": "image/png",
        "width": 1,
        "height": 1,
        "created_at": item.created_at,
    }


def test_filestore_writes_media_atomically(tmp_path):
    store = FileStore(tmp_path)
    upload(store)
    update_target = run(store.list_media(KEY, MediaListFilter()))[0][0]
    run(store.update_media(KEY, update_target.id, {"alt": "x"}))
    assert not [p for p in (tmp_path / "media").iterdir() if ".tmp-" in p.name]


def test_filestore_ignores_files_without_a_sidecar_and_broken_sidecars(tmp_path):
    store = FileStore(tmp_path)
    kept = upload(store, alt="kept")
    media = tmp_path / "media"
    (media / "dropped-by-hand.png").write_bytes(PNG)
    (media / "broken.meta.json").write_text("{not json")
    (media / "list.meta.json").write_text("[1, 2]")
    (media / ("0123456789abcdef-gone.png.meta.json")).write_text(
        '{"id": "0123456789abcdef", "filename": "0123456789abcdef-gone.png", "mime_type": "image/png", "created_at": "2026-01-01T00:00:00.000Z"}'
    )  # its image is missing
    items, _ = run(store.list_media(KEY, MediaListFilter()))
    assert [i.id for i in items] == [kept.id]


def test_filestore_media_without_a_folder_is_an_empty_library(tmp_path):
    store = FileStore(tmp_path / "nothing-yet")
    assert run(store.list_media(KEY, MediaListFilter())) == ([], None)
    assert run(store.update_media(KEY, "0123456789abcdef", {"alt": "x"})) is None


@pytest.mark.parametrize(
    "hostile",
    [
        "../secret",
        "..",
        "../../etc/passwd",
        "..%2f..%2fetc%2fpasswd",
        "/etc/passwd",
        "a/b",
        "a\\b",
        "*",
        "????????????????",
        "0123456789abcdef-*",
        "0123456789abcdef/../../secret",
        "0123456789ABCDEF",
        "0123456789abcde",
        "0123456789abcdef0",
        "0123456789abcdef\x00",
        "",
    ],
)
def test_filestore_update_never_touches_anything_for_an_id_that_is_not_ours(tmp_path, hostile):
    store = FileStore(tmp_path / "site")
    upload(store)
    outside = tmp_path / "secret.meta.json"
    outside.write_text('{"id": "0123456789abcdef"}')
    inside_content = tmp_path / "site" / "post"
    inside_content.mkdir(parents=True)
    (inside_content / "x.md").write_text("body")
    before = sorted(str(p.relative_to(tmp_path)) + str(p.stat().st_mtime_ns) for p in tmp_path.rglob("*"))
    assert run(store.update_media(KEY, hostile, {"alt": "pwned"})) is None
    after = sorted(str(p.relative_to(tmp_path)) + str(p.stat().st_mtime_ns) for p in tmp_path.rglob("*"))
    assert before == after
    assert outside.read_text() == '{"id": "0123456789abcdef"}'


def test_filestore_ignores_a_sidecar_whose_filename_points_outside_the_folder(tmp_path):
    store = FileStore(tmp_path / "site")
    upload(store)
    (tmp_path / "victim.png").write_bytes(PNG)
    evil = tmp_path / "site" / "media" / "0123456789abcdef-evil.png.meta.json"
    evil.write_text(
        '{"id": "0123456789abcdef", "filename": "../../victim.png", "mime_type": "image/png", "created_at": "2026-01-01T00:00:00.000Z"}'
    )
    items, _ = run(store.list_media(KEY, MediaListFilter()))
    assert len(items) == 1
    assert run(store.update_media(KEY, "0123456789abcdef", {"alt": "x"})) is None
    assert evil.read_text().count("victim.png") == 1


# --- handlers ---------------------------------------------------------------


def list_handler(store, query=None, key="Bearer dev-key"):
    return run(handle_media_list(auth_header=key, query=query or {}, keys=KEYS, store=store))


def update_handler(store, id, body, key="Bearer dev-key"):
    return run(handle_media_update(auth_header=key, id=id, raw_body=body, keys=KEYS, store=store))


def test_list_handler_shape(any_store, clock):
    item = upload(any_store, alt="x")
    status, headers, body = list_handler(any_store)
    assert status == 200
    assert headers["Inkwire-Version"] == "1"
    assert body == {"items": [item.as_dict()], "next_cursor": None}


@pytest.mark.parametrize("query", [{"limit": "0"}, {"limit": "-3"}, {"limit": "x"}, {"cursor": "!!!"}, {"cursor": "bm90LWpzb24"}])
def test_list_handler_rejects_bad_limit_and_cursor(any_store, query):
    status, _, body = list_handler(any_store, query)
    assert status == 400 and body["error"]["code"] == "invalid_payload"


def test_list_handler_clamps_limit_to_100(any_store):
    assert list_handler(any_store, {"limit": "1000"})[0] == 200


def test_update_handler_validates_before_touching_the_store(any_store):
    item = upload(any_store, alt="keep")
    for body in ({}, {"url": "https://x.test/a.png"}, {"alt": 5}, {"title": "t" * 513}, {"alt": "a" * 1025}, "[]", "{bad", b""):
        status, _, response = update_handler(any_store, item.id, body)
        assert status == 400 and response["error"]["code"] == "invalid_payload", body
    assert run(any_store.list_media(KEY, MediaListFilter()))[0][0].alt == "keep"


def test_update_handler_accepts_raw_json_bytes(any_store):
    item = upload(any_store)
    status, _, body = update_handler(any_store, item.id, b'{"title": "From bytes"}')
    assert status == 200 and body["title"] == "From bytes"


def test_update_handler_limits_are_inclusive(any_store):
    item = upload(any_store)
    status, _, body = update_handler(any_store, item.id, {"alt": "a" * 1024, "title": "t" * 512})
    assert status == 200 and len(body["alt"]) == 1024 and len(body["title"]) == 512


# --- app level --------------------------------------------------------------


def test_upload_response_carries_type_and_time(client):
    response = client.post("/api/media", headers=bearer(), files={"file": ("px.png", PNG, "image/png")}, data={"alt": "Alt"})
    assert response.status_code == 200
    body = response.json()
    assert body["mime_type"] == "image/png"
    import re

    assert re.match(ISO_MS, body["created_at"])
    assert body["alt"] == "Alt" and "title" not in body


def test_the_url_variant_response_carries_type_and_time():
    async def fetch(url):
        return PNG, "ok.png", "image/png"

    store = MemoryStore(media_url_base="https://media.test", fetcher=fetch)
    api = Api(create_app(store=store, api_keys=KEYS, config=make_config()))
    body = api.post("/api/media", json={"url": "https://example.test/ok.png", "alt": "A"}).json()
    assert (body["mime_type"], body["alt"]) == ("image/png", "A") and body["created_at"]


def test_a_library_round_trip_through_the_app(client):
    ids = []
    for n in range(3):
        r = client.post("/api/media", headers=bearer(), files={"file": (f"p{n}.png", PNG, "image/png")}, data={"alt": f"lib {n}"})
        ids.append(r.json()["id"])
    listing = client.get("/api/media?search=lib&limit=2", headers=bearer()).json()
    assert len(listing["items"]) == 2 and listing["next_cursor"]
    rest = client.get(f"/api/media?search=lib&limit=2&cursor={listing['next_cursor']}", headers=bearer()).json()
    assert len(rest["items"]) == 1 and rest["next_cursor"] is None
    assert {i["id"] for i in listing["items"] + rest["items"]} == set(ids)

    patched = client.patch(f"/api/media/{ids[0]}", headers=bearer(), json={"alt": "changed", "title": "Titled"})
    assert patched.status_code == 200
    assert patched.headers["inkwire-version"] == "1"
    assert patched.json()["alt"] == "changed" and patched.json()["title"] == "Titled" and patched.json()["id"] == ids[0]
    found = client.get("/api/media?search=titled", headers=bearer()).json()["items"]
    assert [i["id"] for i in found] == [ids[0]]
    cleared = client.patch(f"/api/media/{ids[0]}", headers=bearer(), json={"title": None}).json()
    assert "title" not in cleared and cleared["alt"] == "changed"


def test_patch_media_errors_through_the_app(client):
    r = client.post("/api/media", headers=bearer(), files={"file": ("p.png", PNG, "image/png")})
    media_id = r.json()["id"]
    unknown = client.patch("/api/media/no-such-media", headers=bearer(), json={"alt": "x"})
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "not_found"
    assert unknown.headers["inkwire-version"] == "1"
    assert client.patch(f"/api/media/{media_id}", headers=bearer(), json={}).status_code == 400
    assert client.patch(f"/api/media/{media_id}", headers=bearer(), json={"url": "https://x.test/a.png"}).status_code == 400
    assert client.patch(f"/api/media/{media_id}", headers=bearer(), content=b"{bad").status_code == 400
    assert client.patch(f"/api/media/{media_id}", json={"alt": "x"}).status_code == 401


def test_read_only_key_can_list_but_not_patch_media(client):
    media_id = client.post("/api/media", headers=bearer(), files={"file": ("p.png", PNG, "image/png")}).json()["id"]
    assert client.get("/api/media?limit=1", headers=bearer("audit-key")).status_code == 200
    forbidden = client.patch(f"/api/media/{media_id}", headers=bearer("audit-key"), json={"alt": "x"})
    assert forbidden.status_code == 403 and forbidden.json()["error"]["code"] == "forbidden"
    anything = client.patch("/api/media/anything", headers=bearer("audit-key"), json={"alt": "x"})
    assert anything.status_code == 403
    assert client.get("/api/media", headers=bearer("audit-key")).json()["items"][0].get("alt") is None


def test_media_library_needs_a_key(client):
    assert client.get("/api/media").status_code == 401
    assert client.patch("/api/media/x", json={"alt": "x"}).status_code == 401


def test_path_traversal_ids_are_a_clean_404_through_the_app(tmp_path):
    store = FileStore(tmp_path / "site", media_url_base="/media")
    app = create_app(store=store, api_keys=KEYS, config=make_config())
    from fastapi.testclient import TestClient

    client = TestClient(app)
    for hostile in ("..%2F..%2Fsecret", "..", "%2e%2e", "a%5Cb", "0123456789abcdef-%2A"):
        response = client.patch(f"/api/media/{hostile}", headers=bearer(), json={"alt": "x"})
        assert response.status_code == 404, hostile
        assert response.json()["error"]["code"] == "not_found"


# --- a store without the optional methods -----------------------------------


class SaveOnlyStore(MemoryStore):
    """Can save media but not list or update it."""

    list_media = None  # type: ignore[assignment]
    update_media = None  # type: ignore[assignment]


def test_a_store_without_listing_or_updating_has_no_such_endpoints():
    api = Api(create_app(store=SaveOnlyStore(), api_keys=KEYS, config=make_config()))
    assert api.post_media(files={"file": ("p.png", PNG, "image/png")}).status_code == 200
    listing = api.get("/api/media")
    assert listing.status_code == 404 and error_code(listing) == "not_found"
    update = api.patch("/api/media/0123456789abcdef", json={"alt": "x"})
    assert update.status_code == 404 and error_code(update) == "not_found"
    assert api.get("/api/inkwire").json()["features"][-1] == "media"


def test_a_store_without_media_has_no_media_endpoints_at_all():
    class ContentOnly(MemoryStore):
        media = None  # type: ignore[assignment]
        list_media = None  # type: ignore[assignment]
        update_media = None  # type: ignore[assignment]

    api = Api(create_app(store=ContentOnly(), api_keys=KEYS, config=make_config()))
    assert api.post_media(files={"file": ("p.png", PNG, "image/png")}).status_code == 404
    assert api.get("/api/media").status_code == 404
    assert api.patch("/api/media/0123456789abcdef", json={"alt": "x"}).status_code == 404
    assert api.get("/api/inkwire").json()["features"] == ["upsert", "list", "get", "update", "delete", "terms"]


def test_the_url_variant_without_a_fetcher_is_a_400_not_a_500():
    api = Api(create_app(store=MemoryStore(), api_keys=KEYS, config=make_config()))
    response = api.post("/api/media", json={"url": "https://example.test/a.png"})
    assert response.status_code == 400 and error_code(response) == "invalid_payload"


def test_image_size_reads_every_accepted_format():
    from inkwire_receiver.media import image_size

    assert image_size(bytes.fromhex("474946383961" "2003" "1000"), "image/gif") == (800, 16)
    assert image_size(bytes.fromhex("ffd8" "ffe00004abcd" "ffc2000b08012c019003012200"), "image/jpeg") == (400, 300)
    vp8x = b"RIFF\0\0\0\0WEBPVP8X" + bytes(4) + bytes(4) + (1919).to_bytes(3, "little") + (1079).to_bytes(3, "little")
    assert image_size(vp8x, "image/webp") == (1920, 1080)
    ispe = (20).to_bytes(4, "big") + b"ispe" + bytes(4) + (1200).to_bytes(4, "big") + (630).to_bytes(4, "big")
    assert image_size(bytes.fromhex("0000001c667479706176696600000000") + ispe, "image/avif") == (1200, 630)
    assert image_size(bytes.fromhex("ffd8ff"), "image/jpeg") is None
