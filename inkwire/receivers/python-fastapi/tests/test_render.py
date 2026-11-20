import pytest

from inkwire_receiver import InkwireError
from inkwire_receiver.render import ALLOWED_ATTRIBUTES, ALLOWED_TAGS, edits, render_markdown, slugify


def test_strips_scripts_and_their_contents():
    html = render_markdown("Hi\n\n<script>alert(1)</script>")
    assert "<script" not in html
    assert "alert(1)" not in html


def test_strips_event_handlers_and_javascript_urls():
    html = render_markdown('<a href="javascript:alert(1)" onclick="x()">z</a>')
    assert "onclick" not in html
    assert "javascript:" not in html


def test_strips_disallowed_tags_and_keeps_their_text():
    html = render_markdown('<iframe src="https://evil.test"></iframe><form><input name="x">ok</form>')
    assert "<iframe" not in html and "<form" not in html and "<input" not in html
    assert "ok" in html


@pytest.mark.parametrize("tag", sorted(ALLOWED_TAGS))
def test_every_allowed_tag_survives(tag):
    # table fragments only survive inside a table: python-markdown parses a bare
    # ``<td>`` as an inline HTML span and drops the tag, which is its business.
    if tag in {"caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"}:
        html = render_markdown(f"<table><{tag}>content</{tag}></table>")
    else:
        html = render_markdown(f"<{tag}>content</{tag}>")
    assert f"<{tag}" in html


@pytest.mark.parametrize("tag", ["script", "style", "iframe", "object", "embed", "video", "audio", "canvas", "svg", "form", "input", "select", "textarea"])
def test_tags_outside_the_allowlist_are_dropped(tag):
    html = render_markdown(f'<{tag} class="k">content</{tag}>')
    assert f"<{tag}" not in html
    assert 'class="k"' not in html


def test_the_a_and_img_attribute_rules():
    anchor = render_markdown(
        '<a href="https://x.test/p" name="n" rel="nofollow" class="k" target="_blank" style="color:red">t</a>'
    )
    assert 'href="https://x.test/p"' in anchor
    assert 'name="n"' in anchor
    assert 'rel="nofollow"' in anchor
    assert "class=" not in anchor and "target=" not in anchor and "style=" not in anchor

    image = render_markdown(
        '<img src="https://x.test/i.png" alt="a" title="t" onerror="x()" width="10">'
    )
    assert 'src="https://x.test/i.png"' in image
    assert 'alt="a"' in image and 'title="t"' in image
    assert "onerror" not in image and "width=" not in image


def test_every_other_tag_is_stripped_of_attributes():
    html = render_markdown('<p class="x" style="color:red" data-y="1">hi</p>')
    assert "<p>hi</p>" in html


def test_allowed_schemes():
    assert 'href="mailto:a@b.test"' in render_markdown('<a href="mailto:a@b.test">m</a>')
    data = render_markdown('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')
    assert "data:" not in data


def test_anchor_gets_no_rel_added():
    html = render_markdown('<a href="https://x.test">x</a>')
    assert "rel=" not in html


def test_the_allowlist_matches_the_spec_table():
    # exactly the SPEC set: sanitize-html defaults union {img} — 68 tags, a and img keep attributes
    assert ALLOWED_TAGS == {
        "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br",
        "caption", "cite", "code", "col", "colgroup", "data", "dd", "dfn", "div", "dl", "dt",
        "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
        "hgroup", "hr", "i", "img", "kbd", "li", "main", "mark", "menu", "nav", "ol", "p",
        "pre", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "section", "small", "span",
        "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
        "u", "ul", "var", "wbr",
    }
    assert ALLOWED_ATTRIBUTES == {
        "a": {"href", "name", "rel"},
        "img": {"src", "alt", "title"},
    }


def test_slugify():
    assert slugify("Hello, World!") == "hello-world"
    assert slugify("  Ça va — très bien ") == "a-va-tr-s-bien"
    assert slugify("") == "entry"
    assert slugify("!!!") == "entry"
    assert len(slugify("a" * 400)) == 255


def test_edits_applies_an_exact_single_replacement():
    markdown = "# Title\n\nThe old sentence.\n"
    assert edits(markdown, [{"find": "old sentence", "replace": "new sentence"}]) == "# Title\n\nThe new sentence.\n"


def test_edits_is_sequential():
    markdown = "one two three"
    assert edits(markdown, [{"find": "one", "replace": "1"}, {"find": "three", "replace": "3"}]) == "1 two 3"


def test_edits_not_found():
    with pytest.raises(InkwireError) as excinfo:
        edits("hello", [{"find": "absent", "replace": "x"}])
    assert excinfo.value.code == "invalid_payload"
    assert excinfo.value.message.startswith("edit_not_found:")


def test_edits_ambiguous():
    with pytest.raises(InkwireError) as excinfo:
        edits("same same", [{"find": "same", "replace": "x"}])
    assert excinfo.value.code == "invalid_payload"
    assert excinfo.value.message.startswith("edit_ambiguous:")
    assert "2" in excinfo.value.message


def test_edits_rejects_an_empty_find():
    with pytest.raises(InkwireError):
        edits("hello", [{"find": "", "replace": "x"}])


def test_edits_can_introduce_text_matched_later():
    assert edits("a", [{"find": "a", "replace": "b"}, {"find": "b", "replace": "c"}]) == "c"
