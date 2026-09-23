"""ARCLINE API gateway: one public origin, path-prefix routing to internal services.

    /api/auth/*, /api/users/*   -> auth-service
    /api/social/*               -> party-service
    /api/matchmaking/*          -> matchmaking-service

/internal/* is never routable from outside. JWTs are forwarded untouched; each service
verifies them itself.
"""

import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

ROUTES = {
    "auth": os.environ["AUTH_SERVICE_URL"],
    "users": os.environ["AUTH_SERVICE_URL"],
    "social": os.environ["PARTY_SERVICE_URL"],
    "matchmaking": os.environ["MATCHMAKING_SERVICE_URL"],
}
FORWARD_HEADERS = ("authorization", "content-type", "accept")

http: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_: FastAPI):
    global http
    http = httpx.AsyncClient(timeout=10.0)
    yield
    await http.aclose()


app = FastAPI(title="ARCLINE gateway", lifespan=lifespan, docs_url=None, redoc_url=None)


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@app.get("/health")
def health():
    return {"ok": True}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(path: str, request: Request):
    upstream = ROUTES.get(path.split("/", 1)[0])
    if upstream is None:
        return error(404, "NOT_FOUND", f"No route for /api/{path}")
    try:
        r = await http.request(
            request.method,
            f"{upstream}/{path}",
            params=request.query_params,
            content=await request.body(),
            headers={k: v for k, v in request.headers.items() if k.lower() in FORWARD_HEADERS},
        )
    except httpx.HTTPError:
        return error(502, "SERVICE_UNAVAILABLE", f"{path.split('/', 1)[0]} service is unavailable.")
    return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))
