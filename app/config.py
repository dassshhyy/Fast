import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


def load_dotenv_file() -> None:
    env_path = next((path for path in (BACKEND_DIR / '.env', REPO_ROOT / '.env') if path.exists()), None)
    if env_path is None:
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip())


load_dotenv_file()


def env_bool(name: str, default: bool = False) -> bool:
    raw = str(os.getenv(name, '')).strip().lower()
    if not raw:
        return default
    return raw in {'1', 'true', 'yes', 'on'}


def env_int(name: str, default: int) -> int:
    raw = str(os.getenv(name, '')).strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def env_csv(name: str, default: list[str] | None = None) -> list[str]:
    raw = str(os.getenv(name, '')).strip()
    if not raw:
        return list(default or [])
    items: list[str] = []
    for part in raw.split(','):
        value = part.strip()
        if value:
            items.append(value)
    return items


ADMIN_USERNAME = os.getenv('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'change-me')
ROOT_ADMIN_USERNAME = os.getenv('ROOT_ADMIN_USERNAME', ADMIN_USERNAME)
SESSION_COOKIE = os.getenv('SESSION_COOKIE', 'admin_session').strip() or 'admin_session'
SESSION_SECRET_KEY = os.getenv('SESSION_SECRET_KEY', '').strip()
SESSION_COOKIE_SECURE = env_bool('SESSION_COOKIE_SECURE', default=False)
SESSION_COOKIE_HTTPONLY = env_bool('SESSION_COOKIE_HTTPONLY', default=True)
SESSION_COOKIE_MAX_AGE_SECONDS = env_int('SESSION_COOKIE_MAX_AGE_SECONDS', 60 * 60 * 12)
SESSION_COOKIE_SAMESITE = os.getenv('SESSION_COOKIE_SAMESITE', 'lax').strip().lower() or 'lax'
if SESSION_COOKIE_SAMESITE not in {'lax', 'strict', 'none'}:
    SESSION_COOKIE_SAMESITE = 'lax'

JWT_SECRET_KEY = os.getenv('JWT_SECRET_KEY', '').strip()
JWT_ALGORITHM = os.getenv('JWT_ALGORITHM', 'HS256').strip() or 'HS256'
JWT_ACCESS_TOKEN_EXPIRES_MINUTES = env_int('JWT_ACCESS_TOKEN_EXPIRES_MINUTES', 15)
JWT_REFRESH_TOKEN_EXPIRES_DAYS = env_int('JWT_REFRESH_TOKEN_EXPIRES_DAYS', 7)

BIN_LOOKUP_ENABLED = env_bool('BIN_LOOKUP_ENABLED', default=False)

MONGODB_URL = os.getenv('MONGODB_URL', 'mongodb://127.0.0.1:27017')
MONGODB_DB_NAME = os.getenv('MONGODB_DB_NAME', 'general_dashboard')
MONGODB_SERVER_SELECTION_TIMEOUT_MS = env_int('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 5000)

DEFAULT_CORS_ALLOW_ORIGINS = [
    "*"
]
CORS_ALLOW_ORIGINS = env_csv('CORS_ALLOW_ORIGINS', default=DEFAULT_CORS_ALLOW_ORIGINS)
CORS_ALLOW_METHODS = env_csv('CORS_ALLOW_METHODS', default=['GET', 'POST', 'OPTIONS'])
CORS_ALLOW_HEADERS = env_csv('CORS_ALLOW_HEADERS', default=['*'])
CORS_ALLOW_CREDENTIALS = env_bool('CORS_ALLOW_CREDENTIALS', default=True)

# Comma-separated list of hosts. Empty disables TrustedHost middleware.
# Example: "localhost,127.0.0.1,example.com,*.example.com"
ALLOWED_HOSTS = env_csv('ALLOWED_HOSTS', default=[])
if '*' in ALLOWED_HOSTS:
    ALLOWED_HOSTS = ['*']

TEMPLATES_DIR = str(BACKEND_DIR / 'dashboard' / 'templates')
STATIC_DIR = str(BACKEND_DIR / 'dashboard' / 'static')
