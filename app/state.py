from fastapi import WebSocket

mongo_client = None
mongo_db = None
session_cache: dict[str, dict] = {}
session_touch_cache: dict[str, float] = {}
active_sessions_cache = {'value': 0, 'at': 0.0}
visits_count_cache = {'value': 0, 'at': 0.0}
sessions_list_cache = {'value': [], 'at': 0.0}
admin_ws_clients: set[WebSocket] = set()
admin_user_ws_clients: dict[str, set[WebSocket]] = {}
dashboard_ws_clients: set[WebSocket] = set()
visitor_ws_clients: dict[str, set[WebSocket]] = {}
blocked_attempts: dict[str, dict] = {}
live_admin_payload = {
    'ready': False,
    'active_sessions_count': 0,
    'sessions': [],
}
