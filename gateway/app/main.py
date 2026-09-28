"""WARCIS API gateway: one public origin, path-prefix routing to internal services.

    /api/auth/*, /api/users/*   -> auth-service
    /api/social/*               -> party-service
    /api/matchmaking/*          -> matchmaking-service
    WS /api/game/*              -> game-service (WebSocket passthrough)

/internal/* is never routable from outside. JWTs are forwarded untouched; each service
verifies them itself.
"""

import asyncio
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from websockets.asyncio.client import connect as ws_connect

ROUTES = {
    "auth": os.environ["AUTH_SERVICE_URL"],
    "users": os.environ["AUTH_SERVICE_URL"],
    "social": os.environ["PARTY_SERVICE_URL"],
    "matchmaking": os.environ["MATCHMAKING_SERVICE_URL"],
}
GAME_WS_URL = os.environ["GAME_SERVICE_URL"].replace("http", "ws", 1)
FORWARD_HEADERS = ("authorization", "content-type", "accept")

http: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_: FastAPI):
    global http
    http = httpx.AsyncClient(timeout=10.0)
    yield
    await http.aclose()


app = FastAPI(title="WARCIS gateway", lifespan=lifespan, docs_url=None, redoc_url=None)


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


@app.websocket("/api/game/{path:path}")
async def proxy_ws(path: str, ws: WebSocket):
    """Pipe frames both ways. Auth is the game-service's job (JWT in ?token=)."""
    await ws.accept()
    try:
        async with ws_connect(f"{GAME_WS_URL}/game/{path}?{ws.url.query}") as up:

            async def client_to_game():
                while True:
                    await up.send(await ws.receive_text())

            async def game_to_client():
                async for msg in up:
                    await ws.send_text(msg)

            tasks = [asyncio.create_task(client_to_game()), asyncio.create_task(game_to_client())]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in tasks:
                t.cancel()
    except Exception:
        pass  # either side went away
    try:
        await ws.close()
    except RuntimeError:
        pass  # already closed
