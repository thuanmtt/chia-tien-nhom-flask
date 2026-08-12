"""Xác thực access token của Supabase Auth ở phía Flask.

Verify offline bằng khóa công khai từ JWKS endpoint của project
(https://<project>.supabase.co/auth/v1/.well-known/jwks.json) — không gọi
Supabase mỗi request. Yêu cầu project dùng khóa ký bất đối xứng (project mới
mặc định ES256; project cũ HS256 phải bật "JWT signing keys" trong dashboard).
"""

import os

import jwt as pyjwt
from jwt import PyJWKClient

# Cache JWK client theo process (PyJWKClient tự cache key theo kid).
_jwk_client = None
# Cho unit test thay client giả — production luôn để None.
_jwk_client_override = None


def _get_jwk_client():
    global _jwk_client
    if _jwk_client_override is not None:
        return _jwk_client_override
    if _jwk_client is None:
        base = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
        if not base:
            return None
        _jwk_client = PyJWKClient(
            f'{base}/auth/v1/.well-known/jwks.json',
            cache_keys=True,
            lifespan=3600,
            timeout=5,  # tránh treo request khi cold-start trên Vercel serverless
        )
    return _jwk_client


def verify_access_claims(token):
    """Trả về dict claims đã verify nếu token hợp lệ, ngược lại None.

    Không raise — token thiếu/hết hạn/sai chữ ký/sai audience đều coi như
    chưa đăng nhập (caller quyết định 401 hay đi tiếp ẩn danh)."""
    if not token:
        return None
    client = _get_jwk_client()
    if client is None:
        return None
    try:
        signing_key = client.get_signing_key_from_jwt(token)
        return pyjwt.decode(
            token,
            signing_key.key,
            algorithms=['ES256', 'RS256'],
            audience='authenticated',
        )
    except Exception:
        return None


def verify_access_token(token):
    """Trả về user id (claim sub) nếu token hợp lệ, ngược lại None."""
    claims = verify_access_claims(token)
    return (claims.get('sub') or None) if claims else None


def request_user_claims(request):
    """Claims đã verify từ header Authorization của request Flask (None nếu không có)."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    return verify_access_claims(auth[len('Bearer '):].strip())


def request_user_id(request):
    """Lấy user id từ header Authorization của request Flask (None nếu không có)."""
    claims = request_user_claims(request)
    return (claims.get('sub') or None) if claims else None
