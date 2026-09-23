from typing import Literal

from pydantic import BaseModel, Field

Status = Literal["online", "away", "offline"]


class RegisterIn(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{3,16}$")
    email: str = Field(pattern=r"^\S+@\S+\.\S+$", max_length=254)
    password: str = Field(min_length=6, max_length=128)


class LoginIn(BaseModel):
    login: str = Field(min_length=1, max_length=254, description="Username or email")
    password: str = Field(min_length=1, max_length=128)


class StatusIn(BaseModel):
    status: Literal["online", "away"]


class UserOut(BaseModel):
    id: str
    name: str
    tag: str
    status: Status


class SessionOut(BaseModel):
    token: str
    user: UserOut
