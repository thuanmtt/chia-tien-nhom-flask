#!/usr/bin/env python3
"""
Test script cho Flask app
"""

import os
import secrets
import sys

import requests

# Nạp .env ở repo root (nếu có) để khỏi phải export tay khi chạy local
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
except ImportError:
    pass

# vercel_app.py chạy local ở port 5002; override bằng env khi cần
BASE_URL = os.environ.get('BASE_URL', 'http://localhost:5002')

# Env cho test auth (bắt buộc từ khi POST /api/events yêu cầu đăng nhập)
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_ANON_KEY = os.environ.get('SUPABASE_ANON_KEY', '')
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')

import psycopg2


def _db_execute(sql, params):
    """Thao tác DB trực tiếp — chỉ dùng để dựng dữ liệu test (vd event không chủ)."""
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(sql, params)
    cur.close()
    conn.close()


def create_test_user():
    """Tạo user test qua Admin API (service_role — CHỈ dùng trong test) và
    đăng nhập lấy access token thật. Trả về (user_id, access_token, email)."""
    email = f'test-{secrets.token_hex(6)}@example.com'
    password = secrets.token_urlsafe(16)
    r = requests.post(
        f'{SUPABASE_URL}/auth/v1/admin/users',
        headers={'apikey': SUPABASE_SERVICE_ROLE_KEY,
                 'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}'},
        json={'email': email, 'password': password, 'email_confirm': True},
    )
    assert r.status_code in (200, 201), f'Không tạo được user test: {r.status_code} {r.text}'
    user_id = r.json()['id']
    r = requests.post(
        f'{SUPABASE_URL}/auth/v1/token?grant_type=password',
        headers={'apikey': SUPABASE_ANON_KEY},
        json={'email': email, 'password': password},
    )
    assert r.status_code == 200, f'Không đăng nhập được user test: {r.status_code} {r.text}'
    return user_id, r.json()['access_token'], email


def delete_test_user(user_id):
    requests.delete(
        f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
        headers={'apikey': SUPABASE_SERVICE_ROLE_KEY,
                 'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}'},
    )


def test_banks_api():
    """Test API lấy danh sách ngân hàng"""
    print("Testing banks API...")
    response = requests.get(f"{BASE_URL}/api/banks")
    if response.status_code == 200:
        data = response.json()
        print(f"✅ Banks API OK - Found {len(data.get('data', []))} banks")
        return True
    else:
        print(f"❌ Banks API failed - Status: {response.status_code}")
        return False

def test_create_event(token):
    """Test tạo sự kiện mới — response KHÔNG được chứa edit_key (đã bỏ cơ chế key)"""
    print("Testing create event API...")
    event_data = {
        "title": "Test Event",
        "members": ["Anh A", "Chị B", "Em C"],
        "expenses": [
            {
                "title": "Tiền ăn",
                "amount": 300000,
                "payer": "Anh A",
                "benefitType": "all",
                "beneficiaries": ["Anh A", "Chị B", "Em C"]
            }
        ],
        "bankInfo": {
            "Anh A": {"bank": "VCB", "account": "1234567890"},
            "Chị B": {"bank": "MB", "account": "0987654321"}
        }
    }

    response = requests.post(
        f"{BASE_URL}/api/events",
        json=event_data,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    )

    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            if 'edit_key' in data:
                print("❌ Create event vẫn trả edit_key — cơ chế key phải bị bỏ")
                return None
            event_code = data.get('event_code')
            print(f"✅ Create event OK - Event code: {event_code}")
            return event_code
        print(f"❌ Create event failed - {data.get('error')}")
        return None
    print(f"❌ Create event failed - Status: {response.status_code}")
    return None

def test_get_event(event_code, token):
    """Test lấy thông tin sự kiện + cờ can_edit (header X-Edit-Key phải bị bỏ qua)"""
    print(f"Testing get event API for {event_code}...")

    # Người lạ (kể cả gửi kèm header key cũ) → can_edit=False, không lộ edit_key
    for headers, label in (({}, 'ẩn danh'), ({'X-Edit-Key': 'key-cu-nao-do'}, 'kèm header key cũ')):
        response = requests.get(f"{BASE_URL}/api/events/{event_code}", headers=headers)
        if response.status_code != 200:
            print(f"❌ Get event failed - Status: {response.status_code}")
            return False
        event = response.json().get('event') or {}
        if 'edit_key' in event:
            print("❌ Get event leaked edit_key!")
            return False
        if event.get('can_edit') is not False:
            print(f"❌ can_edit phải là False khi {label}, nhận: {event.get('can_edit')}")
            return False
        if event.get('login_required_to_edit') is not False:
            print(f"❌ login_required_to_edit phải False với người lạ ({label})")
            return False
    print("✅ Người lạ: can_edit=False, header X-Edit-Key bị bỏ qua")

    # Owner đăng nhập → can_edit=True
    response = requests.get(f"{BASE_URL}/api/events/{event_code}",
                            headers={'Authorization': f'Bearer {token}'})
    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            event = data.get('event')
            if event.get('can_edit') is not True:
                print(f"❌ can_edit phải là True với owner JWT, nhận: {event.get('can_edit')}")
                return False
            print(f"✅ Get event OK - Title: {event.get('title')} (can_edit=True với owner)")
            return True
        print(f"❌ Get event failed - {data.get('error')}")
        return False
    print(f"❌ Get event failed - Status: {response.status_code}")
    return False

