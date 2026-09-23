"""Party rules. Postgres is the source of truth for membership.

Every mutation runs in one transaction and locks the affected party row(s)
with SELECT ... FOR UPDATE, so concurrent joins/leaves on the same party serialize.
Every membership/leader change bumps parties.version (see matchmaking validation).
"""

import uuid

from arcline_common.errors import ApiError
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.tables import Party, PartyInvitation, PartyMember, User
from app.services.friends import are_friends, presence, uid, user_out

MAX_PARTY = 4


# ─────────────── reads ───────────────


def party_of(db: Session, user_id: uuid.UUID) -> Party | None:
    return db.scalar(
        select(Party).join(PartyMember, PartyMember.party_id == Party.id).where(PartyMember.user_id == user_id, Party.status == "active")
    )


def lock(db: Session, party_id: uuid.UUID) -> Party:
    return db.get(Party, party_id, with_for_update=True, populate_existing=True)


def members(db: Session, party_id: uuid.UUID) -> list[User]:
    return list(
        db.scalars(
            select(User).join(PartyMember, PartyMember.user_id == User.id).where(PartyMember.party_id == party_id).order_by(PartyMember.joined_at)
        )
    )


def pending(db: Session, party_id: uuid.UUID) -> list[tuple[PartyInvitation, User]]:
    return list(
        db.execute(
            select(PartyInvitation, User)
            .join(User, User.id == PartyInvitation.to_user)
            .where(PartyInvitation.party_id == party_id, PartyInvitation.status == "pending")
            .order_by(PartyInvitation.created_at)
        ).tuples()
    )


def member_count(db: Session, party_id: uuid.UUID) -> int:
    return db.scalar(select(func.count()).select_from(PartyMember).where(PartyMember.party_id == party_id))


def view(db: Session, p: Party | None) -> dict | None:
    if p is None:
        return None
    return {
        "id": str(p.id),
        "leader_id": str(p.leader_id),
        "version": p.version,
        "max_size": MAX_PARTY,
        "members": [user_out(u) for u in members(db, p.id)],
        "pending": [{"invite_id": str(i.id), "user": user_out(u)} for i, u in pending(db, p.id)],
    }


def incoming_invites(db: Session, me: uuid.UUID) -> list[dict]:
    rows = db.execute(
        select(PartyInvitation, User)
        .join(User, User.id == PartyInvitation.from_user)
        .join(Party, Party.id == PartyInvitation.party_id)
        .where(PartyInvitation.to_user == me, PartyInvitation.status == "pending", Party.status == "active")
        .order_by(PartyInvitation.created_at)
    ).tuples()
    out = []
    for inv, sender in rows:
        leader = db.get(Party, inv.party_id).leader_id
        out.append(
            {
                "id": str(inv.id),
                "from": user_out(sender),
                "party": {"id": str(inv.party_id), "size": member_count(db, inv.party_id), "leader_id": str(leader)},
            }
        )
    return out


# ─────────────── mutations ───────────────


def _create(db: Session, owner: uuid.UUID) -> Party:
    p = Party(leader_id=owner)
    db.add(p)
    db.flush()
    db.add(PartyMember(party_id=p.id, user_id=owner))
    db.flush()
    return p


def _remove(db: Session, p: Party, user_id: uuid.UUID) -> None:
    """Remove a member from a LOCKED party: promote a new leader or disband if empty."""
    db.execute(PartyMember.__table__.delete().where(PartyMember.party_id == p.id, PartyMember.user_id == user_id))
    rest = members(db, p.id)
    if not rest:
        p.status = "disbanded"
        db.execute(
            update(PartyInvitation).where(PartyInvitation.party_id == p.id, PartyInvitation.status == "pending").values(status="cancelled")
        )
    elif p.leader_id == user_id:
        p.leader_id = rest[0].id  # longest-standing member inherits leadership
    p.version += 1


def create(db: Session, me: uuid.UUID) -> tuple[dict, bool]:
    """Idempotent: returns the existing party if the user already has one."""
    with db.begin():
        existing = party_of(db, me)
        p = existing or _create(db, me)
    return view(db, p), existing is None


