# inkwire-client

Python client for [Inkwire](https://github.com/dahoai/inkwire) receivers: publish, read, edit,
delete, list terms and manage the media library. Every call retries `429` and `5xx` with backoff
and raises `InkwireClientError(code, message, http_status)` on failure.

```bash
pip install inkwire-client
```

```python
from inkwire_client import publish

result = publish("https://blog.example.com", "your-api-key", {
    "external_id": "my-post-1",
    "title": "Hello",
    "markdown": "# Hello\n\nFirst post via Inkwire.",
    "categories": ["Guides"],
    "cover_image_url": "https://example.com/cover.jpg",
    "cover_image_alt": "A red bicycle",
    "seo": {"og_title": "Hello, world", "json_ld": '{"@context":"https://schema.org","@type":"FAQPage"}'},
    "status": "published",
})
```

| Call | Endpoint |
| --- | --- |
| `publish(base_url, key, payload, dry_run=)` | `POST /api/content`: upserts by `external_id`; `warnings` on the answer |
| `capabilities(base_url, key)` | `GET /api/inkwire`: `site`, `features`, `kinds`, `limits` (upsert-only when the receiver has no discovery) |
| `list(base_url, key, status=, kind=, tag=, category=, search=, external_id=, slug=, lang=, translation_key=, limit=, cursor=)` | `GET /api/content` |
| `get(base_url, key, id)` | `GET /api/content/{id}`: `(entry, etag)` |
| `update(base_url, key, id, patch, if_match=, dry_run=)` | `PATCH /api/content/{id}`: `(entry, etag)`; `None` clears an optional field |
| `remove(base_url, key, id, if_match=)` | `DELETE /api/content/{id}` |
| `revisions(base_url, key, id)` | `GET /api/content/{id}/revisions`: `{"items": [...]}`, newest first |
| `revision(base_url, key, id, rev)` | `GET /api/content/{id}/revisions/{rev}`: the summary + `entry` |
| `restore(base_url, key, id, rev, if_match=)` | `POST /api/content/{id}/restore`: `(entry, etag)` (undo; also undeletes) |
| `redirect(base_url, key, kind, slug)` | `GET /api/redirects`: where an old address leads, or `None` |
| `terms(base_url, key, kind=, search=, limit=)` | `GET /api/terms`: `{"items": [{kind, name, slug, count}]}` |
| `list_media(base_url, key, search=, limit=, cursor=)` | `GET /api/media`: `{"items": [...], "next_cursor": ...}` |
| `update_media(base_url, key, id, alt=, title=)` | `PATCH /api/media/{id}` |
| `upload_media(base_url, key, url=` or `data=, alt=)` | `POST /api/media`: `{id, url, alt?, title?, mime_type, width?, height?, created_at}` |

`update_media` sends only the arguments you give; `None` clears a field and leaving it out keeps it:

```python
from inkwire_client import update_media

update_media(base_url, key, media_id, alt="A red bicycle")   # sets alt, keeps title
update_media(base_url, key, media_id, title=None)            # clears title, keeps alt
```

`edits(markdown, [{"find": ..., "replace": ...}])` applies exact-match text edits (each `find`
must match exactly once) to the markdown you then send with `update`.

See the [protocol spec](https://github.com/dahoai/inkwire/blob/master/inkwire/SPEC.md) for the
full payload shapes.
