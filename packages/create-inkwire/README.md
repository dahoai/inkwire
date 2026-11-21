# create-inkwire

Add an [Inkwire](https://github.com/dahoai/inkwire) receiver to an existing site in one command: an API your agent can use to **publish, read, edit, delete and upload images** for the site's content, stored as markdown files (or committed to GitHub).

```bash
cd my-site
npx create-inkwire
```

```text
Inkwire receiver added.

  + app/api/_inkwire/config.ts
  + app/api/content/route.ts
  + app/api/content/[id]/route.ts
  + app/api/terms/route.ts
  + app/api/media/route.ts
  + app/api/media/[id]/route.ts
  + app/api/inkwire/route.ts
  + app/inkwire-media/[...path]/route.ts
  + content/ (entries live here as markdown files)
  + inkwire-receiver-core in package.json (^1.2.0)
  + .env.local (INKWIRE_API_KEYS, INKWIRE_SITE_URL, INKWIRE_ROOT)
  + .env.local added to .gitignore

Keys (shown once; also in .env.local):
  full key       3f9c...
  read-only key  a07e...

Next:
  1. Set INKWIRE_SITE_URL in .env.local to this site's real address, then (re)start the site.
  2. Check it: curl -H "Authorization: Bearer 3f9c..." http://localhost:3000/api/inkwire
  3. In Anaella, connect an Inkwire site: address http://localhost:3000, key = the full key above.
  4. Make the site render what you publish (SEO tags, a /<kind>/<slug> page): .../INSTALL.md
```

## What it does

1. Detects the framework: `next` in `package.json` (App Router) means Next.js; `express` means Express; `fastapi` in `pyproject.toml` or `requirements.txt` means FastAPI (it prints the manual steps and writes nothing). Anything else exits with a message.
2. Writes the receiver: the Next.js route files under `app/` (or `src/app/`), or one `inkwire-router.mjs` / `inkwire-router.ts` file for Express (TypeScript when there is a `tsconfig.json`). Files that already exist are left alone (`--force` replaces them).
3. Adds `inkwire-receiver-core` to `package.json` and installs it with your package manager (npm, pnpm, yarn or bun, from the lockfile).
4. Creates the content folder with a `.gitkeep`.
5. Generates a full key and a read-only key (`crypto.randomBytes(24)`), appends `INKWIRE_API_KEYS=full,ro:ro`, `INKWIRE_SITE_URL` and `INKWIRE_ROOT` to `.env.local` (Next.js) or `.env` (Express), adds that file to `.gitignore` if it is not covered, and prints the keys once. If the file already defines `INKWIRE_API_KEYS` it is not touched and nothing is printed.

It never prompts, so it runs unchanged in CI.

## Options

```text
--framework <next|express|fastapi>  skip detection
--root <dir>                        content folder (default ./content)
--site-url <url>                    public address (default http://localhost:3000)
--dir <dir>                         the project directory (default: the current one)
--yes                               accepted for scripts
--no-install                        do not run the package manager
--core-spec <spec>                  inkwire-receiver-core version or path (default ^1.2.0), e.g. file:../inkwire/inkwire/receivers/core-ts
--force                             overwrite existing receiver files
```

Express: mount the router before `express.json()` and load `.env`; the output prints the exact lines. A CommonJS app loads the `.mjs` router with a dynamic `import()`.

Wiring the pages that render entries, deploying on Vercel (GitHub store) and the full environment table are in [INSTALL.md](https://github.com/dahoai/inkwire/blob/master/INSTALL.md).

## Developing

The files it copies (`templates/`) are generated from the reference receivers in `inkwire/receivers/`. After changing those, run `npm run sync`; `npm test` fails when they drift. `npm run e2e` runs the real CLI in temp projects (Next.js, Express ESM, TypeScript and CommonJS), boots each, and runs the Inkwire conformance runner (and the SEO rendering runner for the two that include a page) against it; it needs the registry and a built `inkwire/receivers/core-ts`.

MIT licensed.
