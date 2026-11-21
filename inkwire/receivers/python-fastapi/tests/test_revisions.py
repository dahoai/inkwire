"""Undo (feature ``revisions``) on both stores: history, restore, undelete, renames, the keep limit."""

from inkwire_receiver import Limits
from inkwire_receiver.app import create_app
from tests.conftest import KEYS, RO_KEY, Api, error_code, make_config


def site(store, **limits):
    return Api(create_app(store=store, api_keys=KEYS, config=make_config(limits=Limits(**limits) if limits else None)))


def history(api, id):
    return api.get(f"/api/content/{id}/revisions").json()["items"]


def test_an_edit_is_undone_and_the_undo_is_undoable(any_store):
    api = site(any_store)
    made = api.post("/api/content", json={"external_id": "a", "title": "Before", "markdown": "one", "status": "published"}).json()
    api.patch(f"/api/content/{made['id']}", json={"title": "After", "markdown": "two"})
    [last] = history(api, made["id"])
    assert (last["replaced_by"], last["title"]) == ("update", "Before")
    full = api.get(f"/api/content/{made['id']}/revisions/{last['revision']}").json()
    assert full["entry"]["markdown"] == "one" and "title" in full["entry"]["seo"]

    back = api.post(f"/api/content/{made['id']}/restore", json={"revision": last["revision"]})
    assert back.status_code == 200 and back.json()["markdown"] == "one" and back.headers["etag"]
    assert [h["replaced_by"] for h in history(api, made["id"])] == ["restore", "update"]
    assert error_code(api.post(f"/api/content/{made['id']}/restore", json={"revision": "nope"})) == "not_found"
    assert error_code(api.post(f"/api/content/{made['id']}/restore", json={})) == "invalid_payload"
    assert error_code(api.post(f"/api/content/{made['id']}/restore", json={"revision": last["revision"]}, key=RO_KEY)) == "forbidden"


def test_a_deleted_entry_comes_back_and_history_follows_a_rename(any_store):
    api = site(any_store)
    made = api.post("/api/content", json={"external_id": "d", "title": "Doc", "slug": "old", "markdown": "keep me"}).json()
    moved = api.patch(f"/api/content/{made['id']}", json={"slug": "new"}).json()
    assert history(api, moved["id"])[0]["slug"] == "old"  # the history moved with the id
    api.delete(f"/api/content/{moved['id']}")
    gone = history(api, moved["id"])[0]
    assert gone["replaced_by"] == "delete"
    back = api.post(f"/api/content/{moved['id']}/restore", json={"revision": gone["revision"]}).json()
    assert (back["id"], back["markdown"]) == (moved["id"], "keep me")
    assert error_code(api.get("/api/content/post:never/revisions")) == "not_found"


def test_only_the_newest_versions_are_kept(any_store):
    api = site(any_store, revisions=2)
    made = api.post("/api/content", json={"external_id": "k", "title": "v1", "markdown": "x"}).json()
    for n in (2, 3, 4):
        api.patch(f"/api/content/{made['id']}", json={"title": f"v{n}"})
    assert [h["title"] for h in history(api, made["id"])] == ["v3", "v2"]
