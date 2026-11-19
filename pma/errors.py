"""Shared error type for the match service.

Every failure that reaches the HTTP layer is expressed as an ``ApiError`` so
that status codes and error codes stay consistent between the service, the
HTTP adapter and the tests.
"""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    """An error that maps directly onto an HTTP response.

    ``status`` is the HTTP status, ``code`` is a stable machine readable
    identifier (used by the web client and tests) and ``message`` is a human
    readable description.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    def to_payload(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            error["details"] = self.details
        return {"error": error}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ApiError(status={self.status}, code={self.code!r}, message={self.message!r})"
