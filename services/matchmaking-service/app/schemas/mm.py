from typing import Literal

from pydantic import BaseModel


class QueueIn(BaseModel):
    mode: Literal["squad", "random"]
