# Đồng bộ "Sự Kiện Của Tôi" theo tài khoản + bỏ edit key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danh sách "Sự Kiện Của Tôi" lưu theo tài khoản Supabase (bảng `saved_events`), đồng thời bỏ hẳn cơ chế `edit_key` — quyền chỉ còn owner / người được mời / chế độ chia sẻ; event không có chủ mặc định ai đăng nhập cũng sửa/xóa được.

**Spec:** `docs/superpowers/specs/2026-08-12-saved-events-account-sync-design.md` (đã duyệt).

**Architecture:** Backend Flask một file (`vercel_app.py`), storage Postgres trên Supabase, frontend jQuery SPA (`static/app.js`). Thêm bảng `saved_events(user_id, event_id)`; `GET /api/my-events` trả hợp `sở hữu ∪ được mời ∪ đã lưu` kèm cờ `owned`; frontend đẩy danh sách localStorage lên tài khoản một lần khi đăng nhập. Mọi nhánh quyền theo `X-Edit-Key` bị xóa cả hai đầu.

**Tech Stack:** Flask + psycopg2, Supabase Auth (JWT verify offline), jQuery + Bootstrap. Không thêm dependency mới.

## Global Constraints

- UI text, comment, message lỗi: TIẾNG VIỆT (giữ giọng các comment hiện có).
- 401 = chưa đăng nhập, 403 = không có quyền — giữ đúng phân biệt này ở mọi endpoint.
- Lỗi nội bộ qua `_server_error(e)`; mọi `except Exception` quanh request-body phải re-raise `HTTPException` trước (giữ nguyên các block hiện có).
- XSS: mọi render dữ liệu người dùng trong JS mới phải qua `escapeHtml()`; đọc data-attribute bằng `.attr('data-...')`, KHÔNG dùng `.data()` (jQuery ép kiểu — xem commit 61782bd).
- Autosave: KHÔNG thêm lời gọi `saveEvent` mới vào render/calculate path.
- KHÔNG bump `CACHE_VERSION` trong `static/sw.js` (không đổi hành vi cache).
- `requirements.txt` / `api/requirements.txt` không đổi (không dependency mới).
- ⚠️ **DB Supabase trong `.env` cũng đang phục vụ bản Vercel production.** Trong lúc dev CHỈ chạy DDL tạo `saved_events` (Task 1). TUYỆT ĐỐI không chạy `psql -f schema.sql` (có `DROP COLUMN edit_key`) trước khi code mới được deploy — code cũ đang SELECT `edit_key`, drop cột là 500 toàn bộ event API trên production.
- Integration test: cần server local chạy sẵn — `python3 vercel_app.py` (port 5002), env đọc từ `.env`. Sau mỗi lần sửa `vercel_app.py` phải restart server trước khi chạy lại `python3 test_api.py`.
- Commit message tiếng Việt, prefix conventional (`feat:`/`fix:`/`test:`/`docs:`), kết thúc bằng dòng `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Schema — bảng `saved_events` + chuẩn bị bỏ `edit_key`

**Files:**
- Modify: `schema.sql`

**Interfaces:**
- Produces: bảng `saved_events (user_id uuid, event_id uuid FK→events ON DELETE CASCADE, saved_at timestamptz, PK (user_id, event_id))` — Task 3 INSERT/DELETE/JOIN vào bảng này.

- [ ] **Step 1: Sửa `schema.sql`**

Trong `CREATE TABLE IF NOT EXISTS events`, xóa dòng:

```sql
    edit_key   text,
```

Sửa comment trên `event_collaborators` (dòng ~119) từ:

```sql
-- Quyền CỘNG DỒN với quyền chung theo link + edit_key; chỉ owner quản lý danh sách.
```

thành:

```sql
-- Quyền CỘNG DỒN với quyền chung theo link; chỉ owner quản lý danh sách.
```

Thêm block sau, ngay SAU `CREATE TABLE IF NOT EXISTS event_collaborators (...)` và trước phần `CREATE INDEX`:

```sql
-- "Sự Kiện Của Tôi" theo tài khoản: event user đã LƯU vào danh sách (ngoài event
-- họ sở hữu / được mời đích danh). Chỉ là bookmark — không mang quyền truy cập.
CREATE TABLE IF NOT EXISTS saved_events (
    user_id  uuid NOT NULL,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    saved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id)
);
```

Thêm vào danh sách index (cạnh `idx_event_collaborators_user`):

```sql
CREATE INDEX IF NOT EXISTS idx_saved_events_user ON saved_events (user_id);
```

Thêm vào danh sách `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (cuối file, cùng các bảng khác):

```sql
ALTER TABLE saved_events          ENABLE ROW LEVEL SECURITY;
```

Thêm ở CUỐI file:

```sql
-- Bỏ cơ chế edit key (2026-08-12): quyền chỉ còn owner / người được mời /
-- chế độ chia sẻ. Idempotent. LƯU Ý deploy: chỉ chạy schema.sql lên DB đang
-- phục vụ production SAU khi code mới (không còn đọc edit_key) đã deploy.
ALTER TABLE events DROP COLUMN IF EXISTS edit_key;
```

- [ ] **Step 2: Áp dụng RIÊNG phần saved_events lên DB (không đụng edit_key)**

```bash
cd /Users/thuanmt/code/chia-tien-nhom-flask
set -a; source .env; set +a
psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS saved_events (
    user_id  uuid NOT NULL,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    saved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_events_user ON saved_events (user_id);
ALTER TABLE saved_events ENABLE ROW LEVEL SECURITY;
SQL
```

