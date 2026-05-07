from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import STATIC_DIR
from .db import close_mongo_conn, init_mongo_db
from .middleware import StaticCacheMiddleware
from .routes import admin, public, web
from .services.sessions import sync_live_admin_payload

app = FastAPI(title='FastAPI Dashboard')
app.add_middleware(StaticCacheMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://127.0.0.1:8000',
        'http://localhost:8000',
        'http://127.0.0.1:5500',
        'http://localhost:5500',
        'http://127.0.0.1:8001',
        'http://localhost:8001',
        'null',
    ],
    allow_credentials=True,
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['*'],
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
