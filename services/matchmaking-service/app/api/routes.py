from warcis_common.security import CurrentUser, current_user
from fastapi import APIRouter, Depends, Response

from app.schemas.mm import QueueIn
from app.services import queue

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


@router.post("/matches/{match_id}/leave", status_code=204)
async def leave(match_id: str, me: CurrentUser = Depends(current_user)):
    await queue.leave(match_id, me.id)
    return Response(status_code=204)
