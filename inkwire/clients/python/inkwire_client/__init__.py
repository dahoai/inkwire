from __future__ import annotations

import time
import urllib.parse
from typing import Any, Iterable, Mapping
import httpx

_transport = None  # tests may inject an httpx.MockTransport

DEFAULT_STATUS_CODES = {
    400: "invalid_payload",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    412: "stale",
    413: "too_large",
    429: "rate_limited",
    500: "internal",
}


class InkwireClientError(Exception):
    def __init__(self, code: str, message: str, http_status: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _call(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json: Any = None,
    data: dict[str, Any] | None = None,
    files: Any = None,
    params: dict[str, Any] | None = None,
    retries: int = 3,
) -> httpx.Response:
    retries = max(1, retries)
    client = httpx.Client(transport=_transport) if _transport else httpx.Client()
    try:
        last: Exception | None = None
        for attempt in range(1, retries + 1):
            res = client.request(
                method,
                url,
                headers=headers,
                json=json,
                data=data,
                files=files,
                params=params,
            )
            if 200 <= res.status_code < 300:
                return res
            retriable = res.status_code == 429 or res.status_code >= 500
            code = DEFAULT_STATUS_CODES.get(res.status_code, "internal")
            message = f"HTTP {res.status_code}"
            try:
                err = res.json().get("error")
                if err and isinstance(err, dict):
                    code = err.get("code", code)
                    message = err.get("message", message)
            except Exception:
                pass
            last = InkwireClientError(code, message, res.status_code)
            if not retriable or attempt == retries:
                raise last
            time.sleep(2 ** (attempt - 1) * 0.2)
        assert last is not None
        raise last
    finally:
        client.close()


def publish(base_url: str, api_key: str, payload: dict, retries: int = 3) -> dict:
    url = base_url.rstrip("/") + "/api/content"
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    if "external_id" in payload and payload["external_id"] is not None:
        headers["idempotency-key"] = str(payload["external_id"])
    res = _call("POST", url, headers=headers, json=payload, retries=retries)
    return res.json()


def capabilities(base_url: str, api_key: str, retries: int = 3) -> dict:
    url = base_url.rstrip("/") + "/api/inkwire"
    headers = {"authorization": f"Bearer {api_key}"}
    try:
        res = _call("GET", url, headers=headers, retries=retries)
        data = res.json()
        if isinstance(data, dict):
            data.setdefault("features", ["upsert"])
            data.setdefault("kinds", ["post"])
            data.setdefault("limits", {})
            return data
        return {"features": ["upsert"], "kinds": ["post"], "limits": {}}
    except InkwireClientError as e:
        if e.http_status == 404:
            return {"features": ["upsert"], "kinds": ["post"], "limits": {}}
        raise


def list(base_url: str, api_key: str, retries: int = 3, **filters) -> dict:
    url = base_url.rstrip("/") + "/api/content"
    headers = {"authorization": f"Bearer {api_key}"}
    params = {k: v for k, v in filters.items() if v is not None}
    res = _call("GET", url, headers=headers, params=params, retries=retries)
    return res.json()


def get(base_url: str, api_key: str, id: str, retries: int = 3) -> tuple[dict, str | None]:
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}"
    headers = {"authorization": f"Bearer {api_key}"}
    res = _call("GET", url, headers=headers, retries=retries)
    return res.json(), res.headers.get("etag")


def update(
    base_url: str,
    api_key: str,
    id: str,
    patch: dict,
    if_match: str | None = None,
    retries: int = 3,
) -> tuple[dict, str | None]:
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}"
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    if if_match is not None:
        headers["if-match"] = if_match
    res = _call("PATCH", url, headers=headers, json=patch, retries=retries)
    return res.json(), res.headers.get("etag")


def remove(
    base_url: str,
    api_key: str,
    id: str,
    if_match: str | None = None,
    retries: int = 3,
) -> dict:
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}"
    headers = {"authorization": f"Bearer {api_key}"}
    if if_match is not None:
        headers["if-match"] = if_match
    res = _call("DELETE", url, headers=headers, retries=retries)
    return res.json()


def upload_media(
    base_url: str,
    api_key: str,
    *,
    url: str | None = None,
    data: bytes | tuple[bytes, str, str] | None = None,
    alt: str | None = None,
    retries: int = 3,
) -> dict:
    endpoint = base_url.rstrip("/") + "/api/media"
    headers = {"authorization": f"Bearer {api_key}"}
    if url is not None:
        json_body: dict[str, Any] = {"url": url}
        if alt is not None:
            json_body["alt"] = alt
        headers["content-type"] = "application/json"
        res = _call("POST", endpoint, headers=headers, json=json_body, retries=retries)
        return res.json()
    elif data is not None:
        if isinstance(data, tuple):
            bytes_val = data[0]
            filename = data[1] if len(data) > 1 else "image.png"
            content_type = data[2] if len(data) > 2 else "image/png"
        else:
            bytes_val = data
            filename = "image.png"
            content_type = "image/png"
        files = {"file": (filename, bytes_val, content_type)}
        form_data = {"alt": alt} if alt is not None else None
        res = _call("POST", endpoint, headers=headers, data=form_data, files=files, retries=retries)
        return res.json()
    else:
        raise InkwireClientError("invalid_payload", "upload_media requires either 'url' or 'data'", 0)


def _preview(text: str, limit: int = 60) -> str:
    shown = text.replace("\n", "\\n")
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"


def edits(markdown: str, changes: Iterable[Mapping[str, str]]) -> str:
    current = markdown
    for index, change in enumerate(changes):
        find = change.get("find") if isinstance(change, Mapping) else None
        replace = change.get("replace") if isinstance(change, Mapping) else None
        if not isinstance(find, str) or find == "":
            raise InkwireClientError(
                "edit_not_found", f"edit_not_found: edit {index + 1} has an empty 'find'", 0
            )
        if not isinstance(replace, str):
            raise InkwireClientError(
                "invalid_payload", f"edit {index + 1} has an invalid 'replace'", 0
            )
        count = current.count(find)
        if count == 0:
            raise InkwireClientError(
                "edit_not_found",
                f"edit_not_found: edit {index + 1}: '{_preview(find)}' does not occur in the markdown",
                0,
            )
        if count > 1:
            raise InkwireClientError(
                "edit_ambiguous",
                f"edit_ambiguous: edit {index + 1}: '{_preview(find)}' occurs {count} times; include more surrounding text so it matches once",
                0,
            )
        current = current.replace(find, replace, 1)
    return current


__all__ = [
    "InkwireClientError",
    "publish",
    "capabilities",
    "list",
    "get",
    "update",
    "remove",
    "upload_media",
    "edits",
]
