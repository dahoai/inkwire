import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALLOWED_TAGS, InkwireError, edits, renderMarkdown, slugify } from "../src/index.js";

// The normative allowlist, copied from SPEC.md "Content safety". If this and ALLOWED_TAGS diverge, one is wrong.
const SPEC_TAGS = `a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup data dd dfn div dl dt em
figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img kbd li main mark menu nav ol p pre q rb rp rt rtc ruby s samp
section small span strong sub sup table tbody td tfoot th thead time tr u ul var wbr`.split(/\s+/);
const VOID = new Set(["br", "hr", "img", "col", "wbr"]);

describe("sanitizer allowlist", () => {
  test("ALLOWED_TAGS is exactly the SPEC list", () => {
    assert.deepEqual([...ALLOWED_TAGS].sort(), [...SPEC_TAGS].sort());
  });

  for (const tag of SPEC_TAGS) {
    test(`<${tag}> survives, its attributes do not (except a/img)`, () => {
      const attrs = 'class="c" id="i" style="color:red" onclick="x()" data-x="1" title="t"';
      const html = VOID.has(tag) ? `<${tag} ${attrs}>` : `<${tag} ${attrs}>x</${tag}>`;
      const out = renderMarkdown(`before ${html} after`);
      assert.match(out, new RegExp(`<${tag}[ >/]`), out);
      assert.ok(!/class=|id=|style=|onclick|data-x/.test(out), out);
      if (tag !== "img") assert.ok(!/title=/.test(out), out);
    });
  }

  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "svg", "math", "video", "audio", "link", "meta", "base", "font", "center", "marquee", "details", "dialog", "canvas", "applet"]) {
    test(`<${tag}> is stripped`, () => {
      const out = renderMarkdown(`a <${tag} src="x" href="y">inner</${tag}> b`);
      assert.ok(!new RegExp(`<${tag}[ >/]`, "i").test(out), out);
    });
  }

  test("script and style contents are dropped, not just the tags", () => {
    assert.ok(!/alert|color/.test(renderMarkdown("<script>alert(1)</script><style>p{color:red}</style>hi")));
  });

  test("a keeps href, name, rel and nothing else", () => {
    const out = renderMarkdown('<a href="https://x.test" name="n" rel="nofollow" target="_blank" onclick="x()" class="c" title="t">l</a>');
    assert.match(out, /href="https:\/\/x\.test"/);
    assert.match(out, /name="n"/);
    assert.match(out, /rel="nofollow"/);
    assert.ok(!/target|onclick|class|title/.test(out), out);
  });

  test("img keeps src, alt, title and nothing else", () => {
    const out = renderMarkdown('<img src="https://x.test/a.png" alt="a" title="t" width="9" height="9" srcset="y 2x" class="c" onerror="x()" loading="lazy">');
    assert.match(out, /src="https:\/\/x\.test\/a\.png"/);
    assert.match(out, /alt="a"/);
    assert.match(out, /title="t"/);
    assert.ok(!/width|height|srcset|class|onerror|loading/.test(out), out);
    assert.match(renderMarkdown("![alt text](https://x.test/p.png)"), /<img src="https:\/\/x\.test\/p\.png" alt="alt text"/);
  });

  test("allowed schemes: http, https, mailto", () => {
    for (const href of ["http://x.test/a", "https://x.test/a", "mailto:a@x.test"]) {
      assert.match(renderMarkdown(`<a href="${href}">l</a>`), /href=/, href);
    }
  });

  test("other schemes are stripped from href and src, including obfuscated ones", () => {
    const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "ftp://x.test/a", "tel:123", "file:///etc/passwd"];
    for (const v of bad) {
      const a = renderMarkdown(`<a href="${v}">l</a>`);
      assert.ok(!/href=/.test(a), `${JSON.stringify(v)} -> ${a}`);
      const i = renderMarkdown(`<img src="${v}" alt="x">`);
      assert.ok(!/src=/.test(i), `${JSON.stringify(v)} -> ${i}`);
    }
  });

  test("markdown links with javascript: are never turned into links", () => {
    assert.ok(!/<a /.test(renderMarkdown("[x](javascript:alert(1))")));
  });

  test("event handlers are stripped from every allowed tag", () => {
    const out = renderMarkdown('<p onclick="x()" onmouseover="y()">hi</p><img src="https://x.test/a.png" onerror="z()"><a href="https://x.test" onfocus="w()">l</a>');
    assert.ok(!/ on\w+=/i.test(out), out);
  });

  test("renders ordinary markdown", () => {
    const out = renderMarkdown("# T\n\nA **b** and `c`\n\n- one\n- two\n\nhttps://auto.link/x");
    assert.match(out, /<h1>T<\/h1>/);
    assert.match(out, /<strong>b<\/strong>/);
    assert.match(out, /<code>c<\/code>/);
    assert.match(out, /<li>one<\/li>/);
    assert.match(out, /<a href="https:\/\/auto\.link\/x">/);
  });
});

