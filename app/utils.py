import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

PBKDF2_ITERATIONS = 210_000


def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('ascii'),
        PBKDF2_ITERATIONS,
    ).hex()
    return f'pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest}'


def verify_password(password: str, stored_hash: str | None) -> bool:
    stored_hash = str(stored_hash or '')
    if not stored_hash:
        return False
    if stored_hash.startswith('pbkdf2_sha256$'):
        try:
            _, iterations_raw, salt, expected = stored_hash.split('$', 3)
            digest = hashlib.pbkdf2_hmac(
                'sha256',
                password.encode('utf-8'),
                salt.encode('ascii'),
                int(iterations_raw),
            ).hex()
            return hmac.compare_digest(digest, expected)
        except Exception:
            return False

    legacy_digest = hashlib.sha256(password.encode('utf-8')).hexdigest()
    return hmac.compare_digest(legacy_digest, stored_hash)


def detect_device_from_user_agent(user_agent: str | None) -> str:
    ua = (user_agent or '').lower()
    if not ua:
        return 'Unknown'
    if 'windows' in ua:
        return 'Windows'
    if 'cros' in ua or 'chromebook' in ua:
        return 'ChromeOS'
    if 'mac os' in ua or 'macintosh' in ua or 'macos' in ua:
        return 'MacOS'
    if 'iphone' in ua:
        return 'iPhone'
    if 'ipad' in ua:
        return 'iPad'
    if 'iphone' in ua or 'ipad' in ua or 'ios' in ua:
        return 'iOS'
    if 'android' in ua:
        if 'mobile' in ua:
            return 'Android Phone'
        if 'tablet' in ua:
            return 'Android Tablet'
        return 'Android'
    if 'linux' in ua and 'android' not in ua:
        return 'Linux'
    if 'darwin' in ua:
        return 'MacOS'
    if 'mozilla' in ua or 'safari' in ua or 'chrome' in ua or 'firefox' in ua:
        return 'Web Browser'
    if 'linux' in ua:
        return 'Linux'
    return 'Unknown'


def arabic_relative_time(value: datetime | None) -> str:
    if not value:
        return 'الآن'
    now = datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    diff = now - value
    if diff < timedelta(seconds=30):
        return 'الآن'
    if diff < timedelta(minutes=1):
        return 'قبل لحظات'
    minutes = int(diff.total_seconds() // 60)
    if minutes == 1:
        return 'قبل دقيقة واحدة'
    if minutes == 2:
        return 'قبل دقيقتين'
    if 3 <= minutes <= 10:
        return f'قبل {minutes} دقائق'
    if minutes < 60:
        return f'قبل {minutes} دقيقة'
    hours = minutes // 60
    if hours == 1:
        return 'قبل ساعة واحدة'
    if hours == 2:
        return 'قبل ساعتين'
    if 3 <= hours <= 10:
        return f'قبل {hours} ساعات'
    return f'قبل {hours} ساعة'
