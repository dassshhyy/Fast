import hmac
import threading
from datetime import datetime, timezone

from .. import state
from ..config import ADMIN_PASSWORD, ADMIN_USERNAME, ROOT_ADMIN_USERNAME
from ..db import get_mongo_db
from ..utils import hash_password, verify_password


def verify_admin_credentials(username: str, password: str):
    if hmac.compare_digest(username, ADMIN_USERNAME) and hmac.compare_digest(password, ADMIN_PASSWORD):
        return {'username': username, 'is_root': username == ROOT_ADMIN_USERNAME}

    try:
        db = get_mongo_db()
        row = db.admins.find_one({'username': username, 'is_suspended': {'$ne': True}})
        if not row or not verify_password(password, row.get('password_hash')):
            return None
        if not str(row.get('password_hash') or '').startswith('pbkdf2_sha256$'):
            db.admins.update_one(
                {'_id': row['_id']},
                {'$set': {'password_hash': hash_password(password)}, '$unset': {'plain_password': ''}},
            )
        return {'username': row['username'], 'is_root': row['username'] == ROOT_ADMIN_USERNAME}
    except Exception:
        return None


def is_admin_blocked(username: str) -> bool:
    if not username:
        return False
    if username in {ADMIN_USERNAME, ROOT_ADMIN_USERNAME}:
        return False
    try:
        db = get_mongo_db()
        row = db.admins.find_one({'username': username}, {'is_suspended': 1})
        return bool(row and row.get('is_suspended'))
    except Exception:
        return False


def validate_non_root_admin_username(username: str) -> bool:
    return username.lower() not in {ADMIN_USERNAME.lower(), ROOT_ADMIN_USERNAME.lower()}


def create_admin(username: str, password: str) -> tuple[bool, str]:
    try:
        db = get_mongo_db()
        exists = db.admins.find_one({'username': username}, {'_id': 1})
        if exists:
            return False, 'username_exists'

        db.admins.insert_one(
            {
                'username': username,
                'password_hash': hash_password(password),
                'is_suspended': False,
                'created_at': datetime.now(timezone.utc),
            }
        )
        state.sessions_list_cache['at'] = 0.0
        from .sessions import sync_live_admin_payload
        sync_live_admin_payload()
        return True, ''
    except Exception:
        return False, 'db_error'


def persist_admin_password_update_async(username: str, password: str) -> None:
    def _worker():
        try:
            db = get_mongo_db()
            db.admins.update_one(
                {'username': username},
                {
                    '$set': {
                        'password_hash': hash_password(password),
                    },
                    '$unset': {'plain_password': ''},
                },
            )
            state.sessions_list_cache['at'] = 0.0
            from .sessions import sync_live_admin_payload
            sync_live_admin_payload()
        except Exception:
            return

    threading.Thread(target=_worker, daemon=True).start()


def set_admin_blocked(username: str, blocked: bool = True) -> tuple[bool, str]:
    try:
        db = get_mongo_db()
        result = db.admins.update_one({'username': username}, {'$set': {'is_suspended': bool(blocked)}})
        if result.matched_count == 0:
            return False, 'not_found'
        state.sessions_list_cache['at'] = 0.0
        return True, ''
    except Exception:
        return False, 'db_error'