def invite(db: Session, me: uuid.UUID, target_id: str) -> dict:
    tid = uid(target_id)
    with db.begin():
        target = db.get(User, tid)
        if not target:
            raise ApiError(404, "USER_NOT_FOUND", "Player not found.")
        if tid == me:
            raise ApiError(400, "CANNOT_INVITE_SELF", "You can't invite yourself.")
        if not are_friends(db, me, tid):
            raise ApiError(403, "NOT_FRIENDS", f"{target.username} is not on your friends list.")
        if presence(target) == "offline":
            raise ApiError(409, "USER_UNAVAILABLE", f"{target.username} is offline.")

        p = party_of(db, me) or _create(db, me)  # inviting implicitly creates your party
        p = lock(db, p.id)
        if any(m.id == tid for m in members(db, p.id)):
            raise ApiError(409, "ALREADY_IN_PARTY", f"{target.username} is already in your party.")
        if any(u.id == tid for _, u in pending(db, p.id)):
            raise ApiError(409, "INVITE_PENDING", f"{target.username} already has a pending invite.")
        if member_count(db, p.id) + len(pending(db, p.id)) >= MAX_PARTY:
            raise ApiError(409, "PARTY_FULL", "Party is full.")
        db.add(PartyInvitation(party_id=p.id, from_user=me, to_user=tid))
    return view(db, p)


def cancel_invite(db: Session, me: uuid.UUID, invite_id: str) -> None:
    with db.begin():
        inv = db.get(PartyInvitation, uid(invite_id), with_for_update=True)
        if not inv or inv.status != "pending":
            raise ApiError(404, "INVITE_NOT_FOUND", "Invite not found.")
        if me not in (inv.from_user, db.get(Party, inv.party_id).leader_id):
            raise ApiError(403, "FORBIDDEN", "Only the sender or party leader can cancel this invite.")
        inv.status = "cancelled"


def answer_invite(db: Session, me: uuid.UUID, invite_id: str, accept: bool) -> dict | None:
    with db.begin():
        inv = db.get(PartyInvitation, uid(invite_id), with_for_update=True)
        if not inv or inv.to_user != me:
            raise ApiError(404, "INVITE_NOT_FOUND", "Invite not found.")
        if inv.status != "pending":
            raise ApiError(409, "INVITE_CLOSED", "This invite is no longer valid.")
        if not accept:
            inv.status = "declined"
            return None

        current = party_of(db, me)
        # Lock both parties in a fixed (id) order so two users swapping parties can't deadlock.
        locked = {pid: lock(db, pid) for pid in sorted({inv.party_id, *([current.id] if current else [])})}
        target = locked[inv.party_id]
        if target.status != "active":
            raise ApiError(409, "PARTY_GONE", "That party no longer exists.")
        if member_count(db, target.id) >= MAX_PARTY:
            raise ApiError(409, "PARTY_FULL", "That party is already full.")
        if current and current.id == target.id:
            inv.status = "accepted"
        else:
            if current:
                _remove(db, locked[current.id], me)  # joining a party means leaving your old one
            db.add(PartyMember(party_id=target.id, user_id=me))
            try:
                db.flush()
            except IntegrityError:  # capacity trigger / one-party-per-user unique constraint
                raise ApiError(409, "PARTY_FULL", "That party is already full.")
            target.version += 1
            inv.status = "accepted"
    return view(db, target)


def leave(db: Session, me: uuid.UUID) -> None:
    with db.begin():
        p = party_of(db, me)
        if not p:
            raise ApiError(404, "NOT_IN_PARTY", "You are not in a party.")
        _remove(db, lock(db, p.id), me)


def kick(db: Session, me: uuid.UUID, member_id: str) -> dict:
    mid = uid(member_id)
    with db.begin():
        p = party_of(db, me)
        if not p:
            raise ApiError(404, "NOT_IN_PARTY", "You are not in a party.")
        p = lock(db, p.id)
        if p.leader_id != me:
            raise ApiError(403, "NOT_LEADER", "Only the party leader can remove members.")
        if mid == me:
            raise ApiError(400, "CANNOT_KICK_SELF", "Use leave party instead.")
        if not any(m.id == mid for m in members(db, p.id)):
            raise ApiError(404, "NOT_A_MEMBER", "That player is not in your party.")
        _remove(db, p, mid)
    return view(db, p)


# ─────────────── internal (matchmaking-service) ───────────────


def ensure_for_queue(db: Session, user_id: str) -> dict:
    """Party snapshot used by matchmaking. Solo players get a 1-person party created."""
    me = uid(user_id)
    with db.begin():
        p = party_of(db, me) or _create(db, me)
    v = view(db, p)
    return {
        "party_id": v["id"],
        "leader_id": v["leader_id"],
        "version": v["version"],
        "members": [{"id": m["id"], "name": m["name"], "tag": m["tag"]} for m in v["members"]],
        "pending_invites": len(v["pending"]),
    }


def stale_parties(db: Session, refs: list[tuple[str, int]]) -> list[str]:
    """Parties whose queued snapshot no longer matches Postgres (changed, disbanded, or missing)."""
    ids = [uid(i) for i, _ in refs]
    current = {str(p.id): p for p in db.scalars(select(Party).where(Party.id.in_(ids)))}
    return [i for i, ver in refs if (p := current.get(i)) is None or p.status != "active" or p.version != ver]
