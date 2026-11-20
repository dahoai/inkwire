"""categories, cover_image_alt and the og_title / og_description / json_ld SEO overrides."""

import json

import pytest

from inkwire_receiver import effective_seo, merge_overrides, PatchSeo
from tests.conftest import bearer, error_code

JSON_LD = '{"@context":"https://schema.org","@type":"FAQPage"}'


def entry_of(api, created):
    return api.get(f"/api/content/{created['id']}").json()


def test_categories_and_cover_alt_round_trip(api, create):
    created = create(
        external_id="x-1",
        categories=["Guides", "How-to"],
        cover_image_url="https://images.test/c.jpg",
        cover_image_alt="A cover",
    )
    entry = entry_of(api, created)
    assert entry["categories"] == ["Guides", "How-to"]
    assert entry["cover_image_alt"] == "A cover"
    summary = api.get("/api/content").json()["items"][0]
    assert summary["categories"] == ["Guides", "How-to"]
    assert "cover_image_alt" not in summary


def test_unset_categories_are_absent_and_cover_alt_is_null(api, create):
    created = create(external_id="x-2")
    entry = entry_of(api, created)
    assert "categories" not in entry
    assert entry["cover_image_alt"] is None


@pytest.mark.parametrize(
    "extra",
    [
        {"categories": "Guides"},
        {"categories": [""]},
        {"categories": ["x" * 65]},
        {"categories": ["a"] * 51},
        {"categories": [1]},
        {"categories": None},
        {"cover_image_alt": "x" * 1025},
        {"cover_image_alt": None},
        {"cover_image_alt": 5},
    ],
)
def test_bad_categories_and_cover_alt_are_400(api, extra):
    response = api.post("/api/content", json={"external_id": "bad", "title": "t", "markdown": "m", **extra})
    assert response.status_code == 400, extra
    assert error_code(response) == "invalid_payload"


def test_category_limits_are_inclusive(api):
    response = api.post(
        "/api/content",
        json={
            "external_id": "edge",
            "title": "t",
            "markdown": "m",
            "categories": ["c" * 64] * 50,
            "cover_image_alt": "a" * 1024,
        },
    )
    assert response.status_code == 200, response.text


def test_new_seo_overrides_round_trip_and_default(api, create):
    created = create(
        external_id="s-1",
        title="Plain",
        excerpt="Plain excerpt",
        seo={"og_title": "OG title", "og_description": "OG description", "json_ld": JSON_LD},
    )
    seo = entry_of(api, created)["seo"]
    assert seo["og_title"] == "OG title"
    assert seo["og_description"] == "OG description"
    assert seo["json_ld"] == JSON_LD
    # the other effective values still come from the entry
    assert seo["title"] == "Plain" and seo["description"] == "Plain excerpt"


def test_og_defaults_follow_the_effective_title_and_description(api, create):
    created = create(external_id="s-2", title="Entry", excerpt="Entry excerpt", seo={"title": "SEO title", "description": "SEO desc"})
    seo = entry_of(api, created)["seo"]
    assert seo["og_title"] == "SEO title"
    assert seo["og_description"] == "SEO desc"
    assert "json_ld" not in seo


def test_og_description_falls_back_to_the_title_without_an_excerpt(api, create):
    created = create(external_id="s-3", title="Only title")
    seo = entry_of(api, created)["seo"]
    assert seo["og_title"] == seo["og_description"] == "Only title"


@pytest.mark.parametrize(
    "json_ld",
    [
        "{not json",
        '"text"',
        "42",
        "null",
        "true",
        "[]",
        "[1, 2]",
        '[{"a": 1}, "b"]',
        "x",
        "x" * 20001,
        "",
    ],
)
def test_json_ld_must_be_an_object_or_array_of_objects(api, json_ld):
    response = api.post(
        "/api/content", json={"external_id": "j", "title": "t", "markdown": "m", "seo": {"json_ld": json_ld}}
    )
    assert response.status_code == 400, json_ld
    assert error_code(response) == "invalid_payload"


@pytest.mark.parametrize("json_ld", ['{"a":1}', '[{"a":1},{"b":2}]', "{}"])
def test_json_ld_accepts_objects_and_arrays_of_objects(api, json_ld):
    response = api.post(
        "/api/content", json={"external_id": "j-ok", "title": "t", "markdown": "m", "seo": {"json_ld": json_ld}}
    )
    assert response.status_code == 200, response.text


def test_json_ld_at_the_size_limit_is_accepted(api):
    padding = "a" * (20000 - len('{"k":""}'))
    response = api.post(
        "/api/content",
        json={"external_id": "j-max", "title": "t", "markdown": "m", "seo": {"json_ld": json.dumps({"k": padding}, separators=(",", ":"))}},
    )
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "seo",
    [
        {"og_title": ""},
        {"og_description": ""},
        {"og_title": "x" * 513},
        {"og_description": "x" * 1025},
        {"og_title": None},
        {"og_description": None},
        {"json_ld": None},
        {"og_image": "https://images.test/x.jpg"},
    ],
)
def test_bad_new_seo_overrides_are_400_on_create(api, seo):
    response = api.post("/api/content", json={"external_id": "bad-seo", "title": "t", "markdown": "m", "seo": seo})
    assert response.status_code == 400, seo
    assert error_code(response) == "invalid_payload"


