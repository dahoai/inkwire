# inkwire-receiver-core

The Python [Inkwire](https://github.com/dahoai/inkwire) receiver: a core that validates
requests, derives SEO metadata, renders and sanitizes Markdown, resolves slugs and talks to a
store, plus a ready-to-run FastAPI app. It implements the whole
[protocol specification](https://github.com/dahoai/inkwire/blob/master/inkwire/SPEC.md).

```bash
pip install "inkwire-receiver-core[fastapi]" uvicorn
```

## Run it

```bash
export INKWIRE_API_KEYS=dev-key,audit-key:ro   # ":ro" marks a read-only key
export INKWIRE_ROOT=./content                  # entries are written as content/<kind>/<slug>.md
uvicorn inkwire_receiver.app:create_app --factory
```

| Variable | Default | |
| --- | --- | --- |
| `INKWIRE_API_KEYS` | (required) | comma-separated bearer keys; a `:ro` suffix makes one read-only |
| `INKWIRE_KINDS` | `post,page` | the kinds the receiver holds |
| `INKWIRE_STORE` | `file` | `file` (a folder of Markdown files) or `memory` |
| `INKWIRE_ROOT` | `./content` | the file store's folder |
| `INKWIRE_MEDIA_URL_BASE` | `/inkwire-media` | public base of uploaded files; a path is served by the app from `<root>/media` |
| `INKWIRE_SITE_NAME`, `INKWIRE_SITE_URL` | | discovery; the URL is also the base of entry URLs |
| `INKWIRE_SITE_DESCRIPTION`, `INKWIRE_SITE_LANGUAGE` | | discovery (a BCP 47 tag such as `en`) |
| `INKWIRE_URL_TEMPLATE` | `/blog/<slug>` for posts | entry URL with `{site}`, `{kind}`, `{slug}` |
| `INKWIRE_MARKDOWN_LIMIT_BYTES` | `1000000` | over it: `413 too_large` |
| `INKWIRE_MEDIA_LIMIT_BYTES` | `10000000` | over it: `413 too_large` |

## Endpoints

Every endpoint is under `/api`, takes `Authorization: Bearer <key>` and answers with
`Inkwire-Version: 1`. A read-only key may call every `GET`.

| | |
| --- | --- |
| `GET /api/inkwire` | discovery: site, features, kinds, limits |
| `POST /api/content` | create or update an entry, upserting on `external_id` and `kind` |
| `GET /api/content`, `GET /api/content/{id}` | list (`status`, `kind`, `tag`, `category`, `search`, `external_id`, `slug`, `lang`, `translation_key`, `limit`, `cursor`) and read, newest first |
| `PATCH /api/content/{id}` | edit part of an entry; honours `If-Match` |
| `?dry_run=true` on `POST` / `PATCH` | validate and return the result with its SEO `warnings`, writing nothing |
| `GET /api/redirects?kind=&slug=` | where an entry's old address leads now |
| `GET /api/content/{id}/revisions[/{revision}]` | an entry's past versions, newest first (a deleted entry's too) |
| `POST /api/content/{id}/restore` | put a past version back (`{"revision": ...}`; honours `If-Match`; undeletes) |
| `DELETE /api/content/{id}` | remove an entry |
| `GET /api/terms` | the tags and categories entries use (`kind`, `search`, `limit`) |
| `POST /api/media` | upload an image (multipart) or have the receiver fetch a public URL |
| `GET /api/media` | the media library, newest first (`search`, `limit`, `cursor`) |
| `PATCH /api/media/{id}` | set or clear (`null`) a media item's `alt` and `title` |

The advertised features follow what the store can do: `terms` and `warnings` are always there,
`revisions` appears with `save_revision` / `list_revisions` / `move_revisions` (discovery then says
how many versions an entry keeps: `Limits(revisions=...)`, default 50), `redirects` appears with `save_redirect` / `find_redirect` / `move_redirects`, `translations` with a
store that sets `translations = True`, `media`,
`media_list` and `media_update` appear when the store saves, lists and updates media, and
`schedule` only when `InkwireConfig(schedule=True)` says the site holds a future-dated entry
back until its time. The file store has no renderer, so the reference app does not.

## Use the core in your own app

`create_app` takes a store, the keys and a config, so a site with its own database or routes
builds the app from its own parts:

```python
from inkwire_receiver import InkwireConfig, Limits, Site, parse_api_keys
from inkwire_receiver.app import create_app

app = create_app(
    store=MyStore(),  # see below
    api_keys=parse_api_keys("dev-key,audit-key:ro"),
    config=InkwireConfig(
        site=Site(name="Acme", url="https://acme.com", description="Acme's blog", language="en"),
        kinds=["post", "page"],
        limits=Limits(markdown_bytes=1_000_000, media_bytes=10_000_000),
        url_for=lambda entry: f"https://acme.com/blog/{entry['slug']}",
    ),
)
```

Each endpoint is also one function (`handle_upsert`, `handle_list`, `handle_get`,
`handle_patch`, `handle_delete`, `handle_terms`, `handle_media`, `handle_media_list`,
`handle_media_update`, `handle_revisions`, `handle_revision`, `handle_restore`, `handle_redirect`,
`handle_discovery`) returning `(status, headers, body)`,
to mount in any framework. For the site's own pages: `resolve_redirect` (an old address → the
entry to send a 308 to), `alternates` (the `hreflang` links of an entry's language versions) and
`sitemap_entries` (public, indexable, self-canonical entries with `lastmod`).

## Stores

A store is four async methods, all scoped by the API key's `key`:

```python
async def get(self, key, id) -> StoredContent | None
async def list(self, key, filter: ListFilter) -> tuple[list[StoredContent], str | None]
async def save(self, key, entry: StoredContent) -> StoredContent
async def remove(self, key, id) -> bool
```

`list` returns one page, newest first by `updated_at` (ties by `id`); `paginate` does the
ordering and the keyset cursor. Slug conflicts and `external_id` lookups are ordinary `list`
calls with exact filters.

Media is optional, one method per feature: `media` (and `fetch_media` for `{url}` uploads)
saves a file, `list_media` lists the library (`paginate_media`), `update_media` changes
`alt` / `title`. A store without a method makes the receiver omit that feature. Undo is three
methods (`save_revision(key, id, revision, keep)` keeps the newest `keep`, `list_revisions` newest
first, `move_revisions` when an id follows a rename); every update, restore and delete saves the
version it replaces first. Redirects are
three methods (`save_redirect`, `find_redirect`, `move_redirects`; the handlers save one when a
write changes an entry's kind or slug). `translations = True` promises the store keeps `lang` and
`translation_key` and filters `list` by them.

`MemoryStore` is for development and tests. `FileStore` keeps `<root>/<kind>/<slug>.md` with
YAML frontmatter (existing files are read as they are) and `<root>/media/<id>-<name>` with a
`.meta.json` sidecar for each upload, the redirects in `<root>/.redirects.json` and each entry's
history in `<root>/.revisions/<kind>.<slug>.json` (same files as the TypeScript FileStore). Both do
translations and undo.
