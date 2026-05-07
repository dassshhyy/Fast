from starlette.datastructures import URL
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse


class StaticCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.method == 'POST' and (request.url.path.startswith('/admin/') or request.url.path == '/logout'):
            origin = request.headers.get('origin')
            referer = request.headers.get('referer')
            expected = f'{request.url.scheme}://{request.headers.get("host", "")}'
            if origin and origin != expected:
                return PlainTextResponse('forbidden', status_code=403)
            if not origin and referer:
                ref = URL(referer)
                if f'{ref.scheme}://{ref.netloc}' != expected:
                    return PlainTextResponse('forbidden', status_code=403)

        response = await call_next(request)
        if request.url.path.startswith('/static/'):
            if request.url.path == '/static/js/dashboard.js':
                response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
                response.headers['Pragma'] = 'no-cache'
                response.headers['Expires'] = '0'
            else:
                response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        elif 'Cache-Control' not in response.headers:
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
        return response