def test_patch_merges_per_key_and_json_ld_null_drops_it(api, create):
    created = create(external_id="p-1", seo={"og_title": "keep me", "json_ld": JSON_LD})
    response = api.patch(f"/api/content/{created['id']}", json={"seo": {"og_description": "new desc"}})
    assert response.status_code == 200
    seo = response.json()["seo"]
    assert (seo["og_title"], seo["og_description"], seo["json_ld"]) == ("keep me", "new desc", JSON_LD)

    response = api.patch(f"/api/content/{created['id']}", json={"seo": {"json_ld": None}})
    assert response.status_code == 200
    seo = response.json()["seo"]
    assert "json_ld" not in seo
    assert seo["og_title"] == "keep me"


def test_patch_seo_null_clears_every_override(api, create):
    created = create(external_id="p-2", title="T", seo={"og_title": "x", "json_ld": JSON_LD})
    seo = api.patch(f"/api/content/{created['id']}", json={"seo": None}).json()["seo"]
    assert seo["og_title"] == "T" and "json_ld" not in seo


@pytest.mark.parametrize(
    "seo",
    [{"og_title": None}, {"og_description": None}, {"og_title": ""}, {"json_ld": "{bad"}, {"json_ld": '"s"'}, {"json_ld": "x"}, {"nope": 1}],
)
def test_bad_patch_seo_is_400(api, create, seo):
    created = create(external_id="p-bad")
    response = api.patch(f"/api/content/{created['id']}", json={"seo": seo})
    assert response.status_code == 400, seo
    assert error_code(response) == "invalid_payload"


def test_patch_sets_and_clears_categories_and_cover_alt(api, create):
    created = create(external_id="p-3", categories=["A"], cover_image_alt="old")
    response = api.patch(f"/api/content/{created['id']}", json={"categories": ["B", "C"], "cover_image_alt": "new"})
    assert response.json()["categories"] == ["B", "C"]
    assert response.json()["cover_image_alt"] == "new"

    cleared = api.patch(f"/api/content/{created['id']}", json={"categories": None, "cover_image_alt": None}).json()
    assert "categories" not in cleared
    assert cleared["cover_image_alt"] is None
    # omitted fields keep their value
    api.patch(f"/api/content/{created['id']}", json={"categories": ["Z"]})
    assert api.patch(f"/api/content/{created['id']}", json={"title": "again"}).json()["categories"] == ["Z"]


@pytest.mark.parametrize("patch", [{"categories": [""]}, {"categories": "A"}, {"categories": ["x" * 65]}, {"cover_image_alt": "x" * 1025}, {"cover_image_alt": 3}])
def test_bad_patch_categories_and_cover_alt_are_400(api, create, patch):
    created = create(external_id="p-4")
    response = api.patch(f"/api/content/{created['id']}", json=patch)
    assert response.status_code == 400, patch
    assert error_code(response) == "invalid_payload"


def test_list_filter_by_category(api, create):
    create(external_id="c-1", title="In", categories=["Guides", "News"])
    create(external_id="c-2", title="Out", categories=["Other"])
    create(external_id="c-3", title="None")
    items = api.get("/api/content?category=Guides").json()["items"]
    assert [i["title"] for i in items] == ["In"]
    assert items[0]["categories"] == ["Guides", "News"]
    # exact match, like tags
    assert api.get("/api/content?category=guides").json()["items"] == []


def test_read_only_key_reads_the_new_fields(api, create):
    created = create(external_id="ro-1", categories=["A"], cover_image_alt="alt")
    entry = api.get(f"/api/content/{created['id']}", key="audit-key").json()
    assert entry["categories"] == ["A"] and entry["cover_image_alt"] == "alt"


def test_effective_seo_unit():
    entry = {"title": "T", "excerpt": "", "seo": {"og_title": "O", "json_ld": JSON_LD}}
    assert effective_seo(entry) == {
        "title": "T",
        "description": "T",
        "noindex": False,
        "og_title": "O",
        "og_description": "T",
        "json_ld": JSON_LD,
    }


def test_merge_overrides_unit():
    current = {"og_title": "a", "json_ld": JSON_LD, "noindex": True}
    patch = PatchSeo.model_validate({"og_description": "d", "json_ld": None})
    assert merge_overrides(current, patch) == {"og_title": "a", "noindex": True, "og_description": "d"}
    assert merge_overrides({"json_ld": JSON_LD}, PatchSeo.model_validate({"json_ld": None})) is None


def test_the_new_fields_work_through_the_testclient(client):
    response = client.post(
        "/api/content",
        headers=bearer(),
        json={
            "external_id": "tc-1",
            "title": "TestClient",
            "markdown": "m",
            "categories": ["Guides"],
            "cover_image_alt": "alt",
            "seo": {"og_title": "OG"},
        },
    )
    assert response.status_code == 200
    entry = client.get(f"/api/content/{response.json()['id']}", headers=bearer()).json()
    assert (entry["categories"], entry["cover_image_alt"], entry["seo"]["og_title"]) == (["Guides"], "alt", "OG")
