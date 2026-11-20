import pytest

from inkwire_receiver import InkwireError, parse_api_keys
from tests.conftest import FULL_KEY, RO_KEY, error_code


def test_full_key_can_write(api):
    response = api.post("/api/content", json={"external_id": "a", "title": "T", "markdown": "x"})
    assert response.status_code == 200


def test_read_only_key_reads(api, create):
    entry = create(external_id="ro-read", title="Read me")
    assert api.get("/api/content", key=RO_KEY).status_code == 200
    assert api.get(f"/api/content/{entry['id']}", key=RO_KEY).status_code == 200
    assert api.get("/api/inkwire", key=RO_KEY).status_code == 200


def test_read_only_key_cannot_write(api, create):
    entry = create(external_id="ro-target", title="Target")
    responses = {
        "upsert": api.post(
            "/api/content", json={"external_id": "ro-1", "title": "No", "markdown": "x"}, key=RO_KEY
        ),
        "patch": api.patch(f"/api/content/{entry['id']}", json={"title": "No"}, key=RO_KEY),
        "delete": api.delete(f"/api/content/{entry['id']}", key=RO_KEY),
        "media": api.request("POST", "/api/media", json={"url": "https://example.test/a.png"}, key=RO_KEY),
    }
    for name, response in responses.items():
        assert response.status_code == 403, name
        assert error_code(response) == "forbidden", name


def test_unknown_and_missing_keys_are_401(api):
    missing = api.request("POST", "/api/content", key=None, json={"external_id": "x", "title": "x", "markdown": "x"})
    wrong = api.request(
        "POST", "/api/content", key="definitely-wrong", json={"external_id": "x", "title": "x", "markdown": "x"}
    )
    malformed = api.request(
        "POST",
        "/api/content",
        key=None,
        headers={"authorization": "Basic abc"},
        json={"external_id": "x", "title": "x", "markdown": "x"},
    )
    for response in (missing, wrong, malformed):
        assert response.status_code == 401
        assert error_code(response) == "unauthorized"


def test_a_read_only_check_precedes_validation_and_lookup(api):
    # A ro key gets 403 even for a request that would otherwise be 400 or 404.
    bad_body = api.post("/api/content", json={}, key=RO_KEY)
    unknown_id = api.patch("/api/content/no-such-id", json={"title": "x"}, key=RO_KEY)
    assert bad_body.status_code == 403
    assert unknown_id.status_code == 403


def test_parse_api_keys():
    keys = parse_api_keys(" dev-key , audit-key:ro ,, ")
    assert [(k.key, k.ro) for k in keys] == [("dev-key", False), ("audit-key", True)]
    assert parse_api_keys("") == [] and parse_api_keys(None) == []
    # a colon other than the trailing ':ro' is a configuration error, and the key is not echoed
    with pytest.raises(ValueError) as excinfo:
        parse_api_keys("bad:key")
    assert "bad:key" not in str(excinfo.value)


def test_parse_api_keys_scopes_together():
    keys = parse_api_keys("k1,k2:ro", scope="site-a")
    assert {k.scope for k in keys} == {"site-a"}


def test_parsed_keys_are_accepted_by_the_handlers(api):
    assert api.get("/api/content?limit=1", key=FULL_KEY).status_code == 200


def test_authorize_rejects_an_empty_bearer():
    from inkwire_receiver import authorize

    with pytest.raises(InkwireError) as excinfo:
        authorize("Bearer ", parse_api_keys("k"))
    assert excinfo.value.code == "unauthorized"
