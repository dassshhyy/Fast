from datetime import datetime, timezone
from urllib.parse import urlencode

from ..db import get_mongo_db


DEFAULT_FRONTEND_INDEX_URL = '/'


def frontend_index_url(origin: str = '') -> str:
    clean_origin = (origin or '').strip().rstrip('/')
    if clean_origin:
        return f'{clean_origin}{DEFAULT_FRONTEND_INDEX_URL}'
    return DEFAULT_FRONTEND_INDEX_URL


def build_visitor_redirect_url(
    visitor_uid: str,
    *,
    backend_base_url: str = '',
    next_url: str | None = None,
) -> str:
    target_next = (next_url or DEFAULT_FRONTEND_INDEX_URL).strip() or DEFAULT_FRONTEND_INDEX_URL
    query = urlencode({'visitor_uid': visitor_uid, 'next': target_next})
    blocked_path = f'/blocked?{query}'
    if not backend_base_url:
        return blocked_path
    return f'{backend_base_url.rstrip("/")}{blocked_path}'


def is_visitor_blocked(visitor_uid: str) -> bool:
    if not visitor_uid:
        return False
    try:
        db = get_mongo_db()
        row = db.visitor_profiles.find_one({'visitor_uid': visitor_uid}, {'is_blocked': 1})
        return bool(row and row.get('is_blocked'))
    except Exception:
        return False


def set_visitor_blocked(visitor_uid: str, blocked: bool = True) -> tuple[bool, str]:
    if not visitor_uid:
        return False, 'invalid_uid'
    try:
        db = get_mongo_db()
        result = db.visitor_profiles.update_one(
            {'visitor_uid': visitor_uid},
            {
                '$set': {
                    'is_blocked': bool(blocked),
                    'blocked_at': datetime.now(timezone.utc) if blocked else None,
                }
            },
            upsert=True,
        )
        if result.matched_count == 0 and result.upserted_id is None:
            return False, 'not_found'
        return True, ''
    except Exception:
        return False, 'db_error'


def get_blocked_visitor_uids(visitor_uids: list[str]) -> set[str]:
    if not visitor_uids:
        return set()
    try:
        db = get_mongo_db()
        rows = db.visitor_profiles.find(
            {'visitor_uid': {'$in': [uid for uid in visitor_uids if uid]}, 'is_blocked': True},
            {'visitor_uid': 1},
        )
        return {row.get('visitor_uid', '') for row in rows if row.get('visitor_uid')}
    except Exception:
        return set()


def get_visitor_status(visitor_uid: str, next_url: str | None = None) -> dict:
    blocked = is_visitor_blocked(visitor_uid)
    target_next = (next_url or DEFAULT_FRONTEND_INDEX_URL).strip() or DEFAULT_FRONTEND_INDEX_URL
    return {
        'blocked': blocked,
        'redirect_url': target_next,
        'blocked_redirect_url': build_visitor_redirect_url(visitor_uid, next_url=target_next),
    }
