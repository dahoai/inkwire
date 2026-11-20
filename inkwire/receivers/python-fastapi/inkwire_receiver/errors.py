"""Inkwire error codes and their HTTP statuses (SPEC.md "Errors")."""

from __future__ import annotations

HTTP_STATUS = {
    "invalid_payload": 400,
    "unauthorized": 401,
    "forbidden": 403,
    "not_found": 404,
    "conflict": 409,
    "stale": 412,
    "too_large": 413,
    "rate_limited": 429,
    "internal": 500,
}


class InkwireError(Exception):
    """A protocol error: renders as ``{"error": {"code", "message"}}``."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = HTTP_STATUS[code]
