from datetime import datetime, timezone

import certifi
from pymongo import ASCENDING, DESCENDING, MongoClient

from . import state
from .config import MONGODB_DB_NAME, MONGODB_SERVER_SELECTION_TIMEOUT_MS, MONGODB_URL, ROOT_ADMIN_USERNAME


def get_mongo_db():
    if state.mongo_client is None:
        mongo_kwargs = {'serverSelectionTimeoutMS': MONGODB_SERVER_SELECTION_TIMEOUT_MS}
        if str(MONGODB_URL).startswith('mongodb+srv://') or 'ssl=true' in str(MONGODB_URL).lower() or 'tls=true' in str(MONGODB_URL).lower():
            mongo_kwargs['tlsCAFile'] = certifi.where()
        state.mongo_client = MongoClient(MONGODB_URL, **mongo_kwargs)
        state.mongo_db = state.mongo_client[MONGODB_DB_NAME]
    return state.mongo_db


def close_mongo_conn() -> None:
    if state.mongo_client is not None:
        state.mongo_client.close()
    state.mongo_client = None
    state.mongo_db = None


def drop_incompatible_index(collection, name: str, *, unique: bool | None = None, partial: dict | None = None) -> None:
    info = collection.index_information().get(name)
    if not info:
        return
    if unique is not None and bool(info.get('unique')) != unique:
        collection.drop_index(name)
        return
    if partial is not None and info.get('partialFilterExpression') != partial:
        collection.drop_index(name)


def init_mongo_db() -> None:
    db = get_mongo_db()
    db.command('ping')

    db.admin_sessions.create_index([('token', ASCENDING)], unique=True)
    db.admin_sessions.create_index([('is_active', ASCENDING), ('is_root', ASCENDING), ('created_at', DESCENDING)])
    db.admin_sessions.create_index([('username', ASCENDING)])

    db.admins.create_index([('username', ASCENDING)], unique=True)
    db.admins.create_index([('is_suspended', ASCENDING), ('created_at', DESCENDING)])
    db.admins.update_many({'plain_password': {'$exists': True}}, {'$unset': {'plain_password': ''}})

    drop_incompatible_index(db.visitor_profiles, 'visitor_uid_1', unique=True)
    db.visitor_profiles.create_index([('visitor_uid', ASCENDING)], unique=True)
    db.visitor_profiles.create_index([('is_blocked', ASCENDING), ('visitor_uid', ASCENDING)])
    db.visitor_profiles.create_index([('last_visit_at', DESCENDING)])

    for row in db.visits.find({'$or': [{'visitor_uid': ''}, {'visitor_uid': {'$exists': False}}]}, {'_id': 1, 'id': 1}):
        suffix = row.get('id') or str(row['_id'])
        db.visits.update_one({'_id': row['_id']}, {'$set': {'visitor_uid': f'server_anon_{suffix}'}})

    # Keep one dashboard row per visitor before enforcing uniqueness.
    duplicate_visitors = db.visits.aggregate(
        [
            {'$match': {'visitor_uid': {'$type': 'string'}}},
            {'$sort': {'id': -1}},
            {'$group': {'_id': '$visitor_uid', 'keep': {'$first': '$_id'}, 'all': {'$push': '$_id'}, 'count': {'$sum': 1}}},
            {'$match': {'count': {'$gt': 1}}},
        ]
    )
    for group in duplicate_visitors:
        remove_ids = [row_id for row_id in group['all'] if row_id != group['keep']]
        if remove_ids:
            db.visits.delete_many({'_id': {'$in': remove_ids}})

    db.info_events.delete_many({'$or': [{'visitor_uid': ''}, {'visitor_uid': {'$exists': False}}]})
    for row in db.info_events.find(
        {},
        {
            '_id': 1,
            'visitor_uid': 1,
            'type': 1,
            'ts': 1,
            'request_type': 1,
            'watch_id': 1,
            'category': 1,
            'selection_signature': 1,
        },
    ):
        row_type = row.get('type', '') or ''
        base_parts = [
            row.get('visitor_uid', '') or '',
            row.get('type', '') or '',
            row.get('request_type', '') or '',
            row.get('watch_id', '') or '',
            row.get('category', '') or '',
        ]
        if row_type in {'registration', 'login'}:
            base_parts.append(row.get('ts', '') or '')
        signature = row.get('selection_signature') or '|'.join(base_parts)
        db.info_events.update_one({'_id': row['_id']}, {'$set': {'selection_signature': signature}})

    duplicate_events = db.info_events.aggregate(
        [
            {'$sort': {'ts': -1}},
            {'$group': {'_id': {'visitor_uid': '$visitor_uid', 'selection_signature': '$selection_signature'}, 'keep': {'$first': '$_id'}, 'all': {'$push': '$_id'}, 'count': {'$sum': 1}}},
            {'$match': {'count': {'$gt': 1}}},
        ]
    )
    for group in duplicate_events:
        remove_ids = [row_id for row_id in group['all'] if row_id != group['keep']]
        if remove_ids:
            db.info_events.delete_many({'_id': {'$in': remove_ids}})

    drop_incompatible_index(db.visits, 'id_-1', unique=True)
    drop_incompatible_index(db.visits, 'visitor_uid_1', unique=True)
    drop_incompatible_index(db.info_events, 'visitor_uid_1_selection_signature_1', unique=True)

    db.visits.create_index([('id', DESCENDING)], unique=True)
    db.visits.create_index([('visitor_uid', ASCENDING)], unique=True)
    db.visits.create_index([('created_at', DESCENDING)])

    db.registration_submissions.create_index([('visitor_uid', ASCENDING), ('created_at', DESCENDING)])
    db.registration_submissions.create_index([('visitor_uid', ASCENDING), ('form_type', ASCENDING), ('created_at', DESCENDING)])
    db.registration_submissions.create_index([('status', ASCENDING), ('created_at', DESCENDING)])
    db.registration_submissions.create_index(
        [('submission_id', ASCENDING)],
        unique=True,
        partialFilterExpression={'submission_id': {'$exists': True, '$type': 'string'}},
    )

    db.info_events.create_index([('ts', DESCENDING)])
    db.info_events.create_index([('submission_id', ASCENDING)])
    db.info_events.create_index([('visitor_uid', ASCENDING), ('type', ASCENDING), ('ts', DESCENDING)])
    db.info_events.create_index([('visitor_uid', ASCENDING), ('selection_signature', ASCENDING)], unique=True)

    now = datetime.now(timezone.utc)
    db.settings.update_one(
        {'_id': 'bootstrapped'},
        {
            '$setOnInsert': {
                'root_admin_username': ROOT_ADMIN_USERNAME,
                'created_at': now,
            }
        },
        upsert=True,
    )