def test_lookup_events(event_code):
    """Test API batch lookup cho danh sách 'Sự Kiện Của Tôi'"""
    print("Testing lookup events API...")

    response = requests.post(
        f"{BASE_URL}/api/events/lookup",
        json={"codes": [event_code, "KHONG-TON-TAI"]},
    )
    if response.status_code != 200:
        print(f"❌ Lookup failed - Status: {response.status_code}")
        return False
    events = response.json().get('events') or []
    codes = [e.get('event_code') for e in events]
    if codes != [event_code]:
        print(f"❌ Lookup phải trả đúng 1 sự kiện tồn tại, nhận: {codes}")
        return False
    if any('edit_key' in e or 'bank_info' in e or 'bankInfo' in e for e in events):
        print("❌ Lookup leaked edit_key/bank_info!")
        return False

    # codes không hợp lệ phải bị 400
    for bad in ({"codes": "abc"}, {"codes": [123]}, {}):
        r = requests.post(f"{BASE_URL}/api/events/lookup", json=bad)
        if r.status_code != 400:
            print(f"❌ Lookup với payload {bad} phải trả 400, nhận {r.status_code}")
            return False

    print("✅ Lookup events OK (batch + validate + không lộ dữ liệu nhạy cảm)")
    return True

def test_update_event(event_code, token):
    """Test cập nhật sự kiện — quyền theo owner JWT, user khác bị 403"""
    print(f"Testing update event API for {event_code}...")
    user2_id, token2, _email2 = create_test_user()
    try:
        return _test_update_event_body(event_code, token, token2)
    finally:
        delete_test_user(user2_id)

def _test_update_event_body(event_code, token, token2):
    event_data = {
        "title": "Updated Test Event",
        "members": ["Anh A", "Chị B", "Em C", "Anh D"],
        "expenses": [
            {
                "title": "Tiền ăn",
                "amount": 400000,
                "payer": "Anh A",
                "benefitType": "all",
                "beneficiaries": ["Anh A", "Chị B", "Em C", "Anh D"]
            }
        ],
        "bankInfo": {
            "Anh A": {"bank": "VCB", "account": "1234567890"},
            "Chị B": {"bank": "MB", "account": "0987654321"},
            "Em C": {"bank": "ACB", "account": "1122334455"}
        }
    }

    # Không token → 401 (mọi thao tác ghi cần đăng nhập)
    r = requests.put(f"{BASE_URL}/api/events/{event_code}", json=event_data)
    if r.status_code != 401:
        print(f"❌ PUT không đăng nhập phải 401, nhận {r.status_code}")
        return False
    print("✅ PUT chưa đăng nhập → 401")

    # User khác (không phải owner, không được mời, event mặc định link+viewer) → 403
    response = requests.put(
        f"{BASE_URL}/api/events/{event_code}",
        json=event_data,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token2}'}
    )
    if response.status_code != 403:
        print(f"❌ PUT bởi user không có quyền phải 403, nhận {response.status_code}")
        return False
    print("✅ PUT bởi user không có quyền → 403")

    response = requests.put(
        f"{BASE_URL}/api/events/{event_code}",
        json=event_data,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    )

    if response.status_code != 200 or not response.json().get('success'):
        print(f"❌ Update event failed - Status: {response.status_code}")
        return False
    if not response.json().get('updated_at'):
        print("❌ Update response thiếu updated_at")
        return False
    print("✅ Update event OK")

    # Optimistic locking: expectedUpdatedAt cũ phải bị từ chối 409
    stale = dict(event_data)
    stale['expectedUpdatedAt'] = '1999-01-01T00:00:00'
    r = requests.put(
        f"{BASE_URL}/api/events/{event_code}",
        json=stale,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    )
    if r.status_code != 409:
        print(f"❌ PUT với expectedUpdatedAt cũ phải trả 409, nhận {r.status_code}")
        return False
    print("✅ Optimistic locking: 409 khi expectedUpdatedAt đã cũ")

    fresh = dict(event_data)
    fresh['expectedUpdatedAt'] = response.json()['updated_at']
    r = requests.put(
        f"{BASE_URL}/api/events/{event_code}",
        json=fresh,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    )
    if r.status_code != 200:
        print(f"❌ PUT với expectedUpdatedAt hiện tại phải 200, nhận {r.status_code}")
        return False
    print("✅ Optimistic locking: 200 khi expectedUpdatedAt khớp")
    return True

