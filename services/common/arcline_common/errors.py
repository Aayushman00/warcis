"""Structured JSON errors shared by every ARCLINE service.

Every error body has the same shape so the frontend can render it uniformly:
    {"error": {"code": "PARTY_FULL", "message": "Party is full."}}
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, e: ApiError):
        return JSONResponse(body(e.code, e.message), status_code=e.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        return JSONResponse(body(f"HTTP_{e.status_code}", str(e.detail)), status_code=e.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, e: Exception):
        print(f"[error] unhandled: {e!r}", flush=True)
        return JSONResponse(body("INTERNAL_ERROR", "Something went wrong."), status_code=500)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "request"
        return JSONResponse(body("INVALID_REQUEST", f"{field}: {first.get('msg', 'invalid')}"), status_code=400)
