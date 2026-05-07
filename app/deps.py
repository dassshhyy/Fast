from fastapi import Request

from .config import SESSION_COOKIE
from .services.admins import is_admin_blocked
from .services.sessions import get_session_by_token, touch_session_last_seen


def get_session(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    session = get_session_by_token(token)
    if session:
        username = session.get('username', '')
        if not session.get('is_root') and is_admin_blocked(username):
            request.state.blocked = True
            return None
        touch_session_last_seen(token)
    return session


def require_root_session(request: Request):
    session = get_session(request)
    if not session or not session.get('is_root'):
        return None
    return session
