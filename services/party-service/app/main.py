from arcline_common.errors import install_error_handlers
from fastapi import FastAPI

from app.api.routes import internal, router

app = FastAPI(title="ARCLINE party-service")
install_error_handlers(app)
app.include_router(router)
app.include_router(internal)


@app.get("/health")
def health():
    return {"ok": True}
