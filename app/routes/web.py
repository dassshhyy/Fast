import asyncio
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .. import state
from ..config import (
    SESSION_COOKIE,
    SESSION_COOKIE_HTTPONLY,
    SESSION_COOKIE_MAX_AGE_SECONDS,
    SESSION_COOKIE_SAMESITE,
    SESSION_COOKIE_SECURE,
    TEMPLATES_DIR,
)
from ..deps import get_session
from ..page_meta import page_choices_for_dashboard
from ..realtime import broadcast_admin_update
from ..services.admins import is_admin_blocked, verify_admin_credentials
from ..services.sessions import (
    active_non_root_sessions_count,
    persist_login_session,
    persist_logout_session,
)
from ..services.visits import dashboard_row_for_visitor_uid, get_visits_total_count, list_visits
from ..services.visitors import get_blocked_visitor_uids
from ..utils import detect_device_from_user_agent

router = APIRouter()
templates = Jinja2Templates(directory=TEMPLATES_DIR)


async def apply_blocked_throttle(request: Request, username: str) -> None:
    ip = request.client.host if request.client else 'unknown'
    key = f'{username.lower()}::{ip}'
    rec = state.blocked_attempts.get(key, {'count': 0, 'until': 0.0})
    now = time.time()
    if rec['until'] > now:
        await asyncio.sleep(min(4.0, rec['until'] - now))
    rec['count'] += 1
    rec['until'] = time.time() + min(4.0, 0.8 * rec['count'])
    state.blocked_attempts[key] = rec


@router.get('/login')
async def login_page(request: Request):
    if get_session(request):
        return RedirectResponse(url='/', status_code=303)
    return templates.TemplateResponse(request=request, name='login.html', context={'error': None})


@router.post('/login')
async def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    if is_admin_blocked(username.strip()):
        await apply_blocked_throttle(request, username)
        return RedirectResponse(url='/blocked', status_code=303)

    auth = verify_admin_credentials(username, password)
    if not auth:
        return templates.TemplateResponse(
            request=request,
            name='login.html',
            context={'error': 'بيانات الدخول غير صحيحة'},
            status_code=401,
        )

    token = secrets.token_urlsafe(32)
    username = auth['username']
    is_root = bool(auth['is_root'])
    user_agent = request.headers.get('user-agent', '')

    persist_login_session(token, username, is_root, user_agent)
    state.session_cache[token] = {
        'token': token,
        'username': username,
        'is_root': is_root,
        'device': detect_device_from_user_agent(user_agent),
        'last_seen_at': datetime.now(timezone.utc),
    }
    state.active_sessions_cache['at'] = 0.0
    state.sessions_list_cache['at'] = 0.0

    response = RedirectResponse(url='/', status_code=303)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=SESSION_COOKIE_HTTPONLY,
        samesite=SESSION_COOKIE_SAMESITE,
        secure=SESSION_COOKIE_SECURE,
        max_age=SESSION_COOKIE_MAX_AGE_SECONDS,
    )
    asyncio.create_task(broadcast_admin_update())
    return response


@router.post('/logout')
async def logout(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        state.session_cache.pop(token, None)
        persist_logout_session(token)

    response = RedirectResponse(url='/login', status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    asyncio.create_task(broadcast_admin_update())
    return response


@router.get('/')
async def dashboard(request: Request):
    session = get_session(request)
    if not session:
        if getattr(request.state, 'blocked', False):
            return RedirectResponse(url='/blocked', status_code=303)
        return RedirectResponse(url='/login', status_code=303)

    sort_online_first = str(request.query_params.get('sort_online_first', '')).lower() in {'1', 'true', 'yes', 'on'}

    total_rows = get_visits_total_count()
    rows = list_visits(sort_online_first=sort_online_first)
    blocked_visitor_uids = get_blocked_visitor_uids([row['visitor_uid'] for row in rows if row.get('visitor_uid')])

    return templates.TemplateResponse(
        request=request,
        name='dashboard.html',
        context={
            'title': 'لوحة السجلات',
            'rows': rows,
            'total_rows': total_rows,
            'sort_online_first': sort_online_first,
            'active_sessions_count': active_non_root_sessions_count(),
            'is_root': bool(session.get('is_root')),
            'admin_username': session.get('username', ''),
            'blocked_visitor_uids': blocked_visitor_uids,
            'page_choices': page_choices_for_dashboard(),
        },
    )


@router.get('/partials/visit-row', response_class=HTMLResponse)
async def partial_visit_row(request: Request, visitor_uid: str):
    session = get_session(request)
    if not session:
        return HTMLResponse('', status_code=401)
    total_rows = get_visits_total_count()
    row = dashboard_row_for_visitor_uid(visitor_uid, display_id=total_rows)
    if not row:
        return HTMLResponse('', status_code=404)
    blocked_visitor_uids = get_blocked_visitor_uids([visitor_uid])
    html = templates.get_template('_visit_row.html').render(
        {
            'request': request,
            'row': row,
            'blocked_visitor_uids': blocked_visitor_uids,
            'page_choices': page_choices_for_dashboard(),
        }
    )
    return HTMLResponse(html)


@router.get('/blocked')
async def blocked_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name='blocked.html',
        context={'title': 'غير متاح حالياً'},
    )