describe("slugify", () => {
  test("lowercases, collapses non-alphanumerics, trims dashes", () => {
    assert.equal(slugify("How we cut audit time 40%!"), "how-we-cut-audit-time-40");
    assert.equal(slugify("  --Hello,   World--  "), "hello-world");
  });
  test("falls back to 'entry' (not 'post')", () => {
    for (const s of ["", "!!!", "   ", "日本語", "---"]) assert.equal(slugify(s), "entry", JSON.stringify(s));
  });
  test("caps at 255 without a trailing dash", () => {
    const s = slugify(`${"a".repeat(254)} b`);
    assert.ok(s.length <= 255 && !s.endsWith("-"), String(s.length));
  });
  test("output always satisfies the slug pattern", () => {
    for (const t of ["Ünïcode Títle", "a_b c", "x--y", "Q&A: why?"]) assert.match(slugify(t), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("edits", () => {
  const md = "# Title\n\nThe quick brown fox.\n\nThe lazy dog.";
  test("applies each edit once, in order", () => {
    assert.equal(edits(md, [{ find: "quick brown", replace: "slow red" }, { find: "slow red fox", replace: "cat" }]), "# Title\n\nThe cat.\n\nThe lazy dog.");
  });
  test("an empty list returns the markdown unchanged", () => {
    assert.equal(edits(md, []), md);
  });
  test("replace may be empty (delete) and may contain $ characters literally", () => {
    assert.equal(edits("a $1 b", [{ find: "$1", replace: "$& $$" }]), "a $& $$ b");
    assert.equal(edits("keep drop keep", [{ find: " drop", replace: "" }]), "keep keep");
  });
  test("no match -> invalid_payload edit_not_found naming the edit", () => {
    assert.throws(
      () => edits(md, [{ find: "quick", replace: "x" }, { find: "absent text", replace: "y" }]),
      (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload" && e.message.startsWith("edit_not_found:") && e.message.includes("edit 2"),
    );
  });
  test("several matches -> invalid_payload edit_ambiguous with the count", () => {
    assert.throws(
      () => edits(md, [{ find: "The ", replace: "A " }]),
      (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload" && e.message.startsWith("edit_ambiguous:") && e.message.includes("2 times"),
    );
  });
  test("overlapping matches count as non-overlapping occurrences", () => {
    assert.equal(edits("aaa", [{ find: "aa", replace: "b" }]), "ba");
  });
  test("an empty find is refused", () => {
    assert.throws(() => edits(md, [{ find: "", replace: "x" }]), (e: unknown) => e instanceof InkwireError && e.message.startsWith("edit_not_found:"));
  });
  test("a long find is previewed, not echoed whole", () => {
    try {
      edits("x", [{ find: "z".repeat(500), replace: "" }]);
      assert.fail("should throw");
    } catch (e) {
      assert.ok((e as Error).message.length < 200);
    }
  });
});
