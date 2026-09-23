from arcline_common.security import CurrentUser, current_user, internal_only
from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.social import FriendRequestIn, InviteIn, ValidateIn
from app.services import friends, parties
from app.services.friends import uid

router = APIRouter(prefix="/social")
internal = APIRouter(prefix="/internal", dependencies=[Depends(internal_only)])


def me_id(me: CurrentUser = Depends(current_user)):
    return uid(me.id)


# ─────────────── aggregate (what the launcher polls) ───────────────


@router.get("/state")
def state(me=Depends(me_id), db: Session = Depends(get_db)):
    """Everything the hub renders, in one round trip: friends, requests, party, invites."""
    return {
        "friends": friends.list_friends(db, me),
        "requests": friends.list_requests(db, me),
        "party": parties.view(db, parties.party_of(db, me)),
        "invitations": parties.incoming_invites(db, me),
    }


# ─────────────── friends ───────────────


@router.get("/users/search")
def search(q: str = Query(min_length=1, max_length=16), me=Depends(me_id), db: Session = Depends(get_db)):
    return friends.search_users(db, me, q)


@router.get("/friends")
def list_friends(me=Depends(me_id), db: Session = Depends(get_db)):
    return friends.list_friends(db, me)


@router.get("/friend-requests")
def list_requests(me=Depends(me_id), db: Session = Depends(get_db)):
    return friends.list_requests(db, me)


@router.post("/friend-requests", status_code=201)
def send_request(body: FriendRequestIn, me=Depends(me_id), db: Session = Depends(get_db)):
    return friends.send_request(db, me, body.username)


@router.post("/friend-requests/{request_id}/accept", status_code=204)
def accept_request(request_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    friends.respond(db, me, request_id, accept=True)
    return Response(status_code=204)


@router.post("/friend-requests/{request_id}/reject", status_code=204)
def reject_request(request_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    friends.respond(db, me, request_id, accept=False)
    return Response(status_code=204)


# ─────────────── party ───────────────


@router.get("/party")
def get_party(me=Depends(me_id), db: Session = Depends(get_db)):
    return parties.view(db, parties.party_of(db, me))


@router.post("/party")
def create_party(response: Response, me=Depends(me_id), db: Session = Depends(get_db)):
    party, created = parties.create(db, me)
    response.status_code = 201 if created else 200
    return party


@router.post("/party/invitations", status_code=201)
def invite(body: InviteIn, me=Depends(me_id), db: Session = Depends(get_db)):
    return parties.invite(db, me, body.user_id)


@router.delete("/party/invitations/{invite_id}", status_code=204)
def cancel_invite(invite_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    parties.cancel_invite(db, me, invite_id)
    return Response(status_code=204)


@router.post("/party/leave", status_code=204)
def leave(me=Depends(me_id), db: Session = Depends(get_db)):
    parties.leave(db, me)
    return Response(status_code=204)


@router.delete("/party/members/{member_id}")
def kick(member_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    return parties.kick(db, me, member_id)


@router.get("/invitations")
def incoming(me=Depends(me_id), db: Session = Depends(get_db)):
    return parties.incoming_invites(db, me)


@router.post("/invitations/{invite_id}/accept")
def accept_invite(invite_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    return parties.answer_invite(db, me, invite_id, accept=True)


@router.post("/invitations/{invite_id}/decline", status_code=204)
def decline_invite(invite_id: str, me=Depends(me_id), db: Session = Depends(get_db)):
    parties.answer_invite(db, me, invite_id, accept=False)
    return Response(status_code=204)


# ─────────────── internal: called by matchmaking-service only ───────────────


@internal.post("/parties/for-queue/{user_id}")
def party_for_queue(user_id: str, db: Session = Depends(get_db)):
    return parties.ensure_for_queue(db, user_id)


@internal.post("/parties/validate")
def validate(body: ValidateIn, db: Session = Depends(get_db)):
    return {"stale": parties.stale_parties(db, [(p.id, p.version) for p in body.parties])}
