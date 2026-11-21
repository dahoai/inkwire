// Shared by runner.mjs and seo-runner.mjs: a fetch that waits out the receiver's rate limit,
// and a record of every entry the suite created so it can delete them when it is done.

/** `fetch`, but a 429 `rate_limited` waits (Retry-After seconds, default 20, at most 65) and tries again. */
export async function pacedFetch(url, init) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after")) || 20, 65) * 1000));
  }
  return fetch(url, init);
}

const created = new Set();

/** Remember the id of an entry a response says exists (an edit can rename it, so keep every id seen). */
export function track(json) {
  if (json && typeof json.id === "string") created.add(json.id);
}

/**
 * Deletes what the suite created. Skipped with `--keep` (KEEP=1) or when the receiver has no
 * `delete` feature; an entry that is already gone (a case deleted it) is not an error. Uploaded
 * media cannot be removed through the protocol, so it stays.
 */
export async function cleanup({ base, key, features }) {
  if (process.env.KEEP === "1") return console.log(`\nkept ${created.size} entries (--keep)`);
  if (!created.size) return;
  if (features && !features.includes("delete")) {
    return console.log(`\n${created.size} entries left behind: this receiver has no delete feature`);
  }
  let gone = 0;
  const left = [];
  for (const id of created) {
    const res = await pacedFetch(`${base}/api/content/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => null);
    if (res && (res.ok || res.status === 404)) gone++;
    else left.push(id);
  }
  console.log(`\ncleanup: deleted ${gone} of ${created.size} entries${left.length ? `; could not delete: ${left.join(", ")}` : ""}`);
}