def test_delete_event(event_code, token):
    """Test xóa sự kiện — chỉ owner (không còn edit key)"""
    print(f"Testing delete event API for {event_code}...")

    response = requests.delete(f"{BASE_URL}/api/events/{event_code}")
    if response.status_code != 401:
        print(f"❌ Delete without token should be 401, got {response.status_code}")
        return False
    print("✅ Delete without token correctly rejected (401)")

    response = requests.delete(
        f"{BASE_URL}/api/events/{event_code}",
        headers={'Authorization': f'Bearer {token}'}
    )

    if response.status_code == 200 and response.json().get('success'):
        print("✅ Delete event OK")
        return True
    print(f"❌ Delete event failed - Status: {response.status_code}")
    return False

def test_roundtrip_document(event_code, token):
    """PUT document đầy đủ (đa tiền tệ, couples, rates) rồi GET so từng trường —
    bất biến quan trọng nhất của schema quan hệ: không mất/không méo dữ liệu."""
    print("Testing document round-trip...")
    doc = {
        "title": "Round Trip Đà Lạt",
        "members": ["An", "Bình", "Chi"],
        "expenses": [
            {"title": "Khách sạn", "amount": 1500000, "currency": "VND",
             "payer": "An", "benefitType": "all", "beneficiaries": [],
             "expense_date": "2026-08-01", "created_time": "2026-08-01T10:00:00",
             "updated_time": "2026-08-01T10:00:00"},
            {"title": "Ăn tối", "amount": 45.5, "currency": "USD",
             "payer": "Bình", "benefitType": "selected",
             "beneficiaries": ["An", "Chi"],
             "expense_date": "2026-08-02", "created_time": "", "updated_time": ""},
        ],
        "bankInfo": {"An": {"bank": "VCB", "account": "123456"}},
        "couples": [{"id": "c1", "label": "Vợ chồng An",
                     "members": ["An", "Bình"], "primary": "An"}],
        "rates": {"USD": {"rate": 25000, "source": "test", "rateDate": "2026-08-01",
                          "rateType": "mid", "currencyName": "US Dollar"}},
    }
    r = requests.get(f"{BASE_URL}/api/events/{event_code}")
    doc_put = dict(doc)
    doc_put["expectedUpdatedAt"] = r.json()["event"]["updated_at"]
    r = requests.put(f"{BASE_URL}/api/events/{event_code}", json=doc_put,
                     headers={'Authorization': f'Bearer {token}'})
    if r.status_code != 200:
        print(f"❌ Round-trip PUT failed - Status: {r.status_code} {r.text}")
        return False
    r = requests.get(f"{BASE_URL}/api/events/{event_code}")
    got = r.json()["event"]
    for key in ("title", "members", "expenses", "bankInfo", "couples", "rates"):
        if got[key] != doc[key]:
            print(f"❌ Round-trip lệch ở '{key}':\n  gửi:  {doc[key]}\n  nhận: {got[key]}")
            return False
    print("✅ Round-trip OK - document giữ nguyên qua PUT/GET")
    return True

