from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import (
    ALLOWED_HOSTS,
    CORS_ALLOW_CREDENTIALS,
    CORS_ALLOW_HEADERS,
    CORS_ALLOW_METHODS,
    CORS_ALLOW_ORIGINS,
    STATIC_DIR,
)
from .db import close_mongo_conn, init_mongo_db
from .middleware import StaticCacheMiddleware
from .routes import admin, public, web
from .services.sessions import sync_live_admin_payload

app = FastAPI(title='FastAPI Dashboard')
app.add_middleware(StaticCacheMiddleware)
if ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_methods=CORS_ALLOW_METHODS,
    allow_headers=CORS_ALLOW_HEADERS,
)
app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')

app.include_router(web.router)
app.include_router(admin.router)
app.include_router(public.router)


@app.on_event('startup')
async def startup() -> None:
    init_mongo_db()
    sync_live_admin_payload()


@app.on_event('shutdown')
async def shutdown() -> None:
    close_mongo_conn()
