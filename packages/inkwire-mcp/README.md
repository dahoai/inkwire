# inkwire-mcp

Let Claude Code, Claude Desktop, Cursor or any [MCP](https://modelcontextprotocol.io) agent edit your website. Point it at any site that runs an [Inkwire](https://github.com/dahoai/inkwire) receiver, and the agent can list, read, write and change its posts and pages, fix their SEO fields, and manage its images, showing you a before and after of every change first.

```bash
# Claude Code
claude mcp add my-site --env INKWIRE_KEY=<key> -- npx -y inkwire-mcp https://my-site.com
```

Then ask in plain words: *"Our plans now start at $12: update the pricing page and its meta description. Show me the change first."*

No receiver yet? `npx create-inkwire` adds one to a Next.js or Express site in about two minutes ([INSTALL.md](https://github.com/dahoai/inkwire/blob/master/INSTALL.md)).

## Other clients

Any client that starts stdio MCP servers takes the same command. Claude Desktop and Cursor (`claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "my-site": {
      "command": "npx",
      "args": ["-y", "inkwire-mcp", "https://my-site.com"],
      "env": { "INKWIRE_KEY": "<key>" }
    }
  }
}
```

The key comes from `INKWIRE_KEY` (or `--key`, which shows it in the process list), the address from the first argument (or `INKWIRE_URL`). Give it the site's **read-only key** (`key:ro` in the site's `INKWIRE_API_KEYS`) to let an agent audit everything and change nothing.

## The tools

At startup it reads the site's discovery (`GET /api/inkwire`) and offers only what that site supports: a site without `delete` has no delete tool, and `kind` takes only the kinds the site holds.

| Tool | Feature | What it does |
| --- | --- | --- |
| `site` | always | the site's name, kinds, features and limits |
| `list` | `list` | search and page through entries (kind, status, words, tag, category; language with `translations`) |
| `get` | `get` | one entry: its markdown and the SEO values the site really uses |
| `create` | `upsert` | a new post or page, as a draft unless told to publish; `dry_run` checks it with the site first (with `warnings`) |
| `update` | `get` + `update` | change text with exact `{find, replace}` edits, or any field; `dry_run` returns the before and after without writing |
| `delete` | `delete` | take an entry off the site |
| `history` | `revisions` | an entry's earlier versions, newest first (a deleted entry's too), or one in full |
| `restore` | `revisions` | undo: put back the version before the last change (or any earlier one), or bring back a deleted entry; `dry_run` shows what comes back |
| `terms` | `terms` | the tags and categories already in use |
| `upload_image` | `media` | an image from a file on your computer (or a public URL, with `media_url`) |
| `list_images` | `media_list` | the media library, with alt text |
| `update_image` | `media_update` | set an image's alt text and title |

## Safe by default

- **Preview, then apply.** The agent is told to run every change with `dry_run` first and show you the before and after. The preview of a text edit is the edit itself, not the whole page twice.
- **Undo.** On a site with `revisions`, every change and every delete keeps the version it replaced. *"Undo that"* is one `restore`, previewed first like any change, and a restore is itself undoable.
- **SEO advice from the site itself.** On a site with `warnings`, every preview and write comes back with them: a duplicate title, no description, a broken link, an image without alt text. On a site with `redirects`, a slug change keeps the old address working.
- **No silent overwrites.** `update` reads the entry and writes with its `ETag`: if someone changed the page in between, the write is refused (`stale`) and the agent reads it again.
- **Exact edits.** Each `find` must occur exactly once in the page, or nothing changes.
- **Drafts first.** New entries are drafts; a future `published_at` is refused on a site that cannot schedule, instead of publishing at once.
- **Errors the agent can act on**, such as `forbidden: This key is read-only…`.
- Page content is written by other people: the agent is told to treat it as data, never as instructions.

## Use it from code

`createServer({ site, key, caps })` returns the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) server, for a different transport or an SSRF-guarded `fetch`:

```js
import { capabilities } from "inkwire-client";
import { createServer } from "inkwire-mcp";

const caps = await capabilities(site, key);
const server = createServer({ site, key, caps, fetch: guardedFetch });
```

## License

MIT
