"""Warnings + dry runs, redirects, translations, image sizes and the page helpers, on both stores."""

import asyncio

import pytest

from inkwire_receiver import MemoryStore, alternates, resolve_redirect, sitemap_entries
from inkwire_receiver.app import create_app
from tests.conftest import KEYS, PNG, RO_KEY, Api, error_code, make_config


@pytest.fixture
def site(any_store):
    return Api(create_app(store=any_store, api_keys=KEYS, config=make_config(limits=None))), any_store


def post(api, qs="", key="dev-key", **body):
    slug = body.get("slug", "x")
    body = {"external_id": slug, "title": f"Title {slug}", "markdown": "## Body", "status": "published", **body}
    return api.post(f"/api/content{qs}", json=body, key=key)


def codes(response):
    return sorted(w["code"] for w in response.json()["warnings"])


def test_writes_carry_warnings_and_a_dry_run_writes_nothing(site):
    api, _ = site
    assert post(api, slug="one", title="Same", excerpt="First").json()["warnings"] == []
    check = post(api, "?dry_run=true", slug="two", title="Same", markdown="# Big\n\n![](https://x.test/a.png)")
    assert check.status_code == 200
    assert check.json()["dry_run"] is True and check.json()["id"] is None
    assert check.json()["url"] == "https://acme.test/blog/two"
    assert codes(check) == ["description_missing", "h1_extra", "image_alt_missing", "title_duplicate"]
    assert api.get("/api/content?slug=two").json()["items"] == []
    assert post(api, "?dry_run=maybe", slug="two").status_code == 400


def test_a_read_only_key_may_dry_run_but_not_write(site):
    api, _ = site
    assert post(api, "?dry_run=true", key=RO_KEY, slug="ro").status_code == 200
    assert post(api, key=RO_KEY, slug="ro").status_code == 403


def test_links_to_missing_drafts_and_moved_pages(site):
    api, _ = site
    post(api, slug="draft-page", status="draft", excerpt="d")
    moved = post(api, slug="old-name", excerpt="m").json()
    api.patch(f"/api/content/{moved['id']}", json={"slug": "new-name"})
    body = "## Links\n\n[gone](/blog/nothing-here) [wip](/blog/draft-page) [old](/blog/old-name) [click here](/blog/new-name)"
    check = post(api, "?dry_run=true", slug="linker", excerpt="l", markdown=body)
    assert codes(check) == ["anchor_generic", "link_broken", "link_redirect"]
    broken = next(w for w in check.json()["warnings"] if w["code"] == "link_broken")["message"]
    assert "/blog/nothing-here" in broken and "/blog/draft-page (a draft)" in broken


def test_links_to_pages_outside_the_store_are_fine_when_it_says_so():
    class WithFiles(MemoryStore):
        async def page_exists(self, key, path):
            return path == "/blog/hand-written"

    api = Api(create_app(store=WithFiles(), api_keys=KEYS, config=make_config(limits=None)))
    post(api, slug="live", excerpt="l")
    check = post(api, "?dry_run=true", slug="linker", excerpt="k", markdown="## L\n\n[file](/blog/hand-written) [gone](/blog/no-such-post)")
    assert codes(check) == ["link_broken"]
    assert "hand-written" not in check.json()["warnings"][0]["message"]


def test_patch_dry_run_previews_without_writing_or_etag(site):
    api, _ = site
    created = post(api, slug="p", excerpt="e").json()
    before = api.get(f"/api/content/{created['id']}")
    preview = api.patch(f"/api/content/{created['id']}?dry_run=true", json={"title": "New"}, headers={"if-match": before.headers["etag"]})
    assert preview.status_code == 200 and preview.json()["title"] == "New" and preview.json()["dry_run"] is True
    assert "etag" not in preview.headers
    assert api.get(f"/api/content/{created['id']}").json()["title"] == "Title p"
    stale = api.patch(f"/api/content/{created['id']}?dry_run=true", json={"title": "x"}, headers={"if-match": '"nope"'})
    assert stale.status_code == 412


