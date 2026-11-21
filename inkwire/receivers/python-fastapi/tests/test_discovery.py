"""Discovery: the features come from the store and the config, never from a list somebody keeps in sync."""

import asyncio

import pytest

from inkwire_receiver import (
    FileStore,
    InkwireConfig,
    KNOWN_FEATURES,
    Limits,
    MemoryStore,
    Site,
    discovery_body,
    handle_discovery,
    parse_api_keys,
)
from inkwire_receiver.app import create_app
from tests.conftest import KEYS, Api, bearer, make_config

ALWAYS = ["upsert", "list", "get", "update", "delete", "terms"]
SEO = ["revisions", "warnings", "redirects", "translations"]
FULL = ALWAYS + ["media", "media_list", "media_update"] + SEO
FULL_WITH_URLS = ALWAYS + ["media", "media_url", "media_list", "media_update"] + SEO


def features(store, **config):
    return discovery_body(store, make_config(**config))["features"]


def test_a_full_store_advertises_everything_but_schedule():
    assert features(MemoryStore()) == FULL


def test_the_file_store_advertises_the_media_library(tmp_path):
    assert features(FileStore(tmp_path)) == FULL


def test_schedule_is_a_config_flag_and_off_by_default():
    assert InkwireConfig().schedule is False
    assert "schedule" not in features(MemoryStore())
    assert features(MemoryStore(), schedule=True) == ALWAYS + ["schedule", "media", "media_list", "media_update"] + SEO


@pytest.mark.parametrize(
    "missing, expected",
    [
        ((), FULL),
        (("update_media",), ALWAYS + ["media", "media_list"] + SEO),
        (("list_media",), ALWAYS + ["media", "media_update"] + SEO),
        (("list_media", "update_media"), ALWAYS + ["media"] + SEO),
        (("media", "list_media", "update_media"), ALWAYS + SEO),
        (("save_redirect",), ALWAYS + ["media", "media_list", "media_update", "revisions", "warnings", "translations"]),
        (("save_revision",), ALWAYS + ["media", "media_list", "media_update", "warnings", "redirects", "translations"]),
    ],
)
def test_media_features_follow_what_the_store_can_do(missing, expected):
    class Partial(MemoryStore):
        pass

    for name in missing:
        setattr(Partial, name, None)
    assert features(Partial()) == expected


def test_media_does_not_depend_on_being_able_to_fetch_urls():
    # no fetcher: the {url} variant is refused, but the store still saves files
    assert "media" in features(MemoryStore(fetcher=None))
    assert "media" in features(MemoryStore(fetcher=lambda url: None))


def test_the_config_has_no_feature_list_to_set():
    with pytest.raises(TypeError):
        InkwireConfig(features=["media"])  # type: ignore[call-arg]


def test_every_derived_feature_is_a_known_one():
    assert set(FULL + ["schedule", "media_url"]) == set(KNOWN_FEATURES)
    assert set(features(MemoryStore(), schedule=True)) <= set(KNOWN_FEATURES)


def test_site_carries_description_and_language():
    site = Site(name="Acme", url="https://acme.test", description="Acme's blog", language="en")
    body = discovery_body(MemoryStore(), InkwireConfig(site=site, kinds=["post"]))
    assert body["site"] == {"name": "Acme", "url": "https://acme.test", "description": "Acme's blog", "language": "en"}
    assert body["kinds"] == ["post"]


def test_site_omits_what_is_not_set():
    body = discovery_body(MemoryStore(), InkwireConfig(site=Site(name="Acme", language="fr-CA")))
    assert body["site"] == {"name": "Acme", "language": "fr-CA"}
    assert "site" not in discovery_body(MemoryStore(), InkwireConfig(site=Site()))
    assert "site" not in discovery_body(MemoryStore(), InkwireConfig())


def test_limits_are_unchanged():
    body = discovery_body(MemoryStore(), InkwireConfig(limits=Limits(markdown_bytes=10, media_bytes=20)))
    assert body["limits"] == {"markdown_bytes": 10, "media_bytes": 20, "revisions": 50}
    kept = discovery_body(MemoryStore(), InkwireConfig(limits=Limits(revisions=3)))
    assert kept["limits"] == {"revisions": 3}


def test_the_discovery_endpoint(api):
    response = api.get("/api/inkwire")
    assert response.status_code == 200
    assert response.headers["inkwire-version"] == "1"
    body = response.json()
    assert body["features"] == FULL
    assert body["kinds"] == ["post", "page"]


def test_the_handler_wants_the_store():
    status, headers, body = asyncio.run(
        handle_discovery(auth_header="Bearer dev-key", keys=KEYS, store=MemoryStore(), config=make_config())
    )
    assert status == 200 and body["features"] == FULL and headers["Inkwire-Version"] == "1"


def test_discovery_needs_a_key_but_a_read_only_one_will_do(api):
    assert api.get("/api/inkwire", key=None).status_code == 401
    assert api.get("/api/inkwire", key="audit-key").status_code == 200


def test_the_reference_app_leaves_schedule_off_and_reads_the_site_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("INKWIRE_STORE", "file")
    monkeypatch.setenv("INKWIRE_ROOT", str(tmp_path))
    monkeypatch.setenv("INKWIRE_SITE_NAME", "Env site")
    monkeypatch.setenv("INKWIRE_SITE_URL", "https://env.test")
    monkeypatch.setenv("INKWIRE_SITE_DESCRIPTION", "From the environment")
    monkeypatch.setenv("INKWIRE_SITE_LANGUAGE", "fr")
    app = create_app(api_keys="dev-key")
    body = Api(app).get("/api/inkwire").json()
    assert body["site"] == {
        "name": "Env site",
        "url": "https://env.test",
        "description": "From the environment",
        "language": "fr",
    }
    assert body["features"] == FULL_WITH_URLS
    assert "schedule" not in body["features"]


def test_a_future_published_at_is_stored_and_read_back_as_sent(api, create):
    created = create(external_id="later", status="published", published_at="2099-01-01T00:00:00.000Z")
    entry = api.get(f"/api/content/{created['id']}").json()
    assert (entry["status"], entry["published_at"]) == ("published", "2099-01-01T00:00:00.000Z")


def test_media_url_is_advertised_only_with_a_fetcher():
    async def fetcher(url):  # never called here
        raise AssertionError(url)

    assert "media_url" not in features(MemoryStore())
    assert "media_url" in features(MemoryStore(fetcher=fetcher))
