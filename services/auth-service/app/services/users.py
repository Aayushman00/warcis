import os
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from arcline_common.errors import ApiError
from arcline_common.security import JWT_ALG, JWT_SECRET
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.user import UserOut

PRESENCE_TIMEOUT = timedelta(seconds=int(os.environ.get("PRESENCE_TIMEOUT_S", "30")))
TOKEN_TTL = timedelta(hours=int(os.environ.get("JWT_TTL_HOURS", "12")))


def now() -> datetime:
    return datetime.now(timezone.utc)


def presence(u: User) -> str:
    """Online/away if the client heartbeated recently, else offline."""
    if u.last_seen is None or now() - u.last_seen > PRESENCE_TIMEOUT:
        return "offline"
    return u.status_pref


def to_out(u: User) -> UserOut:
    return UserOut(id=str(u.id), name=u.username, tag=u.tag, status=presence(u))


def issue_token(u: User) -> str:
    claims = {"sub": str(u.id), "name": u.username, "exp": now() + TOKEN_TTL}
    return jwt.encode(claims, JWT_SECRET, algorithm=JWT_ALG)


def register(db: Session, username: str, email: str, password: str) -> User:
    taken = db.scalar(
        select(User.id).where(or_(func.lower(User.username) == username.lower(), func.lower(User.email) == email.lower()))
    )
    if taken:
        raise ApiError(409, "ACCOUNT_EXISTS", "Username or email is already registered.")
    user = User(
        username=username,
        email=email,
        tag=f"{secrets.randbelow(9000) + 1000}",
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        last_seen=now(),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:  # lost a race with a concurrent registration; unique index decides
        db.rollback()
        raise ApiError(409, "ACCOUNT_EXISTS", "Username or email is already registered.")
    return user


def authenticate(db: Session, login: str, password: str) -> User:
    user = db.scalar(
        select(User).where(or_(func.lower(User.username) == login.lower(), func.lower(User.email) == login.lower()))
    )
    if not user or not bcrypt.checkpw(password.encode(), user.password_hash.encode()):
        raise ApiError(401, "INVALID_CREDENTIALS", "Incorrect username or password.")
    user.last_seen = now()
    db.commit()
    return user


def get_user(db: Session, user_id: str) -> User:
    try:
        user = db.get(User, user_id)
    except Exception:  # malformed UUID
        user = None
    if not user:
        raise ApiError(404, "USER_NOT_FOUND", "User not found.")
    return user


def touch(db: Session, user: User, status: str | None = None) -> User:
    user.last_seen = now()
    if status:
        user.status_pref = status
    db.commit()
    return user