def test_auth_matrix(token):
    """Ma trận quyền: 401 vs 403, owner JWT vs chế độ chia sẻ (không còn edit key)."""
    print("Testing auth matrix...")
    user2_id, token2, _email2 = create_test_user()
    try:
        payload = {"title": "Auth Matrix", "members": ["An"], "expenses": []}

        # 1. POST không token / token rác → 401
        r = requests.post(f"{BASE_URL}/api/events", json=payload)
        assert r.status_code == 401, f'POST không token phải 401, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events", json=payload,
                          headers={'Authorization': 'Bearer khong-phai-jwt'})
        assert r.status_code == 401, f'POST token rác phải 401, được {r.status_code}'
        print("  ✅ POST không/sai token → 401")

        # 2. POST có token → tạo được, KHÔNG trả edit_key
        r = requests.post(f"{BASE_URL}/api/events", json=payload,
                          headers={'Authorization': f'Bearer {token}'})
        assert r.status_code == 200 and r.json().get('success'), r.text
        assert 'edit_key' not in r.json(), 'POST không được trả edit_key nữa'
        code = r.json()['event_code']
        updated_at = r.json()['updated_at']
        print(f"  ✅ POST có token → tạo được, không có edit_key ({code})")

        # 3. GET công khai: không lộ edit_key, can_edit=false; owner JWT: can_edit=true
        r = requests.get(f"{BASE_URL}/api/events/{code}")
        ev = r.json()['event']
        assert 'edit_key' not in ev, 'GET không được trả edit_key'
        assert ev['can_edit'] is False, 'người lạ không có can_edit'
        r = requests.get(f"{BASE_URL}/api/events/{code}",
                         headers={'Authorization': f'Bearer {token}'})
        assert r.json()['event']['can_edit'] is True, 'owner phải có can_edit'
        print("  ✅ GET: không lộ edit_key; can_edit đúng theo vai")

        # 4. PUT bằng owner JWT → 200
        put_doc = dict(payload)
        put_doc['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                         headers={'Authorization': f'Bearer {token}'})
        assert r.status_code == 200, f'owner PUT phải 200, được {r.status_code}'
        updated_at = r.json()['updated_at']
        print("  ✅ PUT bằng owner JWT → 200")

        # 5. PUT bằng user khác (mặc định link+viewer) → 403; kèm header key cũ
        #    cũng vẫn 403 — header X-Edit-Key phải hoàn toàn bị bỏ qua
        put_doc['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                         headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 403, f'PUT user khác phải 403, được {r.status_code}'
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                         headers={'X-Edit-Key': 'key-bat-ky', 'Authorization': f'Bearer {token2}'})
        assert r.status_code == 403, f'PUT kèm X-Edit-Key phải vẫn 403, được {r.status_code}'
        print("  ✅ PUT user khác → 403 (header X-Edit-Key bị bỏ qua)")

        # 6. Owner bật "ai có link đều chỉnh sửa" → user khác PUT được, nhưng KHÔNG xóa được
        r = requests.put(f"{BASE_URL}/api/events/{code}/sharing",
                         json={'access': 'link', 'role': 'editor'},
                         headers={'Authorization': f'Bearer {token}'})
        assert r.status_code == 200, f'owner đổi sharing phải 200, được {r.status_code}'
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                         headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 200, f'link-editor PUT phải 200, được {r.status_code}'
        r = requests.delete(f"{BASE_URL}/api/events/{code}",
                            headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 403, f'link-editor DELETE phải 403, được {r.status_code}'
        print("  ✅ link-editor: PUT 200, DELETE 403")

        # 7. my-events: có event vừa tạo; không token → 401
        r = requests.get(f"{BASE_URL}/api/my-events",
                         headers={'Authorization': f'Bearer {token}'})
        codes = [e['event_code'] for e in r.json()['events']]
        assert code in codes, 'my-events phải chứa event vừa tạo'
        r = requests.get(f"{BASE_URL}/api/my-events")
        assert r.status_code == 401
        print("  ✅ /api/my-events đúng theo vai")

        # 8. Dọn: owner xóa được
        r = requests.delete(f"{BASE_URL}/api/events/{code}",
                            headers={'Authorization': f'Bearer {token}'})
        assert r.status_code == 200, f'owner DELETE phải 200, được {r.status_code}'
        print("✅ Auth matrix OK")
        return True
    finally:
        delete_test_user(user2_id)

def test_ownerless_event(token):
    """Event không chủ (legacy/migrate): ai đăng nhập cũng sửa/xóa được;
    ẩn danh xem được + được mời đăng nhập; không đặt được chế độ hạn chế."""
    print("Testing ownerless (legacy) event...")
    user2_id, token2, _email2 = create_test_user()
    payload = {"title": "Event không chủ", "members": ["An"], "expenses": []}
    r = requests.post(f"{BASE_URL}/api/events", json=payload,
                      headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200, r.text
    code = r.json()['event_code']
    try:
        # Mô phỏng event legacy: gỡ owner trực tiếp trong DB
        _db_execute('UPDATE events SET owner_id = NULL WHERE event_code = %s', (code,))

        # Ẩn danh: xem được, có quyền nhưng thiếu đăng nhập → login_required_to_edit
        r = requests.get(f"{BASE_URL}/api/events/{code}")
        ev = r.json()['event']
        assert r.status_code == 200 and ev['can_edit'] is False, 'ẩn danh không có can_edit'
        assert ev['login_required_to_edit'] is True, 'event không chủ phải mời đăng nhập để sửa'

        # Ownerless + restricted: vẫn xem được (carve-out owner_id IS NULL)
        # và lookup phải thấy (khớp quyền GET, không bị ẩn oan)
        _db_execute("UPDATE events SET share_access = 'restricted' WHERE event_code = %s", (code,))
        r = requests.get(f"{BASE_URL}/api/events/{code}")
        assert r.status_code == 200, \
            f'ownerless restricted vẫn phải xem được ẩn danh, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/lookup", json={'codes': [code]})
        assert code in [e['event_code'] for e in r.json()['events']], \
            'lookup phải thấy event ownerless dù đang restricted'
        _db_execute("UPDATE events SET share_access = 'link' WHERE event_code = %s", (code,))
        print("  ✅ Ownerless + restricted: vẫn xem được và lookup không ẩn")

        # User bất kỳ đã đăng nhập: sửa được
        put_doc = dict(payload, title='Đã sửa bởi user khác')
        put_doc['expectedUpdatedAt'] = ev['updated_at']
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                         headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 200, f'PUT event không chủ phải 200, được {r.status_code}: {r.text}'

        # Không đặt được 'restricted' cho event không chủ (sẽ không ai xem được)
        r = requests.put(f"{BASE_URL}/api/events/{code}/sharing",
                         json={'access': 'restricted', 'role': 'viewer'},
                         headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 400, f'restricted cho event không chủ phải 400, được {r.status_code}'

        # User bất kỳ đã đăng nhập: xóa được
        r = requests.delete(f"{BASE_URL}/api/events/{code}",
                            headers={'Authorization': f'Bearer {token2}'})
        assert r.status_code == 200, f'DELETE event không chủ phải 200, được {r.status_code}'
        code = None
        print("✅ Event không chủ: sửa/xóa được khi đăng nhập, chặn restricted")
        return True
    finally:
        if code:
            requests.delete(f"{BASE_URL}/api/events/{code}",
                            headers={'Authorization': f'Bearer {token}'})
        delete_test_user(user2_id)

def test_saved_events(token):
    """saved_events: lưu/gỡ event vào danh sách tài khoản + my-events hợp nhất với cờ owned."""
    print("Testing saved events (Sự Kiện Của Tôi theo tài khoản)...")
    user2_id, token2, _email2 = create_test_user()
    auth1 = {'Authorization': f'Bearer {token}'}
    auth2 = {'Authorization': f'Bearer {token2}'}
    payload = {"title": "Event để lưu", "members": ["An"], "expenses": []}
    r = requests.post(f"{BASE_URL}/api/events", json=payload, headers=auth1)
    assert r.status_code == 200, r.text
    code = r.json()['event_code']
    code2 = None
    try:
        # is_saved ban đầu: chưa ai lưu
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is False, 'chưa lưu → is_saved phải False'

        # Chưa đăng nhập → 401
        assert requests.get(f"{BASE_URL}/api/my-events").status_code == 401
        assert requests.post(f"{BASE_URL}/api/my-events/save",
                             json={'codes': [code]}).status_code == 401
        assert requests.delete(f"{BASE_URL}/api/my-events/{code}").status_code == 401
        print("  ✅ Cả 3 endpoint chặn 401 khi chưa đăng nhập")

        # Body sai → 400 (mã không tồn tại thì bỏ qua, không lỗi)
        for bad in ({'codes': 'abc'}, {'codes': [123]}, {}, {'codes': ['x' * 65]}):
            r = requests.post(f"{BASE_URL}/api/my-events/save", json=bad, headers=auth2)
            assert r.status_code == 400, f'save với {bad} phải 400, được {r.status_code}'
        print("  ✅ Validate body save")

        # user2 lưu event của user1 (kèm 1 mã không tồn tại — bị bỏ qua êm)
        r = requests.post(f"{BASE_URL}/api/my-events/save",
                          json={'codes': [code, 'KHONG-TON-TAI']}, headers=auth2)
        assert r.status_code == 200 and r.json().get('success'), r.text
        # Lưu lần 2 phải idempotent
        r = requests.post(f"{BASE_URL}/api/my-events/save",
                          json={'codes': [code]}, headers=auth2)
        assert r.status_code == 200, 'save lần 2 phải idempotent'

        # Cờ is_saved trong GET event phản ánh trạng thái theo dõi của từng user
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is True, 'user2 đã lưu → is_saved=True'
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth1)
        assert r.json()['event']['is_saved'] is False, 'owner chưa lưu → is_saved=False'
        r = requests.get(f"{BASE_URL}/api/events/{code}")
        assert r.json()['event']['is_saved'] is False, 'ẩn danh → is_saved=False'
        print("  ✅ GET event trả is_saved đúng theo user")

        # Batch trộn mã đã lưu + mã mới: mã đã lưu không được "ăn" mất suất
        # LIMIT của mã mới trong cùng batch
        payload2 = {"title": "Event thứ hai", "members": ["Bình"], "expenses": []}
        r = requests.post(f"{BASE_URL}/api/events", json=payload2, headers=auth1)
        assert r.status_code == 200, r.text
        code2 = r.json()['event_code']
        r = requests.post(f"{BASE_URL}/api/my-events/save",
                          json={'codes': [code, code2]}, headers=auth2)
        assert r.status_code == 200, r.text
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth2)
        events2 = {e['event_code']: e for e in r.json()['events']}
        assert code in events2 and code2 in events2, \
            'batch trộn mã đã lưu + mã mới phải lưu được cả hai'
        assert events2[code]['owned'] is False and events2[code2]['owned'] is False
        print("  ✅ Batch trộn mã đã lưu + mã mới: cả hai đều được lưu")

        # codes rỗng → 200, không lỗi
        r = requests.post(f"{BASE_URL}/api/my-events/save", json={'codes': []}, headers=auth2)
        assert r.status_code == 200 and r.json().get('success')
        print("  ✅ codes rỗng → 200")

        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth2)
        events = {e['event_code']: e for e in r.json()['events']}
        assert code in events, 'my-events của user2 phải chứa event đã lưu'
        assert events[code]['owned'] is False, 'event lưu hộ không phải owned'
        assert 'KHONG-TON-TAI' not in events
        print("  ✅ Lưu event + my-events trả owned=False cho event không sở hữu")

        # my-events của owner: owned=True (không cần lưu tay)
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth1)
        events = {e['event_code']: e for e in r.json()['events']}
        assert code in events and events[code]['owned'] is True, 'owner phải thấy owned=True'
        print("  ✅ my-events của owner có owned=True")

        # Gỡ khỏi danh sách: mất khỏi my-events của user2, event vẫn còn
        r = requests.delete(f"{BASE_URL}/api/my-events/{code}", headers=auth2)
        assert r.status_code == 200 and r.json().get('success')
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth2)
        assert code not in [e['event_code'] for e in r.json()['events']]
        assert requests.get(f"{BASE_URL}/api/events/{code}").status_code == 200, \
            'unsave không được xóa event'
        # Gỡ lần nữa vẫn 200 (idempotent)
        assert requests.delete(f"{BASE_URL}/api/my-events/{code}",
                               headers=auth2).status_code == 200
        print("  ✅ Gỡ khỏi danh sách không đụng event, idempotent")

        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is False, 'đã gỡ → is_saved phải False'

        # Bookmark không mang quyền: event restricted đã lưu (saved_events)
        # không được lộ metadata cho người ngoài qua my-events
        r = requests.post(f"{BASE_URL}/api/my-events/save", json={'codes': [code]}, headers=auth2)
        assert r.status_code == 200, r.text
        r = requests.put(f"{BASE_URL}/api/events/{code}/sharing",
                         json={'access': 'restricted', 'role': 'viewer'}, headers=auth1)
        assert r.status_code == 200, r.text
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth2)
        assert code not in [e['event_code'] for e in r.json()['events']], \
            'event restricted đã lưu (bookmark) không được lộ metadata cho người ngoài'
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth1)
        events1 = {e['event_code']: e for e in r.json()['events']}
        assert code in events1 and events1[code]['owned'] is True, \
            'owner vẫn phải thấy event của mình dù đang restricted'
        r = requests.put(f"{BASE_URL}/api/events/{code}/sharing",
                         json={'access': 'link', 'role': 'viewer'}, headers=auth1)
        assert r.status_code == 200, r.text
        print("  ✅ Bookmark event restricted không lộ metadata qua my-events")

        # Xóa event → dòng saved_events mất theo (CASCADE): lưu lại rồi xóa event
        requests.post(f"{BASE_URL}/api/my-events/save", json={'codes': [code]}, headers=auth2)
        r = requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth1)
        assert r.status_code == 200
        r = requests.get(f"{BASE_URL}/api/my-events", headers=auth2)
        assert code not in [e['event_code'] for e in r.json()['events']], \
            'event đã xóa không được còn trong danh sách đã lưu'
        code = None
        print("✅ Saved events OK")
        return True
    finally:
        if code:
            requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth1)
        if code2:
            requests.delete(f"{BASE_URL}/api/events/{code2}", headers=auth1)
        delete_test_user(user2_id)

