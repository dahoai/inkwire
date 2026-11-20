import asyncio
import json
from pathlib import Path

import pytest

from inkwire_receiver import FileStore, InkwireError, ListFilter, split_frontmatter
from tests.conftest import PNG, SVG

KEY = "default"


def run(coro):
    return asyncio.run(coro)


def entry(**overrides):
    values = {
        "id": "",
        "kind": "post",
        "title": "Hello world",
        "slug": "hello-world",
        "markdown": "# Hello world\n\nThe body.",
        "html": "",
        "external_id": "ext-1",
        "status": "published",
        "published_at": "2026-01-02T03:04:05Z",
        "updated_at": "2026-01-02T03:04:05Z",
        "version": 1,
    }
    values.update(overrides)
    return values


def test_round_trips_an_entry(tmp_path):
    store = FileStore(tmp_path, media_url_base="https://site.test/media")
    saved = run(store.save(KEY, entry()))
    assert saved["id"] == "post:hello-world"
    assert saved["title"] == "Hello world"
    assert saved["external_id"] == "ext-1"
    assert saved["status"] == "published"
    assert saved["markdown"].strip() == "# Hello world\n\nThe body."
    assert saved["published_at"] == "2026-01-02T03:04:05Z"
    assert saved["etag"]

    path = tmp_path / "post" / "hello-world.md"
    assert path.is_file()
    text = path.read_text()
    assert text.startswith("---\n")
    front, body = split_frontmatter(text)
    assert front["title"] == "Hello world"
    assert front["external_id"] == "ext-1"
    assert "Hello world" in body

    again = run(store.get(KEY, "post:hello-world"))
    assert again is not None
    assert again["markdown"].strip() == "# Hello world\n\nThe body."


def test_reads_a_hand_written_file_with_no_frontmatter(tmp_path):
    directory = tmp_path / "post"
    directory.mkdir()
    (directory / "audit-day-one.md").write_text("# Audit day one\n\nAn existing post.\n")
    store = FileStore(tmp_path)
    found = run(store.get(KEY, "post:audit-day-one"))
    assert found is not None
    assert found["kind"] == "post"
    assert found["title"] == "Audit day one"
    assert found["external_id"] is None
    assert found["status"] == "published"
    assert found["excerpt"] is None
    assert "existing post" in found["markdown"].lower()
    assert found["html"].startswith("<h1>")


def test_reads_partial_frontmatter(tmp_path):
    directory = tmp_path / "page"
    directory.mkdir()
    (directory / "about.md").write_text(
        "---\n"
        "title: About us\n"
        "tags:\n  - company\n"
        "seo:\n  noindex: true\n"
        "published_at: 2026-07-22T04:00:00Z\n"
        "---\n"
        "Body without a heading.\n"
    )
    store = FileStore(tmp_path)
    found = run(store.get(KEY, "page:about"))
    assert found is not None
    assert found["title"] == "About us"
    assert found["kind"] == "page"
    assert found["status"] == "published"
    assert found["tags"] == ["company"]
    assert found["seo"] == {"noindex": True}
    # YAML hands back a datetime object; the store normalizes it to an RFC 3339 string
    assert found["published_at"] == "2026-07-22T04:00:00Z"


def test_a_title_falls_back_to_the_slug(tmp_path):
    directory = tmp_path / "post"
    directory.mkdir()
    (directory / "no-heading.md").write_text("Just body text, no heading.\n")
    assert run(FileStore(tmp_path).get(KEY, "post:no-heading"))["title"] == "no-heading"


def test_refuses_traversal_names(tmp_path):
    store = FileStore(tmp_path)
    for slug in ("../escape", "..", "a/b", "A-B", "with space", ""):
        assert run(store.get(KEY, f"post:{slug}")) is None
    with pytest.raises(InkwireError):
        run(store.save(KEY, entry(slug="../../etc/passwd")))
    with pytest.raises(InkwireError):
        run(store.save(KEY, entry(kind="../post")))
    assert not (tmp_path.parent / "escape.md").exists()
    # a hostile id never resolves to a path
    assert run(store.get(KEY, "../../etc/passwd")) is None


def test_etag_changes_when_the_file_is_touched(tmp_path):
    store = FileStore(tmp_path)
    run(store.save(KEY, entry()))
    path = tmp_path / "post" / "hello-world.md"
    before = run(store.get(KEY, "post:hello-world"))["etag"]

    stat = path.stat()
    import os

    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    after = run(store.get(KEY, "post:hello-world"))["etag"]
    assert before != after


def test_changing_the_slug_moves_the_file(tmp_path):
    store = FileStore(tmp_path)
    saved = run(store.save(KEY, entry()))
    saved["slug"] = "renamed"
    run(store.save(KEY, saved))
    assert not (tmp_path / "post" / "hello-world.md").exists()
    assert (tmp_path / "post" / "renamed.md").is_file()
    assert run(store.get(KEY, "post:hello-world")) is None
    moved = run(store.get(KEY, "post:renamed"))
    assert moved["slug"] == "renamed"
    assert moved["title"] == "Hello world"


def test_changing_the_kind_moves_the_file(tmp_path):
    store = FileStore(tmp_path)
    saved = run(store.save(KEY, entry()))
    saved["kind"] = "page"
    run(store.save(KEY, saved))
    assert not (tmp_path / "post" / "hello-world.md").exists()
    assert (tmp_path / "page" / "hello-world.md").is_file()


