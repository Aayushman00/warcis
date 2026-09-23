"""JWT verification and service-to-service auth.

Every service verifies the JWT locally with the shared secret (stateless), so no
per-request round trip to auth-service is needed.
"""

import os
from dataclasses import dataclass

import jwt
from fastapi import Header

from .errors import ApiError

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"
INTERNAL_TOKEN = os.environ["INTERNAL_TOKEN"]


@dataclass(frozen=True)
class CurrentUser:
    id: str
    name: str


def decode_token(token: str) -> CurrentUser:
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG], options={"require": ["sub", "exp"]})
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "TOKEN_EXPIRED", "Session expired. Sign in again.")
    except jwt.PyJWTError:
        raise ApiError(401, "INVALID_TOKEN", "Invalid authentication token.")
    return CurrentUser(id=claims["sub"], name=claims.get("name", ""))


def current_user(authorization: str | None = Header(default=None)) -> CurrentUser:
    """FastAPI dependency: `user: CurrentUser = Depends(current_user)`."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ApiError(401, "UNAUTHENTICATED", "Missing bearer token.")
    return decode_token(authorization[7:])


def internal_only(x_internal_token: str | None = Header(default=None)) -> None:
    """Guards /internal/* routes. The gateway never forwards /internal, this is a second lock."""
    if x_internal_token != INTERNAL_TOKEN:
        raise ApiError(403, "FORBIDDEN", "Internal endpoint.")