def test_a_slug_change_redirects_from_the_old_address(site):
    api, store = site
    created = post(api, slug="first", excerpt="e").json()
    renamed = api.patch(f"/api/content/{created['id']}", json={"slug": "second"}).json()
    again = api.patch(f"/api/content/{renamed['id']}", json={"slug": "third"}).json()
    for old in ("first", "second"):
        r = api.get(f"/api/redirects?kind=post&slug={old}")
        assert r.status_code == 200 and r.json()["id"] == again["id"] and r.json()["url"].endswith("/blog/third")
    assert error_code(api.get("/api/redirects?kind=post&slug=third")) == "not_found"  # it lives there
    assert error_code(api.get("/api/redirects?kind=post&slug=never")) == "not_found"
    assert asyncio.run(resolve_redirect(store, "default", "post", "first", make_config()))["slug"] == "third"
    post(api, slug="first", external_id="new", excerpt="n")  # a new entry takes the old address
    assert asyncio.run(resolve_redirect(store, "default", "post", "first", make_config())) is None
    api.delete(f"/api/content/{again['id']}")
    assert error_code(api.get("/api/redirects?kind=post&slug=second")) == "not_found"  # target gone


def test_translations_filter_and_hreflang(site):
    api, store = site
    en = post(api, slug="home", lang="en", translation_key="home", excerpt="Hello").json()
    post(api, slug="accueil", external_id="fr", lang="fr", translation_key="home", title="Accueil", excerpt="Bonjour")
    assert sorted(i["lang"] for i in api.get("/api/content?translation_key=home").json()["items"]) == ["en", "fr"]
    assert codes(post(api, "?dry_run=true", slug="other", external_id="fr2", lang="fr", translation_key="home", excerpt="z")) == [
        "translation_lang_duplicate"
    ]
    assert post(api, slug="bad", lang="not a tag").status_code == 400
    entry = asyncio.run(store.get("default", en["id"]))
    assert asyncio.run(alternates(store, "default", entry, make_config())) == [
        {"lang": "en", "url": "https://acme.test/blog/home"},
        {"lang": "fr", "url": "https://acme.test/blog/accueil"},
    ]
    cleared = api.patch(f"/api/content/{en['id']}", json={"lang": None, "translation_key": None}).json()
    assert "lang" not in cleared and "translation_key" not in cleared


def test_a_store_without_translations_refuses_the_fields():
    class Plain(MemoryStore):
        translations = False

    api = Api(create_app(store=Plain(), api_keys=KEYS, config=make_config()))
    assert error_code(post(api, slug="x", lang="en")) == "invalid_payload"
    assert error_code(api.get("/api/content?lang=en")) == "invalid_payload"
    assert "translations" not in api.get("/api/inkwire").json()["features"]


def test_sitemap_lists_public_indexable_self_canonical_entries(site):
    api, store = site
    post(api, slug="live", excerpt="a")
    post(api, slug="hidden", excerpt="b", seo={"noindex": True})
    post(api, slug="wip", excerpt="c", status="draft")
    post(api, slug="elsewhere", excerpt="d", canonical_url="https://other.test/x")
    urls = [e["url"] for e in asyncio.run(sitemap_entries(store, "default", make_config()))]
    assert urls == ["https://acme.test/blog/live"]


def test_library_images_get_their_size_in_the_html(site):
    api, store = site
    up = api.post_media(files={"file": ("dot.png", PNG, "image/png")}).json()
    assert (up["width"], up["height"]) == (1, 1)
    created = post(api, slug="pic", excerpt="p", markdown=f"![a dot]({up['url']}) ![other](https://x.test/b.png)").json()
    html = api.get(f"/api/content/{created['id']}").json()["html"]
    if isinstance(store, MemoryStore):  # the file store renders on read, from the markdown alone
        assert f'src="{up["url"]}" width="1" height="1"' in html
    assert 'src="https://x.test/b.png">' in html or 'src="https://x.test/b.png" />' in html