def test_list_filters_across_kinds(tmp_path):
    store = FileStore(tmp_path)
    run(store.save(KEY, entry()))
    run(store.save(KEY, entry(id="", kind="page", slug="about", title="About", external_id="ext-2", published_at="2026-02-01T00:00:00Z")))
    run(store.save(KEY, entry(id="", slug="draft-one", title="Draft", external_id="ext-3", status="draft", tags=["hidden"])))

    everything, cursor = run(store.list(KEY, ListFilter()))
    assert len(everything) == 3 and cursor is None
    assert [e["title"] for e in everything][0] == "About"  # newest first

    pages, _ = run(store.list(KEY, ListFilter(kind="page")))
    assert [e["slug"] for e in pages] == ["about"]

    drafts, _ = run(store.list(KEY, ListFilter(status="draft")))
    assert [e["slug"] for e in drafts] == ["draft-one"]

    tagged, _ = run(store.list(KEY, ListFilter(tag="hidden")))
    assert [e["slug"] for e in tagged] == ["draft-one"]

    searched, _ = run(store.list(KEY, ListFilter(search="draft")))
    assert [e["slug"] for e in searched] == ["draft-one"]

    exact, _ = run(store.list(KEY, ListFilter(external_id="ext-1")))
    assert len(exact) == 1


def test_pagination(tmp_path):
    store = FileStore(tmp_path)
    for index in range(3):
        run(store.save(KEY, entry(id="", slug=f"p-{index}", title=f"P {index}", external_id=f"e-{index}")))
    first, cursor = run(store.list(KEY, ListFilter(limit=2)))
    assert len(first) == 2 and cursor
    second, rest = run(store.list(KEY, ListFilter(limit=2, cursor=cursor)))
    assert len(second) == 1 and rest is None


def test_remove(tmp_path):
    store = FileStore(tmp_path)
    run(store.save(KEY, entry()))
    assert run(store.remove(KEY, "post:hello-world")) is True
    assert run(store.get(KEY, "post:hello-world")) is None
    assert run(store.remove(KEY, "post:hello-world")) is False
    assert run(store.remove(KEY, "../nope")) is False


def test_media_is_written_with_a_meta_sidecar(tmp_path):
    store = FileStore(tmp_path, media_url_base="https://site.test/media")
    from inkwire_receiver import MediaUpload

    result = run(store.media(KEY, MediaUpload(data=PNG, filename="px.png", content_type="image/png", alt="One pixel")))
    assert result.url.startswith("https://site.test/media/")
    assert result.url.endswith(".png")
    name = result.url.rsplit("/", 1)[-1]
    assert (tmp_path / "media" / name).read_bytes() == PNG
    meta = json.loads((tmp_path / "media" / f"{name}.meta.json").read_text())
    assert meta["alt"] == "One pixel"
    assert meta["mime_type"] == "image/png"


def test_fetch_media_uses_the_injected_fetcher_and_refuses_svg(tmp_path):
    async def fake_fetch(url):
        return PNG, "ok.png", "image/png"

    store = FileStore(tmp_path, media_url_base="/media", fetcher=fake_fetch)
    result = run(store.fetch_media(KEY, "https://example.test/ok.png", "Alt"))
    assert result.alt == "Alt"
    assert result.url.startswith("/media/")

    async def svg_fetch(url):
        return SVG, "x.png", "image/png"

    svg_store = FileStore(tmp_path, fetcher=svg_fetch)
    with pytest.raises(InkwireError):
        run(svg_store.fetch_media(KEY, "https://example.test/x.png"))


def test_no_fetcher_means_no_remote_media(tmp_path):
    with pytest.raises(InkwireError):
        run(FileStore(tmp_path).fetch_media(KEY, "https://example.test/a.png"))


def test_categories_cover_alt_and_the_new_seo_overrides_survive_the_frontmatter(tmp_path):
    store = FileStore(tmp_path)
    json_ld = '{"@context":"https://schema.org","@type":"FAQPage"}'
    run(
        store.save(
            KEY,
            entry(
                categories=["Guides", "How-to: a title"],
                cover_image_url="https://images.test/c.jpg",
                cover_image_alt="A: tricky 'alt'",
                seo={"og_title": "OG: title", "og_description": "OG description", "json_ld": json_ld, "noindex": True},
            ),
        )
    )
    front, _ = split_frontmatter((tmp_path / "post" / "hello-world.md").read_text())
    assert front["categories"] == ["Guides", "How-to: a title"]
    assert front["cover_image_alt"] == "A: tricky 'alt'"
    assert front["seo"]["json_ld"] == json_ld

    again = run(FileStore(tmp_path).get(KEY, "post:hello-world"))
    assert again["categories"] == ["Guides", "How-to: a title"]
    assert again["cover_image_alt"] == "A: tricky 'alt'"
    assert again["seo"] == {"og_title": "OG: title", "og_description": "OG description", "json_ld": json_ld, "noindex": True}


def test_unset_categories_and_cover_alt_are_not_written(tmp_path):
    store = FileStore(tmp_path)
    run(store.save(KEY, entry(categories=None, cover_image_alt=None)))
    text = (tmp_path / "post" / "hello-world.md").read_text()
    assert "categories" not in text and "cover_image_alt" not in text
    again = run(store.get(KEY, "post:hello-world"))
    assert again["categories"] is None and again["cover_image_alt"] is None


def test_a_hand_written_file_may_carry_categories(tmp_path):
    (tmp_path / "post").mkdir()
    (tmp_path / "post" / "by-hand.md").write_text("---\ntitle: By hand\ncategories: [A, B]\ncover_image_alt: Hand alt\n---\n\nbody")
    got = run(FileStore(tmp_path).get(KEY, "post:by-hand"))
    assert got["categories"] == ["A", "B"] and got["cover_image_alt"] == "Hand alt"