def test_revisions_and_restore(token):
    """Lịch sử chỉnh sửa: ghi đúng diff, squash lưu liên tiếp, khôi phục phiên bản."""
    print("Testing revisions & restore...")
    auth = {'Authorization': f'Bearer {token}'}
    base_doc = {
        "title": "Lịch Sử Test", "members": ["An", "Bình"],
        "expenses": [{"title": "Ăn sáng", "amount": 100000, "currency": "VND",
                      "payer": "An", "benefitType": "all", "beneficiaries": [],
                      "expense_date": "", "created_time": "t1", "updated_time": ""}],
    }
    r = requests.post(f"{BASE_URL}/api/events", json=base_doc, headers=auth)
    assert r.status_code == 200, r.text
    code, updated_at = r.json()['event_code'], r.json()['updated_at']
    try:
        # 1. Chưa đăng nhập → 401; đăng nhập → thấy dòng 'create'
        r = requests.get(f"{BASE_URL}/api/events/{code}/revisions")
        assert r.status_code == 401, f'revisions không token phải 401, được {r.status_code}'
        r = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth)
        assert r.status_code == 200, r.text
        revs = r.json()['revisions']
        assert len(revs) == 1 and revs[0]['kind'] == 'create', revs
        assert revs[0]['summary'] == ['Tạo sự kiện']
        assert 'snapshot' not in revs[0], 'revisions không được trả snapshot'
        print("  ✅ revision 'create' + chặn 401")

        # 2. PUT sửa số tiền + thêm thành viên → revision 'edit' với diff đúng
        doc2 = dict(base_doc, members=["An", "Bình", "Chi"])
        doc2['expenses'] = [dict(base_doc['expenses'][0], amount=200000)]
        doc2['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc2, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert len(revs) == 2 and revs[0]['kind'] == 'edit', revs
        joined = ' | '.join(revs[0]['summary'])
        assert "Thêm thành viên 'Chi'" in joined and 'Sửa chi phí' in joined, joined
        print("  ✅ revision 'edit' với diff tiếng Việt")

        # 3. PUT tiếp, lại sửa CÙNG chi phí → squash: vẫn 2 dòng
        doc3 = dict(doc2)
        doc3['expenses'] = [dict(base_doc['expenses'][0], amount=300000)]
        doc3['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc3, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        # lần 2 chỉ sửa expense t1 (update) — nhưng lần 1 có cả 'add' member
        # → tập đối tượng khác → KHÔNG squash với lần 1; tự PUT thêm lần nữa
        doc4 = dict(doc3)
        doc4['expenses'] = [dict(base_doc['expenses'][0], amount=400000)]
        doc4['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc4, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs2 = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert len(revs2) == len(revs), f'sửa liên tiếp cùng chi phí phải squash: {len(revs)} → {len(revs2)}'
        assert '400.000' in ' '.join(revs2[0]['summary']), revs2[0]['summary']
        print("  ✅ squash các lần lưu liên tiếp sửa cùng đối tượng")

        # 4. Restore về bản 'create' → nội dung quay lại ban đầu + có dòng 'restore'
        create_rev = revs2[-1]
        assert create_rev['kind'] == 'create'
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': create_rev['id'], 'expectedUpdatedAt': updated_at},
                          headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        ev = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth).json()['event']
        assert ev['members'] == ['An', 'Bình'], ev['members']
        assert ev['expenses'][0]['amount'] == 100000, ev['expenses']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert revs[0]['kind'] == 'restore' and 'Khôi phục về phiên bản lúc' in revs[0]['summary'][0]
        print("  ✅ restore đúng nội dung + tự ghi dòng 'restore'")

        # 5. Restore với expectedUpdatedAt cũ → 409; revision_id rác → 404
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': create_rev['id'],
                                'expectedUpdatedAt': '1999-01-01T00:00:00'},
                          headers=auth)
        assert r.status_code == 409, f'restore stale phải 409, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': 'khong-phai-uuid', 'expectedUpdatedAt': updated_at},
                          headers=auth)
        assert r.status_code == 404, f'revision_id rác phải 404, được {r.status_code}'
        print("  ✅ restore: 409 khi stale, 404 khi revision_id rác")

        # 6. User khác (không quyền) xem lịch sử → 403
        user2_id, token2, _email2 = create_test_user()
        try:
            r = requests.get(f"{BASE_URL}/api/events/{code}/revisions",
                             headers={'Authorization': f'Bearer {token2}'})
            assert r.status_code == 403, f'người không quyền phải 403, được {r.status_code}'
        finally:
            delete_test_user(user2_id)
        print("  ✅ người không có quyền sửa không xem được lịch sử")
        print("✅ Revisions & restore OK")
        return True
    finally:
        requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth)