- [ ] **Step 3: Kiểm tra bảng tồn tại**

```bash
psql "$DATABASE_URL" -c '\d saved_events'
```

Expected: bảng với 3 cột, PK `(user_id, event_id)`, FK `event_id → events(id) ON DELETE CASCADE`, RLS enabled. Kiểm thêm cột edit_key VẪN CÒN (chưa drop):

```bash
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='events' AND column_name='edit_key'"
```

Expected: 1 row (`edit_key`).

- [ ] **Step 4: Commit**

```bash
git add schema.sql
git commit -m "feat: schema bảng saved_events + dọn edit_key (drop chạy sau deploy)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — bỏ edit key khỏi mô hình quyền

**Files:**
- Modify: `vercel_app.py` (`_check_edit_permission`, `_provided_edit_key`, `create_event`, `get_event`, `update_sharing`, `list_event_revisions`, `delete_event`, import `hmac`)
- Modify: `migrate_to_supabase.py:74-81`
- Test: `test_api.py`

**Interfaces:**
- Consumes: cột `events.owner_id` (nullable uuid), `_collaborator_role(cursor, event_id, user_id)` (đã có).
- Produces: `_check_edit_permission(cursor, event_code, allow_link_editor=True) -> (status, event_id, updated_at)` — KHÔNG còn tham số `adopt_key`; status `'ok'` khi owner / collaborator-editor / link-editor / `owner_id IS NULL`. `POST /api/events` response không còn trường `edit_key`.

- [ ] **Step 1: Viết lại các test quyền trong `test_api.py` (test-first)**

Thêm import + helper DB sau block `SUPABASE_SERVICE_ROLE_KEY = ...` (dòng ~25):

```python
import psycopg2


def _db_execute(sql, params):
    """Thao tác DB trực tiếp — chỉ dùng để dựng dữ liệu test (vd event không chủ)."""
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(sql, params)
    cur.close()
    conn.close()
