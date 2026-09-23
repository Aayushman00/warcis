"""ORM mappings for social.* (owned) and a read-only view of auth.users.

DDL (constraints, partial unique indexes, capacity trigger) lives in db/postgres/01_schema.sql.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

UUIDPK = UUID(as_uuid=True)


class User(Base):
    """READ-ONLY here. auth-service owns writes; party-service joins it for names and presence."""

    __tablename__ = "users"
    __table_args__ = {"schema": "auth"}

    id: Mapped[uuid.UUID] = mapped_column(UUIDPK, primary_key=True)
    username: Mapped[str] = mapped_column(String(16))
    tag: Mapped[str] = mapped_column(String(4))
    status_pref: Mapped[str] = mapped_column(String(8))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FriendRequest(Base):
    __tablename__ = "friend_requests"
    __table_args__ = {"schema": "social"}

    id: Mapped[uuid.UUID] = mapped_column(UUIDPK, primary_key=True, default=uuid.uuid4)
    from_user: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"))
    to_user: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"))
    status: Mapped[str] = mapped_column(String(9), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Friendship(Base):
    __tablename__ = "friendships"
    __table_args__ = {"schema": "social"}

    user_a: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"), primary_key=True)
    user_b: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Party(Base):
    __tablename__ = "parties"
    __table_args__ = {"schema": "social"}

    id: Mapped[uuid.UUID] = mapped_column(UUIDPK, primary_key=True, default=uuid.uuid4)
    leader_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"))
    status: Mapped[str] = mapped_column(String(9), default="active")
    version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PartyMember(Base):
    __tablename__ = "party_members"
    __table_args__ = {"schema": "social"}

    party_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("social.parties.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"), primary_key=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PartyInvitation(Base):
    __tablename__ = "party_invitations"
    __table_args__ = {"schema": "social"}

    id: Mapped[uuid.UUID] = mapped_column(UUIDPK, primary_key=True, default=uuid.uuid4)
    party_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("social.parties.id"))
    from_user: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"))
    to_user: Mapped[uuid.UUID] = mapped_column(ForeignKey("auth.users.id"))
    status: Mapped[str] = mapped_column(String(9), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
