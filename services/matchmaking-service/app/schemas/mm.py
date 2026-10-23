from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from warcis_common import loadout


class QueueIn(BaseModel):
    mode: Literal["squad"] = "squad"
    fill: bool = True  # False: party is queued and matched as-is, never combined with other parties


class LoadoutIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    class_: str = Field(alias="class")
    weapon: str

    @field_validator("class_")
    @classmethod
    def _class(cls, v: str) -> str:
        if v not in loadout.CLASSES:
            raise ValueError(f"must be one of {', '.join(loadout.CLASSES)}")
        return v

    @field_validator("weapon")
    @classmethod
    def _weapon(cls, v: str) -> str:
        if v not in loadout.WEAPONS:
            raise ValueError(f"must be one of {', '.join(loadout.WEAPONS)}")
        return v