```

Thay `test_create_event` (dòng 69-111) — giữ nguyên `event_data`, đổi phần xử lý response:

```python
def test_create_event(token):
    """Test tạo sự kiện mới — response KHÔNG được chứa edit_key (đã bỏ cơ chế key)"""
    print("Testing create event API...")
    event_data = {
        # ... GIỮ NGUYÊN payload hiện có ...
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
```

Thay `test_get_event` (dòng 113-157):

```python
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
```

Thay `test_update_event` + `_test_update_event_body` (dòng 189-283) — bỏ mọi header key; giữ nguyên `event_data`:

```python
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
        # ... GIỮ NGUYÊN payload hiện có ...
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
```

Thay `test_delete_event` (dòng 285-310):

```python
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
```

Trong `test_roundtrip_document` (dòng 312-350): đổi chữ ký thành `def test_roundtrip_document(event_code, token):` và đổi headers của lệnh PUT thành `headers={'Authorization': f'Bearer {token}'}` (bỏ `'X-Edit-Key': edit_key`).

Thay `test_auth_matrix` (dòng 352-430):

```python
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
```

Thêm test MỚI ngay sau `test_auth_matrix`:

```python
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
```

Trong `main()` (dòng 632-666), cập nhật wiring:

```python
        event_code = test_create_event(token)
        if not event_code:
            return
        if not test_get_event(event_code, token):
            return
        if not test_lookup_events(event_code):
            return
        if not test_update_event(event_code, token):
            return
        if not test_roundtrip_document(event_code, token):
            return
        if not test_auth_matrix(token):
            return
        if not test_ownerless_event(token):
            return
        if not test_revisions_and_restore(token):
            return
        if not test_collaborators(token, owner_email):
            return
        if not test_delete_event(event_code, token):
            return
```

Kiểm tra sót: `grep -n "edit_key\|X-Edit-Key" test_api.py` — chỉ được còn các assert DẠNG PHỦ ĐỊNH (`'edit_key' not in ...`, message lỗi) và header cố tình gửi để chứng minh bị bỏ qua.

- [ ] **Step 2: Chạy test để thấy FAIL với backend hiện tại**

```bash
cd /Users/thuanmt/code/chia-tien-nhom-flask
lsof -ti:5002 | xargs kill 2>/dev/null; sleep 1
python3 vercel_app.py > /private/tmp/claude-501/-Users-thuanmt-code-chia-tien-nhom-flask/dad4bfde-4586-433e-a08c-892c33115d2e/scratchpad/server.log 2>&1 &
sleep 3
python3 test_api.py
```

Expected: FAIL ở `test_create_event` — "❌ Create event vẫn trả edit_key".

- [ ] **Step 3: Sửa `vercel_app.py`**

3a. Xóa `import hmac` (dòng 3) — sau task này không còn chỗ nào dùng.

3b. Xóa hàm `_provided_edit_key` (dòng 83-84).

3c. Thay toàn bộ `_check_edit_permission` (dòng 103-150) bằng:

```python
def _check_edit_permission(cursor, event_code, allow_link_editor=True):
    """Kiểm tra quyền sửa/xóa event.

    Trả về (status, event_id, updated_at) với status: 'not_found' | 'forbidden' | 'ok'.
    Quyền hợp lệ khi: là owner (JWT Supabase) HOẶC là collaborator vai trò
    'editor' HOẶC event chia sẻ ở chế độ "ai có link đều chỉnh sửa"
    (share_access='link' + share_role='editor') — hai nhánh sau không áp dụng
    cho DELETE (allow_link_editor=False) — HOẶC event không có chủ
    (owner_id NULL, legacy/migrate): mặc định ai đăng nhập cũng sửa/xóa được.
    Đăng nhập được kiểm ở từng route (401) TRƯỚC khi gọi hàm này (403)."""
    cursor.execute(
        '''SELECT id, owner_id, updated_at, share_access, share_role
           FROM events WHERE event_code = %s''',
        (event_code,),
    )
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, owner_id, updated_at, share_access, share_role = row

    # Event không có chủ — mặc định mở cho mọi người (đã đăng nhập)
    if owner_id is None:
        return 'ok', event_id, updated_at

    user_id = request_user_id(request)
    if user_id and str(owner_id) == user_id:
        return 'ok', event_id, updated_at

    # Người được mời đích danh vai trò "người chỉnh sửa": sửa nội dung + đổi
    # chia sẻ được, nhưng không xóa event (đi cùng cờ allow_link_editor, giống
    # link-editor — DELETE gọi với allow_link_editor=False)
    if allow_link_editor and user_id and _collaborator_role(cursor, event_id, user_id) == 'editor':
        return 'ok', event_id, updated_at

    # Chia sẻ kiểu Google Docs: "Bất kỳ ai có đường liên kết — Người chỉnh sửa"
    if allow_link_editor and share_access == 'link' and share_role == 'editor':
        return 'ok', event_id, updated_at

    return 'forbidden', event_id, updated_at
```

3d. `create_event` (dòng ~297-354): xóa dòng `edit_key = secrets.token_urlsafe(24)` (và comment trên nó); đổi INSERT thành:

```python
            cursor.execute(
                '''INSERT INTO events (event_code, title, owner_id)
                   VALUES (%s, %s, %s) RETURNING id, updated_at''',
                (event_code, data['title'], user_id),
            )
```

và xóa dòng `'edit_key': edit_key,` khỏi response. (`import secrets` GIỮ NGUYÊN — `generate_event_code` vẫn dùng.)

3e. `get_event` (dòng ~550-617): đổi SELECT bỏ `edit_key`:

```python
        cursor.execute(
            '''SELECT id, event_code, title, owner_id, share_access, share_role,
                      created_at, updated_at
               FROM events WHERE event_code = %s''',
            (event_code,),
        )
```

Thay block tính quyền (từ `stored_key = ...` đến hết `login_required_to_edit = ...`) bằng:

```python
        user_id = request_user_id(request)
        ownerless = event['owner_id'] is None
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        collab_role = _collaborator_role(cursor, event['id'], user_id)

        # Chế độ "Hạn chế": owner / người được mời đích danh. Event không chủ
        # thì luôn xem được (không có owner để giới hạn về).
        if (event['share_access'] == 'restricted' and not ownerless
                and not (is_owner or collab_role)):
            cursor.close()
            return jsonify({
                'success': False,
                'error': 'Sự kiện đang ở chế độ hạn chế — chỉ chủ sở hữu mới truy cập được.',
            }), 403

        doc = load_event_children(cursor, event['id'])
        cursor.close()

        # Quyền sửa: owner / event không chủ / chia sẻ "ai có link đều chỉnh
        # sửa" / được mời vai trò editor. Mọi thao tác ghi yêu cầu đăng nhập →
        # can_edit ("PUT của bạn sẽ thành công") chỉ true khi CÓ QUYỀN và ĐÃ
        # đăng nhập; có quyền mà chưa đăng nhập → cờ riêng để UI hiện
        # "Đăng nhập để chỉnh sửa".
        link_editor = event['share_access'] == 'link' and event['share_role'] == 'editor'
        has_permission = is_owner or ownerless or link_editor or collab_role == 'editor'
        can_edit = has_permission and bool(user_id)
        login_required_to_edit = has_permission and not user_id
```

(giữ nguyên phần `return jsonify({...})` — chỉ cần comment "tuyệt đối không trả edit_key" đổi thành ghi chú cũ không còn cần: XÓA dòng comment đó.)

3f. `update_sharing` (dòng ~864-925): sau block check `permission == 'forbidden'`, thêm:

```python
        # Event không có chủ mà đặt 'restricted' thì không còn ai xem được → chặn
        if access == 'restricted':
            cursor.execute('SELECT owner_id FROM events WHERE id = %s', (event_id,))
            if cursor.fetchone()[0] is None:
                cursor.close()
                return jsonify({
                    'success': False,
                    'error': 'Sự kiện chưa có chủ sở hữu — không đặt được chế độ hạn chế.',
                }), 400
```

Đồng thời sửa comment docstring `(owner / edit_key / link-editor)` → `(owner / người được mời / link-editor)` (2 chỗ trong hàm này).

3g. `list_event_revisions` (dòng ~940): `_check_edit_permission(cursor, event_code, adopt_key=False)` → `_check_edit_permission(cursor, event_code)`.

3h. `delete_event` (dòng ~1236-1264): sửa comment thành:

```python
        # Xóa event: chỉ owner (event không chủ: ai đăng nhập cũng xóa được,
        # giữ hành vi legacy) — vai trò "Người chỉnh sửa" qua link/được mời
        # không được xóa (giống Google Docs).
```

3i. Rà comment còn nhắc edit_key: `grep -n "edit_key\|X-Edit-Key\|hmac" vercel_app.py` — cập nhật các comment ở `update_event` (dòng ~624-625: `(owner/edit_key/link-editor)` → `(owner/người được mời/link-editor)`), `my_events` docstring (`không có edit_key (owner sửa bằng JWT)` → `chỉ metadata`), `lookup_events` docstring (`tuyệt đối không có edit_key` → `không có dữ liệu nhạy cảm`). Sau bước này grep phải trả về 0 dòng.

3j. `migrate_to_supabase.py` (dòng 73-81): thay INSERT thành:

```python
            cur.execute(
                '''INSERT INTO events (event_code, title, created_at, updated_at)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (event_code) DO UPDATE
                   SET title = EXCLUDED.title,
                       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
                   WHERE events.updated_at <= EXCLUDED.updated_at
                   RETURNING id''',
                (code, doc['title'], row['created_at'], row['updated_at']),
            )
```

và sửa dòng 13 của docstring: `Giữ nguyên event_code, edit_key, created_at...` → `Giữ nguyên event_code, created_at...`.

- [ ] **Step 4: Restart server, chạy test → PASS**

```bash
python3 -m py_compile vercel_app.py migrate_to_supabase.py test_api.py
lsof -ti:5002 | xargs kill 2>/dev/null; sleep 1
python3 vercel_app.py > /private/tmp/claude-501/-Users-thuanmt-code-chia-tien-nhom-flask/dad4bfde-4586-433e-a08c-892c33115d2e/scratchpad/server.log 2>&1 &
sleep 3
python3 test_api.py
```

Expected: `🎉 All tests passed!` (test_revisions_and_restore + test_collaborators chạy với owner JWT nên không bị ảnh hưởng).

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py migrate_to_supabase.py test_api.py
git commit -m "feat!: bỏ cơ chế edit key — quyền chỉ còn owner/người được mời/chế độ chia sẻ

Event không có chủ (legacy) mặc định ai đăng nhập cũng sửa/xóa được;
chặn đặt chế độ hạn chế cho event không chủ. Header X-Edit-Key bị bỏ qua,
link cũ &key= vẫn mở được như link thường.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — API "Sự Kiện Của Tôi" theo tài khoản

**Files:**
- Modify: `vercel_app.py` (thay `my_events`, thêm 2 endpoint mới ngay sau nó)
- Test: `test_api.py`

**Interfaces:**
- Consumes: bảng `saved_events` (Task 1), `request_user_id(request)` (đã có).
- Produces:
  - `GET /api/my-events` → `{success, events: [{event_code, title, updated_at, owned: bool}]}` — hợp `sở hữu ∪ được mời ∪ đã lưu`, sắp `updated_at DESC`.
  - `POST /api/my-events/save` body `{codes: [str, tối đa 50]}` → `{success: true}` (idempotent, mã không tồn tại bị bỏ qua, tổng đã lưu tối đa 200/user).
  - `DELETE /api/my-events/<event_code>` → `{success: true}` (kể cả khi không có gì để gỡ).
  - Cả ba: 401 khi chưa đăng nhập. Task 5 (frontend) gọi đúng các shape này.

- [ ] **Step 1: Thêm `test_saved_events` vào `test_api.py` (test-first)**

Thêm sau `test_ownerless_event`:

```python
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
    try:
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
        delete_test_user(user2_id)
```

Wire vào `main()` sau `test_ownerless_event`:

```python
        if not test_saved_events(token):
            return
```

- [ ] **Step 2: Chạy test → FAIL**

```bash
python3 test_api.py
```

Expected: FAIL trong `test_saved_events` — `POST /api/my-events/save` trả 404 (endpoint chưa có; lưu ý assert 401 đứng trước sẽ fail vì 404 ≠ 401).

- [ ] **Step 3: Sửa `vercel_app.py`**

Thêm hằng số gần đầu file (cạnh các hằng khác, ví dụ trên `_USERNAME_RE`):

```python
# Giới hạn số event một tài khoản lưu vào "Sự Kiện Của Tôi"
_SAVED_EVENTS_CAP = 200
```

Thay toàn bộ hàm `my_events` (dòng ~384-412) bằng:

```python
@app.route('/api/my-events')
@limiter.limit('30 per minute; 500 per day')
def my_events():
    """Danh sách "Sự Kiện Của Tôi" theo tài khoản: event sở hữu ∪ được mời
    đích danh ∪ đã lưu (saved_events) — đồng bộ giữa các thiết bị. Chỉ trả
    metadata + cờ owned (frontend phân biệt nút Xóa event / Gỡ khỏi danh sách)."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT e.event_code, e.title, e.updated_at,
                      COALESCE(e.owner_id = %s::uuid, false) AS owned
               FROM events e
               WHERE e.owner_id = %s::uuid
                  OR EXISTS (SELECT 1 FROM event_collaborators c
                             WHERE c.event_id = e.id AND c.user_id = %s::uuid)
                  OR EXISTS (SELECT 1 FROM saved_events s
                             WHERE s.event_id = e.id AND s.user_id = %s::uuid)
               ORDER BY e.updated_at DESC''',
            (user_id, user_id, user_id, user_id),
        )
        rows = cursor.fetchall()
        cursor.close()
        return jsonify({'success': True, 'events': [
            {
                'event_code': r['event_code'],
                'title': r['title'],
                'updated_at': r['updated_at'].isoformat() if r['updated_at'] else None,
                'owned': bool(r['owned']),
            } for r in rows
        ]})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/my-events/save', methods=['POST'])
@limiter.limit('30 per minute; 500 per day')
def save_my_events():
    """Lưu event vào "Sự Kiện Của Tôi" của tài khoản (idempotent). Body
    {codes: [...]} tối đa 50 mã / lần — dùng cho cả lưu 1 mã khi mở event
    lẫn migration danh sách localStorage. Mã không tồn tại bị bỏ qua."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        body = request.get_json(silent=True)
        codes = body.get('codes') if isinstance(body, dict) else None
        if (not isinstance(codes, list) or len(codes) > 50
                or not all(isinstance(c, str) and 0 < len(c) <= 64 for c in codes)):
            return jsonify({'success': False, 'error': 'Danh sách mã sự kiện không hợp lệ.'}), 400
        if not codes:
            return jsonify({'success': True})

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT count(*) FROM saved_events WHERE user_id = %s::uuid', (user_id,))
        remaining = _SAVED_EVENTS_CAP - cursor.fetchone()[0]
        if remaining > 0:
            # Mã trùng/đã lưu: ON CONFLICT bỏ qua. Vượt cap: cắt bớt phần thừa.
            cursor.execute(
                '''INSERT INTO saved_events (user_id, event_id)
                   SELECT %s::uuid, e.id FROM events e
                   WHERE e.event_code = ANY(%s)
                   ORDER BY e.updated_at DESC
                   LIMIT %s
                   ON CONFLICT DO NOTHING''',
                (user_id, codes, remaining),
            )
        cursor.close()
        return jsonify({'success': True})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/my-events/<event_code>', methods=['DELETE'])
@limiter.limit('30 per minute; 500 per day')
def unsave_my_event(event_code):
    """Gỡ event khỏi "Sự Kiện Của Tôi" của tài khoản — KHÔNG đụng tới event.
    Idempotent: gỡ mã không có trong danh sách vẫn trả success."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            '''DELETE FROM saved_events s USING events e
               WHERE s.event_id = e.id AND s.user_id = %s::uuid AND e.event_code = %s''',
            (user_id, event_code),
        )
        cursor.close()
        return jsonify({'success': True})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 4: Restart server, chạy test → PASS**

```bash
python3 -m py_compile vercel_app.py test_api.py
lsof -ti:5002 | xargs kill 2>/dev/null; sleep 1
python3 vercel_app.py > /private/tmp/claude-501/-Users-thuanmt-code-chia-tien-nhom-flask/dad4bfde-4586-433e-a08c-892c33115d2e/scratchpad/server.log 2>&1 &
sleep 3
python3 test_api.py
```

Expected: `🎉 All tests passed!`

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py test_api.py
git commit -m "feat: API Sự Kiện Của Tôi theo tài khoản (saved_events + my-events hợp nhất)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — bỏ edit key (`static/app.js`)

**Files:**
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `GET /api/events/<code>` trả `can_edit`/`is_owner`/`login_required_to_edit` (Task 2).
- Produces: mọi request ghi chỉ còn header từ `AppAuth.authHeaders()`. Task 5 sửa tiếp phần danh sách.

- [ ] **Step 1: Gỡ đọc `&key=` ở boot (dòng ~152-215)**

Xóa dòng `const urlEditKey = urlParams.get('key');`. Sửa comment dòng 156-158 thành:

```js
        // Quyền chỉnh sửa do SERVER quyết định: GET event trả về cờ can_edit
        // theo JWT + chế độ chia sẻ. Có quyền → giao diện chỉnh sửa,
        // không có → giao diện chỉ xem (loadEventFromServer xử lý).
```

Trong block `if (bootHasEvent)` (dòng ~184-192), thay `allowEdit = !!(urlEditKey || getEditKey(urlEventCode));` bằng `allowEdit = false;` (chờ server xác nhận — overlay đang che trang nên không nháy UI).

Trong `AppAuth.onReady` (dòng ~207-217), thay block `else if (urlEventCode) {...}` bằng:

```js
            } else if (urlEventCode) {
                // Link chia sẻ /?event_code=X — server xác nhận quyền qua can_edit.
                // Link cũ /?event_code=X&key=... vẫn mở được: tham số key bị bỏ qua.
                allowEdit = false;
                currentEventCode = urlEventCode;
                loadEventFromServer(currentEventCode);
            } else if (currentEventCode) {
```

- [ ] **Step 2: Xóa các hàm khóa (dòng ~568-616)**

Xóa từ comment `// ===== Khóa chỉnh sửa (edit key) =====` đến hết `getOrCreateEditKey` (giữ lại `buildShareLink`, `copyTextToClipboard` và comment `// ===== Hết phần khóa chỉnh sửa =====` đổi thành `// ===== Hết phần chia sẻ =====`). Sửa comment trên `buildShareLink` thành:

```js
        // Link chia sẻ chỉ có event_code — server quyết quyền theo cài đặt
        // chia sẻ kiểu Google Docs (shareAccess/shareRole).
        // ===== Link chia sẻ =====
```

Thêm 1 dòng dọn localStorage cũ ngay trước `AppAuth.onReady(...)` (dòng ~197):

```js
        // Cơ chế edit key đã bỏ (2026-08) — dọn khóa cũ còn sót trên máy
        localStorage.removeItem('eventEditKeys');
```

- [ ] **Step 3: Bỏ header key khỏi mọi request**

- `saveEvent` PUT (dòng ~711): `headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(currentEventCode) }),` → `headers: AppAuth.authHeaders(),`
- Comment dòng 665-666 đổi thành: `// Tạo sự kiện mới cần tài khoản (server cũng chặn 401) — sự kiện đã tồn tại thì quyền sửa do server quyết theo chế độ chia sẻ.`
- Handler 403 trong PUT (dòng ~731-736): xóa dòng `removeEditKey(currentEventCode);` (giữ toast + `allowEdit = false` + `updateUIForEditMode()`).
- Create success (dòng ~763-765): xóa block `if (response.edit_key) { setEditKey(currentEventCode, response.edit_key); }`.
- `loadEventFromServer` (dòng ~788-818): xóa dòng `const storedKey = ...`; đổi `headers: AppAuth.authHeaders(storedKey ? { 'X-Edit-Key': storedKey } : {}),` → `headers: AppAuth.authHeaders(),`; comment đầu hàm đổi thành `// Hàm tải sự kiện từ server — server trả cờ can_edit (JWT + chế độ chia sẻ), cờ này quyết định giao diện chỉnh sửa hay chỉ xem.`; thay block else (dòng ~807-818) bằng:

```js
                        } else {
                            allowEdit = !!eventData.can_edit;
                            // Có quyền sửa nhưng chưa đăng nhập → banner mời đăng nhập
                            $('#loginToEditBanner').toggleClass('d-none', !eventData.login_required_to_edit);
                        }
```

- Delete handler (dòng ~2588): `headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(eventCode) }),` → `headers: AppAuth.authHeaders(),`
- `loadHistory` (dòng ~2693-2700): xóa comment 3 dòng về adopt key + dòng `const storedKey = ...`; đổi headers thành `headers: AppAuth.authHeaders(),`
- Restore handler (dòng ~2733): headers → `AppAuth.authHeaders(),`
- `saveShareSettings` (dòng ~3011): headers → `AppAuth.authHeaders(),`

- [ ] **Step 4: Kiểm tra sạch + syntax**

```bash
grep -n "EditKey\|editKey\|X-Edit-Key\|urlParams.get('key')" static/app.js
node --check static/app.js
```

Expected: grep KHÔNG ra dòng nào; node --check im lặng.

- [ ] **Step 5: Commit**

```bash
git add static/app.js
git commit -m "feat!: frontend bỏ edit key — quyền hoàn toàn theo can_edit từ server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — "Sự Kiện Của Tôi" theo tài khoản (`static/app.js`)

**Files:**
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `GET /api/my-events` (`events[].{event_code,title,updated_at,owned}`), `POST /api/my-events/save` (`{codes:[...]}`), `DELETE /api/my-events/<code>` (Task 3); `POST /api/events/lookup` (đã có).
- Produces: `rememberEvent(eventCode)`, `migrateLocalSavedEvents()`, `displaySavedEvents(events, ownedByCode, emptyText)`, handler `.unsave-event-btn`.

- [ ] **Step 1: Thay 2 hàm local-save bằng bộ mới (dòng ~1608-1622)**

Thay `saveEventCodeToLocalStorage`/`removeEventCodeFromLocalStorage` + thêm 2 hàm mới:

```js
        // ===== "Sự Kiện Của Tôi" =====
        // Đăng nhập: danh sách lưu THEO TÀI KHOẢN (bảng saved_events, đồng bộ
        // giữa các thiết bị). Chưa đăng nhập: localStorage như cũ (chỉ để xem).
        function saveEventCodeToLocalStorage(eventCode) {
            let savedEventCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
            if (!savedEventCodes.includes(eventCode)) {
                savedEventCodes.push(eventCode);
                localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
            }
        }

        function removeEventCodeFromLocalStorage(eventCode) {
            let savedEventCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
            savedEventCodes = savedEventCodes.filter(code => code !== eventCode);
            localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
        }

        // Ghi nhớ event vào "Sự Kiện Của Tôi": đăng nhập → lưu theo tài khoản
        // (idempotent, fire-and-forget — lỗi mạng thì lần mở sau lưu lại);
        // chưa đăng nhập → localStorage.
        function rememberEvent(eventCode) {
            if (AppAuth.isLoggedIn()) {
                $.ajax({
                    url: '/api/my-events/save',
                    method: 'POST',
                    contentType: 'application/json',
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify({ codes: [eventCode] })
                });
            } else {
                saveEventCodeToLocalStorage(eventCode);
            }
        }

        // Migration một lần: đẩy danh sách đã lưu trên máy lên tài khoản rồi
        // XÓA local — nếu giữ lại, event đã gỡ trên máy khác sẽ "hồi sinh"
        // ở lần merge sau. Thất bại thì giữ nguyên local, lần đăng nhập sau thử lại.
        function migrateLocalSavedEvents() {
            if (!AppAuth.isLoggedIn()) return;
            let codes;
            try {
                codes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
            } catch (e) {
                codes = [];
            }
            if (!Array.isArray(codes) || codes.length === 0) return;
            const batches = [];
            for (let i = 0; i < codes.length; i += 50) batches.push(codes.slice(i, i + 50));
            Promise.all(batches.map(batch => $.ajax({
                url: '/api/my-events/save',
                method: 'POST',
                contentType: 'application/json',
                headers: AppAuth.authHeaders(),
                data: JSON.stringify({ codes: batch })
            }))).then(function () {
                localStorage.removeItem('savedEventCodes');
            });
        }
```

- [ ] **Step 2: Gọi `rememberEvent` tại 2 call site cũ**

- Dòng ~762 (create success): `saveEventCodeToLocalStorage(currentEventCode); // Lưu event_code vào localStorage` → `rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"`
- Dòng ~863 (load success, trong `if (allowEdit)`): `saveEventCodeToLocalStorage(currentEventCode); // Lưu vào danh sách sự kiện đã lưu` → `rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"`

- [ ] **Step 3: Gọi migration khi biết trạng thái đăng nhập**

Trong `AppAuth.onReady(function () {` (dòng ~197), thêm dòng đầu tiên của callback:

```js
            migrateLocalSavedEvents();
```

Trong handler `appauth:change` (dòng ~1683-1692), thêm sau `lastAuthLoggedIn = loggedIn;`:

```js
            if (loggedIn) migrateLocalSavedEvents();
```

- [ ] **Step 4: Viết lại `renderSavedEvents` (dòng ~1627-1675)**

```js
        // Hàm hiển thị danh sách sự kiện đã lưu.
        // Đăng nhập: danh sách theo TÀI KHOẢN (/api/my-events = sở hữu ∪ được
        // mời ∪ đã lưu). Chưa đăng nhập: danh sách localStorage của máy này.
        function renderSavedEvents() {
            $('#savedEventsList').empty();
            $('#savedEventsList').append('<p class="text-center text-muted">Đang tải...</p>');

            const loggedIn = AppAuth.isLoggedIn();
            const emptyText = loggedIn
                ? 'Chưa có sự kiện nào trong tài khoản của bạn.'
                : 'Chưa có sự kiện nào được lưu trên máy này.';

            function fail() {
                $('#savedEventsList').empty();
                $('#savedEventsList').append('<p class="text-center text-danger">Không tải được danh sách sự kiện. Vui lòng thử lại.</p>');
            }

            // localCodes chỉ có ở nhánh chưa đăng nhập — dùng để dọn mã đã chết
            function proceed(codes, ownedByCode, localCodes) {
                // lookup nhận tối đa 50 mã
                const allCodes = codes.slice(0, 50);
                if (allCodes.length === 0) {
                    $('#savedEventsList').empty();
                    $('#savedEventsList').append(`<p class="text-center text-muted">${emptyText}</p>`);
                    return;
                }
                // Chỉ dọn các mã LOCAL đã thực sự được gửi đi tra cứu — mã bị cắt
                // bớt do vượt giới hạn 50 không đồng nghĩa là không còn tồn tại.
                const sentLocal = (localCodes || []).filter(code => allCodes.includes(code));
                $.ajax({
                    url: '/api/events/lookup',
                    method: 'POST',
                    contentType: 'application/json',
                    // Kèm JWT: event ở chế độ "Hạn chế" chỉ hiện với owner/người được mời
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify({ codes: allCodes }),
                    success: function (response) {
                        const events = (response && response.events) || [];
                        const found = new Set(events.map(e => e.event_code));
                        sentLocal
                            .filter(code => !found.has(code))
                            .forEach(removeEventCodeFromLocalStorage);
                        displaySavedEvents(events, ownedByCode, emptyText);
                    },
                    error: fail
                });
            }

            if (loggedIn) {
                $.ajax({ url: '/api/my-events', headers: AppAuth.authHeaders() })
                    .done(function (r) {
                        const list = (r && r.events) || [];
                        const ownedByCode = {};
                        list.forEach(e => { ownedByCode[e.event_code] = !!e.owned; });
                        proceed(list.map(e => e.event_code), ownedByCode, []);
                    })
                    .fail(fail);
            } else {
                const localCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
                proceed(localCodes, {}, localCodes);
            }
        }
```

- [ ] **Step 5: `displaySavedEvents` nhận cờ owned + nút "Gỡ khỏi danh sách" (dòng ~1725-1770)**

Đổi chữ ký thành `function displaySavedEvents(events, ownedByCode, emptyText) {` và block rỗng thành:

```js
            if (events.length === 0) {
                $('#savedEventsList').append(`<p class="text-center text-muted">${emptyText}</p>`);
                return;
            }
```

Trong vòng `events.forEach`, trước `$('#savedEventsList').append(...)` thêm:

```js
                // Owner → xóa thật; còn lại → chỉ gỡ khỏi danh sách của mình
                const owned = !!(ownedByCode && ownedByCode[event.event_code]);
                const actionBtn = owned
                    ? `<button class="btn btn-sm btn-danger delete-event-btn" data-event-code="${safeCode}" title="Xóa sự kiện">
                            <i class="fas fa-trash"></i>
                       </button>`
                    : `<button class="btn btn-sm btn-outline-secondary unsave-event-btn" data-event-code="${safeCode}" title="Gỡ khỏi danh sách">
                            <i class="fas fa-times"></i>
                       </button>`;
```

và thay button xóa cứng trong template:

```js
                                ${actionBtn}
```

(giữ nguyên nút share phía trước.)

- [ ] **Step 6: Handler `.unsave-event-btn` (đặt cạnh handler `.delete-event-btn`, dòng ~2580)**

```js
        // Gỡ khỏi "Sự Kiện Của Tôi" — không xóa event, mở lại link là lưu lại được
        $(document).on('click', '.unsave-event-btn', function (e) {
            e.stopPropagation();
            // .attr() thay vì .data(): mã sự kiện có thể toàn chữ số, jQuery sẽ ép kiểu
            const eventCode = String($(this).attr('data-event-code') || '');

            function done() {
                showToast('Đã gỡ sự kiện khỏi danh sách.', 'success');
                renderSavedEvents();
            }
            if (AppAuth.isLoggedIn()) {
                $.ajax({
                    url: `/api/my-events/${encodeURIComponent(eventCode)}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders(),
                    success: done,
                    error: function () {
                        showToast('Không gỡ được sự kiện, vui lòng thử lại.', 'error');
                    }
                });
            } else {
                removeEventCodeFromLocalStorage(eventCode);
                done();
            }
        });
```

Trong handler `.delete-event-btn` hiện có: xóa dòng `removeEventCodeFromLocalStorage(eventCode);` + comment trên nó (server CASCADE dọn saved_events; nút này giờ chỉ hiện cho owner đã đăng nhập). Đồng thời đổi `const eventCode = $(this).data('event-code');` thành `const eventCode = String($(this).attr('data-event-code') || '');` (tránh jQuery ép kiểu mã toàn chữ số — cùng lý do commit 61782bd).

- [ ] **Step 7: Syntax check + smoke test tay**

```bash
node --check static/app.js
```

Smoke test trong browser (server local đang chạy): mở `http://localhost:5002`, đăng nhập, tạo event → mở "Sự Kiện Của Tôi" thấy event với nút thùng rác; mở event của tài khoản khác qua link (hoặc kiểm tra ở chế độ ẩn danh danh sách local). Nếu không tiện browser, tối thiểu xác nhận qua curl: `curl -s localhost:5002/api/my-events` → 401 JSON tiếng Việt.

- [ ] **Step 8: Commit**

```bash
git add static/app.js
git commit -m "feat: Sự Kiện Của Tôi lưu theo tài khoản — migrate localStorage, nút gỡ khỏi danh sách

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + kiểm tra tổng + hướng dẫn deploy

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:** không — task tài liệu + verification cuối.

- [ ] **Step 1: Cập nhật `CLAUDE.md`**

- **Storage model**: thêm câu sau bullet `event_collaborators`: `Bảng saved_events (user_id, event_id): event user LƯU vào "Sự Kiện Của Tôi" — bookmark theo tài khoản, không mang quyền.`
- **Auth model**: viết lại các bullet nói về `edit_key`/`X-Edit-Key`/adopt/legacy-NULL-key thành mô hình mới (3 nguồn quyền: owner JWT, event_collaborators, share_access/share_role; event không chủ mặc định ai đăng nhập cũng sửa/xóa; POST không trả edit_key; GET không nhận X-Edit-Key; sharing chặn restricted cho event không chủ; my-events = sở hữu ∪ được mời ∪ đã lưu, kèm owned; POST /api/my-events/save + DELETE /api/my-events/<code>). Ghi rõ: `Link cũ /?event_code=X&key=... vẫn mở được — tham số key bị bỏ qua.`
- **Frontend**: cập nhật mô tả localStorage: `savedEventCodes` CHỈ dùng khi chưa đăng nhập (đăng nhập → lưu theo tài khoản, migrate một lần rồi xóa local); XÓA nhắc đến `eventEditKeys`.
- **Share links**: bỏ câu "Link cũ `/?event_code=X&key=<edit_key>` vẫn được tôn trọng (edit_key giữ nguyên vai trò)" → thay bằng ghi chú key bị bỏ qua.

- [ ] **Step 2: Cập nhật `CHANGELOG.md`**

Thêm entry mới trên cùng (theo format entry hiện có trong file):

```markdown
## 2026-08-12 — "Sự Kiện Của Tôi" theo tài khoản + bỏ edit key

- Danh sách "Sự Kiện Của Tôi" lưu theo tài khoản (bảng `saved_events`) — đổi máy vẫn thấy;
  danh sách trên máy được tự chuyển lên tài khoản ở lần đăng nhập tới.
- Nút mới "Gỡ khỏi danh sách" cho event không thuộc sở hữu; nút Xóa chỉ còn cho owner.
- BỎ cơ chế edit key: quyền chỉ còn chủ sở hữu / người được mời / chế độ chia sẻ
  (kiểu Google Docs). Link cũ có `&key=` vẫn mở được — tham số bị bỏ qua; ai đang
  sửa nhờ key (không phải owner/không được mời) cần được owner mời hoặc bật
  "ai có link đều chỉnh sửa".
- Event không có chủ sở hữu (tạo trước khi có đăng nhập): mặc định ai đăng nhập
  cũng sửa/xóa được; không đặt được chế độ Hạn chế.
```

- [ ] **Step 3: Verification tổng**

```bash
cd /Users/thuanmt/code/chia-tien-nhom-flask
python3 -m py_compile vercel_app.py migrate_to_supabase.py test_api.py
node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js
node test_split.js
python3 test_event_store.py
python3 test_supabase_auth.py
python3 test_revision_diff.py
lsof -ti:5002 | xargs kill 2>/dev/null; sleep 1
python3 vercel_app.py > /private/tmp/claude-501/-Users-thuanmt-code-chia-tien-nhom-flask/dad4bfde-4586-433e-a08c-892c33115d2e/scratchpad/server.log 2>&1 &
sleep 3
python3 test_api.py
grep -rn "edit_key\|X-Edit-Key\|editKey\|EditKey" vercel_app.py static/app.js templates/index.html schema.sql || echo "SẠCH (trừ test_api.py assert phủ định + schema DROP line)"
```

Expected: tất cả pass; grep chỉ còn khớp ở `schema.sql` (dòng `DROP COLUMN IF EXISTS edit_key` + comment) — `vercel_app.py`, `static/app.js`, `templates/index.html` phải sạch.

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: cập nhật CLAUDE.md/CHANGELOG — Sự Kiện Của Tôi theo tài khoản, bỏ edit key

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Ghi chú deploy cho user (trong báo cáo cuối, không phải code)**

Thứ tự bắt buộc:
1. `git push` → Vercel deploy code mới (code mới chạy được dù cột `edit_key` còn hay mất).
2. SAU khi deploy xong: `psql "$DATABASE_URL" -f schema.sql` — lúc này mới drop cột `edit_key`.
3. Không có bước rollback cho drop cột — nhắc lại đánh đổi đã duyệt trong spec.
