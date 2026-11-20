"""A wired FastAPI receiver: ``uvicorn app:app``.

Environment::

    INKWIRE_API_KEYS=dev-key,audit-key:ro      # required; ":ro" marks a read-only key
    INKWIRE_KINDS=post,page                    # default post,page
    INKWIRE_STORE=file|memory                  # default file
    INKWIRE_ROOT=./content                     # FileStore root (default ./content)
    INKWIRE_MEDIA_URL_BASE=/inkwire-media      # public base for uploaded files
    INKWIRE_SITE_NAME=Acme                     # discovery
    INKWIRE_SITE_URL=https://acme.com          # discovery + default entry URLs
    INKWIRE_MARKDOWN_LIMIT_BYTES=1000000       # default 1 MB
    INKWIRE_MEDIA_LIMIT_BYTES=10000000         # default 10 MB
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from inkwire_receiver import (
    ApiKey,
    FileStore,
    InkwireConfig,
    Limits,
    MemoryStore,
    Site,

    guarded_fetcher,
    handle_delete,
    handle_discovery,
    handle_get,
    handle_list,
    handle_media,
    handle_patch,
    handle_upsert,
    parse_api_keys,
)

FEATURES = ["upsert", "list", "get", "update", "delete", "media"]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _env_kinds() -> list[str]:
    kinds = [kind.strip() for kind in os.environ.get("INKWIRE_KINDS", "post,page").split(",")]
    return [kind for kind in kinds if kind] or ["post"]


def _build_store(media_url_base: str, media_limit: int):
    if os.environ.get("INKWIRE_STORE", "file").lower() == "memory":
        return MemoryStore(media_url_base=media_url_base, fetcher=guarded_fetcher(max_bytes=media_limit))
    return FileStore(
        os.environ.get("INKWIRE_ROOT", "./content"),
        media_url_base,
        fetcher=guarded_fetcher(max_bytes=media_limit),
        max_media_bytes=media_limit,
    )


def _protocol_error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
        headers={"Inkwire-Version": "1"},
    )


def _json(status: int, headers: dict, body: dict) -> JSONResponse:
    return JSONResponse(status_code=status, content=body, headers=headers)


def create_app(
    *,
    store=None,
    api_keys: list[ApiKey] | str | None = None,
    config: InkwireConfig | None = None,
) -> FastAPI:
    """Build the receiver. Everything is injectable so tests and the conformance run control it."""
    markdown_limit = _env_int("INKWIRE_MARKDOWN_LIMIT_BYTES", 1_000_000)
    media_limit = _env_int("INKWIRE_MEDIA_LIMIT_BYTES", 10_000_000)
    media_url_base = os.environ.get("INKWIRE_MEDIA_URL_BASE", "/inkwire-media")

    keys: list[ApiKey]
    if isinstance(api_keys, str):
        keys = parse_api_keys(api_keys)
    elif api_keys is None:
        keys = parse_api_keys(os.environ.get("INKWIRE_API_KEYS", ""))
    else:
        keys = api_keys

    if config is None:
        config = InkwireConfig(
            site=Site(name=os.environ.get("INKWIRE_SITE_NAME") or None, url=os.environ.get("INKWIRE_SITE_URL") or None),
            kinds=_env_kinds(),
            limits=Limits(markdown_bytes=markdown_limit, media_bytes=media_limit),
            features=list(FEATURES),
        )
    if store is None:
        store = _build_store(media_url_base, media_limit)

    app = FastAPI(title="Inkwire receiver", docs_url=None, redoc_url=None)

    def auth_header(request: Request) -> str | None:
        return request.headers.get("authorization")

    @app.post("/api/content")
    async def upsert(request: Request):
        status, headers, body = await handle_upsert(
            auth_header=auth_header(request),
            raw_body=await request.body(),
            keys=keys,
            store=store,
            config=config,
        )
        return _json(status, headers, body)

    @app.get("/api/content")
    async def list_content(request: Request):
        status, headers, body = await handle_list(
            auth_header=auth_header(request),
            query=request.query_params,
            keys=keys,
            store=store,
            config=config,
        )
        return _json(status, headers, body)

    @app.get("/api/content/{content_id}")
    async def get_content(content_id: str, request: Request):
        status, headers, body = await handle_get(
            auth_header=auth_header(request), id=content_id, keys=keys, store=store, config=config
        )
        return _json(status, headers, body)

    @app.patch("/api/content/{content_id}")
    async def patch_content(content_id: str, request: Request):
        status, headers, body = await handle_patch(
            auth_header=auth_header(request),
            id=content_id,
            raw_body=await request.body(),
            if_match=request.headers.get("if-match"),
            keys=keys,
            store=store,
            config=config,
        )
        return _json(status, headers, body)

    @app.delete("/api/content/{content_id}")
    async def delete_content(content_id: str, request: Request):
        status, headers, body = await handle_delete(
            auth_header=auth_header(request),
            id=content_id,
            if_match=request.headers.get("if-match"),
            keys=keys,
            store=store,
        )
        return _json(status, headers, body)

    @app.post("/api/media")
    async def media(request: Request):
        content_type = request.headers.get("content-type", "")
        if content_type.lower().startswith("multipart/form-data"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or not hasattr(upload, "read"):
                return _protocol_error(400, "invalid_payload", "media: a `file` part is required")
            data = await upload.read()
            alt = form.get("alt")
            status, headers, body = await handle_media(
                auth_header=auth_header(request),
                keys=keys,
                store=store,
                config=config,
                content_type=content_type,
                upload=(data, getattr(upload, "filename", None) or "image", getattr(upload, "content_type", None) or ""),
                alt=str(alt) if alt is not None else None,
            )
            return _json(status, headers, body)

        status, headers, body = await handle_media(
            auth_header=auth_header(request),
            keys=keys,
            store=store,
            config=config,
            content_type=content_type,
            raw_body=await request.body(),
        )
        return _json(status, headers, body)

    @app.get("/api/inkwire")
    async def discovery(request: Request):
        status, headers, body = await handle_discovery(
            auth_header=auth_header(request), keys=keys, config=config
        )
        return _json(status, headers, body)

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def unknown(path: str):
        return _protocol_error(404, "not_found", f"no endpoint /api/{path}")

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception):  # noqa: ARG001
        return _protocol_error(500, "internal", "unexpected error")

    if isinstance(store, FileStore) and media_url_base.startswith("/"):
        media_dir = Path(store.root) / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        app.mount(media_url_base, StaticFiles(directory=str(media_dir)), name="inkwire-media")

    # Exposed for tests and for adapters that want the discovery payload directly.
    app.state.inkwire = {"store": store, "keys": keys, "config": config}
    return app


__all__ = ["FEATURES", "create_app"]
