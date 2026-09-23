"""HTTP client for party-service's /internal API. Postgres (via party-service) is authoritative."""

import os

import httpx
from arcline_common.errors import ApiError
from arcline_common.security import INTERNAL_TOKEN

_http = httpx.AsyncClient(
    base_url=os.environ["PARTY_SERVICE_URL"], headers={"X-Internal-Token": INTERNAL_TOKEN}, timeout=3.0
)


async def _post(path: str, json: dict | None = None) -> dict:
    try:
        r = await _http.post(path, json=json)
    except httpx.HTTPError:
        raise ApiError(503, "PARTY_SERVICE_UNAVAILABLE", "Party service is unreachable. Try again.")
    if r.status_code >= 400:
        err = r.json().get("error", {})
        raise ApiError(r.status_code, err.get("code", "PARTY_SERVICE_ERROR"), err.get("message", "Party service error."))
    return r.json()


async def party_for_queue(user_id: str) -> dict:
    return await _post(f"/internal/parties/for-queue/{user_id}")


async def stale(refs: list[tuple[str, int]]) -> set[str]:
    body = {"parties": [{"id": pid, "version": v} for pid, v in refs]}
    return set((await _post("/internal/parties/validate", body))["stale"])
