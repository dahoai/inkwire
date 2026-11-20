"""Bearer key parsing and authorization, including read-only keys (SPEC.md "Auth")."""

from __future__ import annotations

import hmac
import re
from dataclasses import dataclass

from .errors import InkwireError

_BEARER = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)


DEFAULT_SCOPE = "default"


@dataclass(frozen=True)
class ApiKey:
    """One accepted key. ``ro`` keys may call every GET and get 403 on anything that writes.

    ``scope`` is what stores partition content by: keys parsed together belong to one site and
    share one scope, so a read-only audit key sees what the full key wrote. A multi-tenant
    adapter builds ``ApiKey`` objects itself with one scope per site.
    """

    key: str
    ro: bool = False
    scope: str = DEFAULT_SCOPE


def parse_api_keys(raw: str | None, scope: str = DEFAULT_SCOPE) -> list[ApiKey]:
    """``"dev-key,audit-key:ro"`` -> ``[ApiKey("dev-key"), ApiKey("audit-key", ro=True)]``.

    Trims, skips empty entries. A key may contain ``:`` only as the trailing ``:ro``.
    """
    keys: list[ApiKey] = []
    for part in (raw or "").split(","):
        item = part.strip()
        if not item:
            continue
        ro = item.endswith(":ro")
        key = item[: -len(":ro")].strip() if ro else item
        if not key:
            continue
        if ":" in key:
            # Never echo the key itself: configuration errors must not leak secrets to logs.
            raise ValueError("invalid API key entry: ':' is only allowed as a trailing ':ro'")
        keys.append(ApiKey(key=key, ro=ro, scope=scope))
    return keys


def authorize(auth_header: str | None, keys: list[ApiKey] | list[str]) -> ApiKey:
    """Return the matching key or raise ``unauthorized``.

    Plain strings are accepted for convenience and treated as full keys.
    Every key is compared, in constant time, before the result is announced.
    """
    token = ""
    if auth_header:
        match = _BEARER.match(auth_header.strip())
        if match:
            token = match.group(1).strip()
    found: ApiKey | None = None
    for key in _normalize(keys):
        if hmac.compare_digest(key.key, token) and found is None:
            found = key
    if found is None:
        raise InkwireError("unauthorized", "missing or invalid API key")
    return found


def require_write(api_key: ApiKey) -> None:
    """Raise ``forbidden`` when a read-only key attempts a write."""
    if api_key.ro:
        raise InkwireError("forbidden", "this API key is read-only")


def _normalize(keys: list[ApiKey] | list[str]) -> list[ApiKey]:
    return [k if isinstance(k, ApiKey) else ApiKey(key=str(k)) for k in keys]
