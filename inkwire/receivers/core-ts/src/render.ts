import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { InkwireError } from "./errors.js";

const md = new MarkdownIt({ html: true, linkify: true });

/**
 * The canonical allowlist (SPEC, "Content safety"): sanitize-html's default tags unioned with
 * `img`. Only `a` and `img` keep attributes; schemes are http, https and mailto.
 */
export const ALLOWED_TAGS: string[] = [...new Set([...sanitizeHtml.defaults.allowedTags, "img"])];
export const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "name", "rel"],
  img: ["src", "alt", "title"],
};
export const ALLOWED_SCHEMES = ["http", "https", "mailto"];

export function renderMarkdown(markdown: string): string {
  const raw = md.render(markdown);
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    disallowedTagsMode: "discard",
  });
}

/** Lowercase, non-alphanumerics to "-", trimmed, at most 255 chars. Falls back to "entry". */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 255)
      .replace(/-+$/g, "") || "entry"
  );
}

const preview = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/**
 * Text edits for a client: each `find` must occur EXACTLY once in the current markdown (non
 * overlapping count), else nothing is returned and an `invalid_payload` error says which edit and why
 * (`edit_not_found: …` / `edit_ambiguous: …`). Edits apply in order, so a later `find` sees the result
 * of an earlier `replace`.
 */
export function edits(markdown: string, changes: { find: string; replace: string }[]): string {
  let out = markdown;
  changes.forEach((c, i) => {
    const n = i + 1;
    if (typeof c.find !== "string" || c.find === "") {
      throw new InkwireError("invalid_payload", `edit_not_found: edit ${n} has an empty "find"`);
    }
    const hits = countOccurrences(out, c.find);
    if (hits === 0) {
      throw new InkwireError("invalid_payload", `edit_not_found: edit ${n}: "${preview(c.find)}" does not occur in the markdown`);
    }
    if (hits > 1) {
      throw new InkwireError(
        "invalid_payload",
        `edit_ambiguous: edit ${n}: "${preview(c.find)}" occurs ${hits} times; include more surrounding text so it matches once`,
      );
    }
    const at = out.indexOf(c.find);
    out = out.slice(0, at) + c.replace + out.slice(at + c.find.length);
  });
  return out;
}
