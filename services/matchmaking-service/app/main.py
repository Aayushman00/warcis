import asyncio
from contextlib import asynccontextmanager

from arcline_common.errors import install_error_handlers
from fastapi import FastAPI

from app.api.routes import router
from app.db.mongo import ensure_indexes
from app.services.queue import run_forever


@asynccontextmanager
async def lifespan(_: FastAPI):
    await ensure_indexes()
    # ponytail: matcher runs in-process, one replica. Run >1 replica only after moving
    # the loop to a single worker (or a leader lock); claims are already conditional.
    task = asyncio.create_task(run_forever())
    yield
    task.cancel()


app = FastAPI(title="ARCLINE matchmaking-service", lifespan=lifespan)
install_error_handlers(app)
app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True}
