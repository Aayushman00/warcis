from typing import Literal

from pydantic import BaseModel


class QueueIn(BaseModel):
    mode: Literal["squad"] = "squad"
    fill: bool = True  # False: party is queued and matched as-is, never combined with other parties
