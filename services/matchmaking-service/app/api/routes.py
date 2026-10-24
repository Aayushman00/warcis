from warcis_common.security import CurrentUser, current_user
from fastapi import APIRouter, Depends, Query, Response

from app.schemas.mm import LoadoutIn, QueueIn
from app.services import queue, stats

router = APIRouter(prefix="/matchmaking")


@router.post("/queue")
async def join_queue(body: QueueIn, me: CurrentUser = Depends(current_user)):
    return await queue.enqueue(me.id, body.mode, body.fill)


@router.delete("/queue", status_code=204)
async def leave_queue(me: CurrentUser = Depends(current_user)):
    await queue.cancel(me.id)
    return Response(status_code=204)


@router.get("/queue/waiting")
async def waiting(me: CurrentUser = Depends(current_user)):
    return await queue.waiting()


@router.get("/status")
async def get_status(me: CurrentUser = Depends(current_user)):
    return await queue.status(me.id)


@router.post("/matches/{match_id}/ready")
async def ready(match_id: str, me: CurrentUser = Depends(current_user)):
    return await queue.ready(match_id, me.id)


@router.put("/matches/{match_id}/loadout")
async def set_loadout(match_id: str, body: LoadoutIn, me: CurrentUser = Depends(current_user)):
    return await queue.set_loadout(match_id, me.id, body.class_, body.weapon)


@router.post("/matches/{match_id}/leave", status_code=204)
async def leave(match_id: str, me: CurrentUser = Depends(current_user)):
    await queue.leave(match_id, me.id)
    return Response(status_code=204)


@router.get("/stats")
async def player_stats(ids: str = Query(..., description="Comma-separated user ids"), me: CurrentUser = Depends(current_user)):
    """Career wins / losses / kills / deaths / captures for each id. Public to any signed-in user."""
    return await stats.player_stats([i for i in ids.split(",") if i.strip()])


@router.get("/history")
async def history(limit: int = Query(20, ge=1, le=stats.MAX_HISTORY), before: str | None = None, me: CurrentUser = Depends(current_user)):
    """Your finished matches, newest first, with the full scoreboard of each."""
    return await stats.history(me.id, limit, before)
