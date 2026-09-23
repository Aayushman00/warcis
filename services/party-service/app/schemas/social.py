from pydantic import BaseModel, Field


class FriendRequestIn(BaseModel):
    # Accepts "Name" or "Name#1234"; the tag, when given, must match.
    username: str = Field(min_length=1, max_length=21)


class InviteIn(BaseModel):
    user_id: str


class PartyRef(BaseModel):
    id: str
    version: int


class ValidateIn(BaseModel):
    parties: list[PartyRef]
