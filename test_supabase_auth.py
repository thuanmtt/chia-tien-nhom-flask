#!/usr/bin/env python3
"""Unit test verify JWT Supabase (không cần mạng/DB): tự sinh cặp khóa ES256,
monkeypatch JWK client, ký token giả và kiểm tra đủ nhánh."""

import datetime
import sys

import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec

import supabase_auth


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJWKClient:
    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())
USER_ID = '11111111-2222-3333-4444-555555555555'


def _make_token(key=PRIVATE_KEY, aud='authenticated', sub=USER_ID, expired=False,
                email='test@example.com'):
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now - datetime.timedelta(hours=1) if expired else now + datetime.timedelta(hours=1)
    return pyjwt.encode(
        {'sub': sub, 'aud': aud, 'exp': exp, 'iat': now, 'email': email},
        key, algorithm='ES256',
    )


def main():
    supabase_auth._jwk_client_override = _FakeJWKClient(PRIVATE_KEY.public_key())

    assert supabase_auth.verify_access_token(_make_token()) == USER_ID
    print('✅ token hợp lệ → trả sub')

    assert supabase_auth.verify_access_token(_make_token(expired=True)) is None
    print('✅ token hết hạn → None')

    assert supabase_auth.verify_access_token(_make_token(aud='khac')) is None
    print('✅ sai audience → None')

    assert supabase_auth.verify_access_token(_make_token(key=OTHER_KEY)) is None
    print('✅ sai chữ ký (khóa khác) → None')

    assert supabase_auth.verify_access_token('không-phải-jwt') is None
    assert supabase_auth.verify_access_token('') is None
    assert supabase_auth.verify_access_token(None) is None
    print('✅ token rác/rỗng/None → None')

    claims = supabase_auth.verify_access_claims(_make_token())
    assert claims and claims['sub'] == USER_ID and claims['email'] == 'test@example.com'
    print('✅ verify_access_claims: token hợp lệ → dict claims (sub + email)')

    assert supabase_auth.verify_access_claims(_make_token(expired=True)) is None
    assert supabase_auth.verify_access_claims('rác') is None
    assert supabase_auth.verify_access_claims(None) is None
    print('✅ verify_access_claims: token hỏng → None')

    print('\n🎉 test_supabase_auth: tất cả pass')
    return 0


if __name__ == '__main__':
    sys.exit(main())
