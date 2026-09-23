import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class User(Base):
    """Maps auth.users (DDL lives in db/postgres/01_schema.sql)."""

    __tablename__ = "users"
    __table_args__ = {"schema": "auth"}

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(16))
    tag: Mapped[str] = mapped_column(String(4))
    email: Mapped[str] = mapped_column(String(254))
    password_hash: Mapped[str]
    status_pref: Mapped[str] = mapped_column(String(8), default="online")
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
