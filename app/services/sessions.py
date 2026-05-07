import time
from datetime import datetime, timezone

from .. import state
from ..db import get_mongo_db
from ..utils import arabic_relative_time, detect_device_from_user_agent

ACTIVE_WINDOW_SECONDS = 15
SESSION_TOUCH_INTERVAL_SECONDS = 5
ACTIVE_SESSIONS_CACHE_TTL_SECONDS = 2
SESSIONS_LIST_CACHE_TTL_SECONDS = 1


def _active_filter(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - ACTIVE_WINDOW_SECONDS
    return {
        'is_active': True,
        'is_root': False,
        'last_seen_at': {'$gte': datetime.fromtimestamp(cutoff, tz=timezone.utc)},
    }


def sync_live_admin_payload() -> None:
    sessions = get_active_sessions_list()
    active_count = sum(1 for s in sessions if s.get('can_terminate'))
    state.live_admin_payload['ready'] = True
    state.live_admin_payload['active_sessions_count'] = active_count
    state.live_admin_payload['sessions'] = sessions


def persist_login_session(token: str, username: str, is_root: bool, user_agent: str) -> None:
    db = get_mongo_db()
    now = datetime.now(timezone.utc)
    device = detect_device_from_user_agent(user_agent)
    db.admin_sessions.update_one(
        {'token': token},
        {
            '$set': {
                'username': username,
                'is_root': is_root,
                'is_active': True,
                'user_agent': user_agent,
                'device': device,
                'last_seen_at': now,
            },
            '$setOnInsert': {'created_at': now},
        },
        upsert=True,
    )
    if not is_root:
        db.admins.update_one(
            {'username': username},
            {'$set': {'last_activity_at': now, 'last_device': device}},
        )
    state.sessions_list_cache['at'] = 0.0
    state.active_sessions_cache['at'] = 0.0
    sync_live_admin_payload()


def persist_logout_session(token: str) -> None:
    db = get_mongo_db()
    row = db.admin_sessions.find_one({'token': token}, {'username': 1, 'is_root': 1, 'device': 1, 'user_agent': 1})
    now = datetime.now(timezone.utc)
    db.admin_sessions.update_one({'token': token}, {'$set': {'is_active': False, 'last_seen_at': now}})
    if row and not bool(row.get('is_root')):
        device = row.get('device') or detect_device_from_user_agent(row.get('user_agent'))
        db.admins.update_one(
            {'username': row.get('username', '')},
            {'$set': {'last_activity_at': now, 'last_device': device}},
        )
    state.sessions_list_cache['at'] = 0.0
    state.active_sessions_cache['at'] = 0.0
    sync_live_admin_payload()


def get_session_by_token(token: str | None):
    if not token:
        return None

    cached = state.session_cache.get(token)
    if cached:
        cached['last_seen_at'] = datetime.now(timezone.utc)
        return cached

    db = get_mongo_db()
    row = db.admin_sessions.find_one({'token': token, 'is_active': True})
    if not row:
        return None

    session_data = {
        'token': row.get('token'),
        'username': row.get('username'),
        'is_root': bool(row.get('is_root')),
        'device': detect_device_from_user_agent(row.get('user_agent')),
        'last_seen_at': row.get('last_seen_at') or datetime.now(timezone.utc),
    }
    state.session_cache[token] = session_data
    return session_data


def active_non_root_sessions_count() -> int:
    now = time.time()
    if now - state.active_sessions_cache['at'] < ACTIVE_SESSIONS_CACHE_TTL_SECONDS:
        return state.active_sessions_cache['value']

    db = get_mongo_db()
    value = db.admin_sessions.count_documents(_active_filter())

    state.active_sessions_cache['value'] = value
    state.active_sessions_cache['at'] = now
    return value


def get_active_sessions_list() -> list[dict]:
    now = time.time()
    if now - state.sessions_list_cache['at'] < SESSIONS_LIST_CACHE_TTL_SECONDS:
        return state.sessions_list_cache['value']

    db = get_mongo_db()
    session_rows = list(
        db.admin_sessions.find(
            _active_filter(),
            {'token': 1, 'username': 1, 'is_root': 1, 'device': 1, 'user_agent': 1, 'last_seen_at': 1, 'created_at': 1},
        ).sort('created_at', -1)
    )
    admin_rows = list(
        db.admins.find(
            {},
            {'username': 1, 'is_suspended': 1, 'last_device': 1, 'last_activity_at': 1, 'created_at': 1},
        ).sort('created_at', -1)
    )

    admin_meta_by_username = {
        a.get('username', ''): {
            'password': '',
            'is_blocked': bool(a.get('is_suspended')),
            'last_device': a.get('last_device') or '-',
            'last_activity_at': a.get('last_activity_at'),
        }
        for a in admin_rows
    }

    sessions = []
    for r in session_rows:
        if bool(r.get('is_root')):
            continue
        meta = admin_meta_by_username.get(r.get('username', ''), {})
        sessions.append(
            {
                'token': r.get('token', ''),
                'username': r.get('username', ''),
                'is_root': bool(r.get('is_root')),
                'device': r.get('device') or detect_device_from_user_agent(r.get('user_agent')),
                'last_activity': arabic_relative_time(r.get('last_seen_at')),
                'can_terminate': True,
                'password': meta.get('password', '-'),
                'is_blocked': bool(meta.get('is_blocked', False)),
            }
        )

    active_usernames = {s['username'] for s in sessions}
    for a in admin_rows:
        username = a.get('username', '')
        if username in active_usernames:
            continue
        sessions.append(
            {
                'token': '',
                'username': username,
                'is_root': False,
                'device': admin_meta_by_username.get(username, {}).get('last_device', '-'),
                'last_activity': 'لم يتم تسجيل الدخول حتى الان',
                'can_terminate': False,
                'password': admin_meta_by_username.get(username, {}).get('password', '-'),
                'is_blocked': bool(admin_meta_by_username.get(username, {}).get('is_blocked', False)),
            }
        )
        last_activity_at = admin_meta_by_username.get(username, {}).get('last_activity_at')
        if last_activity_at:
            sessions[-1]['last_activity'] = arabic_relative_time(last_activity_at)

    state.sessions_list_cache['value'] = sessions
    state.sessions_list_cache['at'] = now
    return sessions


def touch_session_last_seen(token: str | None) -> None:
    if not token:
        return
    now = datetime.now(timezone.utc)
    cached = state.session_cache.get(token)
    if cached:
        cached['last_seen_at'] = now

    last_touch = state.session_touch_cache.get(token, 0.0)
    ts = time.time()
    if ts - last_touch < SESSION_TOUCH_INTERVAL_SECONDS:
        return
    state.session_touch_cache[token] = ts

    try:
        db = get_mongo_db()
        row = db.admin_sessions.find_one_and_update(
            {'token': token, 'is_active': True},
            {'$set': {'last_seen_at': now}},
            projection={'username': 1, 'is_root': 1, 'device': 1, 'user_agent': 1},
            return_document=False,
        )
        if row and not bool(row.get('is_root')):
            device = row.get('device') or detect_device_from_user_agent(row.get('user_agent'))
            db.admins.update_one(
                {'username': row.get('username', '')},
                {'$set': {'last_activity_at': now, 'last_device': device}},
            )
            sessions = state.live_admin_payload.get('sessions', [])
            if sessions:
                for item in sessions:
                    if item.get('username') == row.get('username'):
                        item['last_activity'] = 'الآن'
                        break
    except Exception:
        return


def invalidate_one_non_root_session(token: str) -> None:
    db = get_mongo_db()
    db.admin_sessions.update_one({'token': token, 'is_root': False}, {'$set': {'is_active': False}})

    state.session_cache.pop(token, None)
    state.active_sessions_cache['at'] = 0.0
    state.sessions_list_cache['at'] = 0.0
    sync_live_admin_payload()


def invalidate_all_non_root_sessions() -> None:
    db = get_mongo_db()
    db.admin_sessions.update_many({'is_root': False}, {'$set': {'is_active': False}})

    for k, v in list(state.session_cache.items()):
        if not v.get('is_root'):
            state.session_cache.pop(k, None)

    state.active_sessions_cache['at'] = 0.0
    state.sessions_list_cache['at'] = 0.0
    sync_live_admin_payload()


def invalidate_sessions_for_username(username: str) -> None:
    db = get_mongo_db()
    db.admin_sessions.update_many({'username': username, 'is_root': False}, {'$set': {'is_active': False}})

    for k, v in list(state.session_cache.items()):
        if v.get('username') == username and not v.get('is_root'):
            state.session_cache.pop(k, None)

    state.active_sessions_cache['at'] = 0.0
    state.sessions_list_cache['at'] = 0.0
    sync_live_admin_payload()
