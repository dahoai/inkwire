# inkwire-conformance

The black-box test suite for [Inkwire](../../README.md) v1. It speaks only HTTP, so it works against a receiver written in any language.

```bash
npx inkwire-conformance https://staging.example.com --key "$INKWIRE_KEY" --readonly-key "$INKWIRE_RO_KEY"
```

- It reads `GET /api/inkwire` and runs only the cases for the features the receiver advertises; the rest print `SKIP` with the reason.
- `--readonly-key` (a key configured as `name:ro`) turns on the 403 cases. `--seo` also checks the public page of a published entry against SEO Profile 1.
- It **writes** entries (slugs start with `r<run>`) and uploads a 1×1 image. It deletes the entries it created when it finishes (`--keep` leaves them; a receiver without `delete` keeps them anyway). The image cannot be removed through the protocol, so prefer a staging site.
- A `429 rate_limited` is waited out (`Retry-After`), so a receiver with a per-key limit still passes, only slower.
- Exit code 0 means nothing failed. A receiver that passes every case it does not skip may call itself "Inkwire v1".

`cases.json` is the contract in data form (one case per rule in [SPEC.md](../SPEC.md)); the runner is ~140 lines, so porting it to another language is easy.
