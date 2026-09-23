import os
import uuid
from datetime import datetime, timedelta, timezone

from arcline_common.errors import ApiError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.tables import FriendRequest, Friendship, User

PRESENCE_TIMEOUT = timedelta(seconds=int(os.environ.get("PRESENCE_TIMEOUT_S", "30")))


def uid(s: str | uuid.UUID) -> uuid.UUID:
    """Parse an id from a path/body/token; malformed ids are simply 'not found'."""
    try:
        return s if isinstance(s, uuid.UUID) else uuid.UUID(s)
    except ValueError:
        raise ApiError(404, "NOT_FOUND", "Resource not found.")


def presence(u: User) -> str:
    if u.last_seen is None or datetime.now(timezone.utc) - u.last_seen > PRESENCE_TIMEOUT:
        return "offline"
    return u.status_pref


def user_out(u: User) -> dict:
    return {"id": str(u.id), "name": u.username, "tag": u.tag, "status": presence(u)}


def pair(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    return (a, b) if a < b else (b, a)


def are_friends(db: Session, a: uuid.UUID, b: uuid.UUID) -> bool:
    return db.get(Friendship, pair(a, b)) is not None


def list_friends(db: Session, me: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(User).join(
            Friendship,
            or_(
                and_(Friendship.user_a == me, Friendship.user_b == User.id),
                and_(Friendship.user_b == me, Friendship.user_a == User.id),
            ),
        )
    ).all()
    out = [user_out(u) for u in rows]
    out.sort(key=lambda f: (f["status"] == "offline", f["name"].lower()))
    return out


def list_requests(db: Session, me: uuid.UUID) -> dict:
    def q(mine, other):
        rows = db.execute(
            select(FriendRequest, User)
            .join(User, User.id == other)
            .where(mine == me, FriendRequest.status == "pending")
            .order_by(FriendRequest.created_at)
        ).all()
        return [{"id": str(r.id), "user": user_out(u)} for r, u in rows]

    return {
        "incoming": q(FriendRequest.to_user, FriendRequest.from_user),
        "outgoing": q(FriendRequest.from_user, FriendRequest.to_user),
    }


def search_users(db: Session, me: uuid.UUID, q: str) -> list[dict]:
    rows = db.scalars(
        select(User).where(func.lower(User.username).startswith(q.lower()), User.id != me).order_by(User.username).limit(10)
    ).all()
    return [{**user_out(u), "friend": are_friends(db, me, u.id)} for u in rows]


def _befriend(db: Session, a: uuid.UUID, b: uuid.UUID) -> None:
    if not are_friends(db, a, b):
        ua, ub = pair(a, b)
        db.add(Friendship(user_a=ua, user_b=ub))


def send_request(db: Session, me: uuid.UUID, raw: str) -> dict:
    name, _, tag = raw.strip().partition("#")
    with db.begin():
        target = db.scalar(select(User).where(func.lower(User.username) == name.lower()))
        if not target or (tag and target.tag != tag):
            raise ApiError(404, "USER_NOT_FOUND", f"No player named {raw.strip()}.")
        if target.id == me:
            raise ApiError(400, "CANNOT_ADD_SELF", "You can't add yourself.")
        if are_friends(db, me, target.id):
            raise ApiError(409, "ALREADY_FRIENDS", f"{target.username} is already your friend.")

        # They already asked us: treat our request as acceptance.
        reverse = db.scalar(
            select(FriendRequest)
            .where(FriendRequest.from_user == target.id, FriendRequest.to_user == me, FriendRequest.status == "pending")
            .with_for_update()
        )
        if reverse:
            reverse.status = "accepted"
            _befriend(db, me, target.id)
            return {"status": "accepted", "user": user_out(target)}

        out = user_out(target)  # read before flush: a failed flush closes the transaction
        db.add(FriendRequest(from_user=me, to_user=target.id))
        try:
            db.flush()
        except IntegrityError:  # partial unique index: one pending request per direction
            raise ApiError(409, "REQUEST_PENDING", f"Request to {out['name']} is already pending.")
        return {"status": "pending", "user": out}


def respond(db: Session, me: uuid.UUID, request_id: str, accept: bool) -> None:
    with db.begin():
        r = db.get(FriendRequest, uid(request_id), with_for_update=True)
        if not r or r.to_user != me:
            raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
        if r.status != "pending":
            raise ApiError(409, "REQUEST_CLOSED", "Friend request was already answered.")
        r.status = "accepted" if accept else "rejected"
        if accept:
            _befriend(db, me, r.from_user)
