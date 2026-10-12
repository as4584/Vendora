"""Response headers and request-size limits applied to every API request."""
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Larger than the biggest legitimate upload (50 MB spreadsheet import).
MAX_REQUEST_BYTES = 55 * 1024 * 1024

SECURITY_HEADERS = {
    b"strict-transport-security": b"max-age=31536000; includeSubDomains",
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"no-referrer",
    b"permissions-policy": b"camera=(), microphone=(), geolocation=()",
}


class HardeningMiddleware:
    """Adds standard browser-protection headers and refuses oversized bodies."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in SECURITY_HEADERS.items() if k not in present]
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        declared = dict(scope.get("headers", [])).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > self.max_bytes
            except ValueError:
                too_big = True
            if too_big:
                await JSONResponse({"detail": "Request body too large."}, status_code=413)(
                    scope, receive, send_with_headers
                )
                return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send_with_headers)
        except _TooLarge:
            await JSONResponse({"detail": "Request body too large."}, status_code=413)(
                scope, receive, send_with_headers
            )


class _TooLarge(Exception):
    pass
