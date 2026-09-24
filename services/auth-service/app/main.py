from warcis_common.errors import install_error_handlers
from fastapi import FastAPI

from app.api.routes import router

app = FastAPI(title="WARCIS auth-service")
install_error_handlers(app)
app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True}