def test_collaborators(token, owner_email):
    """Người được mời đích danh: quyền cộng dồn, owner-only, resolve email/username, lịch sử."""
    print("Testing collaborators...")
    auth = {'Authorization': f'Bearer {token}'}
    r = requests.post(f"{BASE_URL}/api/events",
                      json={"title": "Collab Test", "members": ["An"], "expenses": []},
                      headers=auth)
    assert r.status_code == 200, r.text
    code = r.json()['event_code']
    user2_id, token2, email2 = create_test_user()
    auth2 = {'Authorization': f'Bearer {token2}'}
    try:
        # 0. Đặt Hạn chế; user2 chưa được mời → GET 403, lookup ẩn
        r = requests.put(f"{BASE_URL}/api/events/{code}/sharing",
                         json={'access': 'restricted', 'role': 'viewer'}, headers=auth)
        assert r.status_code == 200, r.text
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.status_code == 403, f'chưa được mời phải 403, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/lookup", json={'codes': [code]}, headers=auth2)
        assert r.json()['events'] == [], 'lookup phải ẩn event restricted với người lạ'
        print("  ✅ restricted chặn người chưa được mời")

        # 1. Owner thêm user2 (email, viewer) → xem được, không sửa được, lookup thấy
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': email2, 'role': 'viewer'}, headers=auth)
        assert r.status_code == 200 and r.json()['collaborator']['role'] == 'viewer', r.text
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.status_code == 200, f'viewer phải GET được, {r.status_code}'
        ev = r.json()['event']
        assert ev['can_edit'] is False and ev['is_owner'] is False, ev
        put_doc = {'title': 'Collab Test', 'members': ['An'], 'expenses': [],
                   'expectedUpdatedAt': ev['updated_at']}
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc, headers=auth2)
        assert r.status_code == 403, f'viewer PUT phải 403, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/lookup", json={'codes': [code]}, headers=auth2)
        assert [e['event_code'] for e in r.json()['events']] == [code], 'lookup phải thấy'
        print("  ✅ viewer: xem được restricted, không sửa được, lookup thấy")

        # 2. Đổi role editor (POST upsert) → sửa được; không xóa event; không quản lý danh sách
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': email2, 'role': 'editor'}, headers=auth)
        assert r.status_code == 200 and r.json()['collaborator']['role'] == 'editor', r.text
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        ev = r.json()['event']
        assert ev['can_edit'] is True, 'editor phải can_edit=True'
        put_doc['expectedUpdatedAt'] = ev['updated_at']
        put_doc['title'] = 'Collab Test sửa'
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc, headers=auth2)
        assert r.status_code == 200, f'editor PUT phải 200, được {r.status_code}: {r.text}'
        r = requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.status_code == 403, f'editor DELETE event phải 403, được {r.status_code}'
        r = requests.get(f"{BASE_URL}/api/events/{code}/collaborators", headers=auth2)
        assert r.status_code == 403, 'không phải owner không xem được danh sách'
        print("  ✅ editor: sửa được, không xóa được event, không quản lý danh sách")

        # 3. Gỡ user2 → mất quyền; thêm lại bằng USERNAME
        uname = 'collab' + secrets.token_hex(4)
        r = requests.put(f"{BASE_URL}/api/profile", json={'username': uname}, headers=auth2)
        assert r.status_code == 200, r.text
        r = requests.delete(f"{BASE_URL}/api/events/{code}/collaborators/{user2_id}", headers=auth)
        assert r.status_code == 200, r.text
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.status_code == 403, 'gỡ xong phải mất quyền truy cập restricted'
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': uname, 'role': 'viewer'}, headers=auth)
        assert r.status_code == 200 and r.json()['collaborator']['display'] == uname, r.text
        print("  ✅ gỡ quyền + thêm lại bằng username (display = username)")

        # 4. Lỗi: identifier lạ 404; thêm owner 400; role rác 400; không token 401; DELETE người lạ 404
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': f'khongton-{secrets.token_hex(3)}', 'role': 'viewer'},
                          headers=auth)
        assert r.status_code == 404, f'identifier lạ phải 404, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': owner_email, 'role': 'viewer'}, headers=auth)
        assert r.status_code == 400, f'thêm chính owner phải 400, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/{code}/collaborators",
                          json={'identifier': uname, 'role': 'admin'}, headers=auth)
        assert r.status_code == 400, f'role rác phải 400, được {r.status_code}'
        r = requests.get(f"{BASE_URL}/api/events/{code}/collaborators")
        assert r.status_code == 401, f'không token phải 401, được {r.status_code}'
        r = requests.delete(
            f"{BASE_URL}/api/events/{code}/collaborators/00000000-0000-0000-0000-000000000000",
            headers=auth)
        assert r.status_code == 404, f'gỡ người không có phải 404, được {r.status_code}'
        print("  ✅ 404/400/401 đúng")

        # 5. Lịch sử có các dòng share tương ứng
        r = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth)
        texts = ' | '.join(t for rev in r.json()['revisions'] for t in rev['summary'])
        assert 'Thêm quyền truy cập cho' in texts, texts
        assert 'Đổi vai trò của' in texts, texts
        assert 'Xóa quyền truy cập của' in texts, texts
        print("  ✅ lịch sử ghi thêm/đổi vai trò/gỡ")
        print("✅ Collaborators OK")
        return True
    finally:
        delete_test_user(user2_id)
        requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth)

def main():
    """Chạy tất cả tests. Trả True khi TẤT CẢ pass — main exit code khác 0 khi
    fail để dùng được trong CI / chuỗi &&."""
    print("🚀 Starting API tests...\n")

    if not (SUPABASE_URL and SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY):
        print("❌ Cần SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY để test auth.")
        return False

    if not test_banks_api():
        return False

    user_id, token, owner_email = create_test_user()
    try:
        event_code = test_create_event(token)
        if not event_code:
            return False
        if not test_get_event(event_code, token):
            return False
        if not test_lookup_events(event_code):
            return False
        if not test_update_event(event_code, token):
            return False
        if not test_roundtrip_document(event_code, token):
            return False
        if not test_auth_matrix(token):
            return False
        if not test_ownerless_event(token):
            return False
        if not test_saved_events(token):
            return False
        if not test_revisions_and_restore(token):
            return False
        if not test_collaborators(token, owner_email):
            return False
        if not test_delete_event(event_code, token):
            return False
        print("\n🎉 All tests passed!")
        return True
    finally:
        delete_test_user(user_id)

if __name__ == "__main__":
    sys.exit(0 if main() else 1)