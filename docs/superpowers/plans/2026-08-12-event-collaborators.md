# Thêm người có quyền truy cập (event collaborators) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chủ sở hữu thêm người cụ thể (qua email/username) vào event với vai trò viewer/editor riêng từng người — người được mời truy cập được event kể cả ở chế độ Hạn chế (kiểu Google Docs).

**Architecture:** Bảng mới `event_collaborators(event_id, user_id, role)`; identifier resolve server-side qua `auth.users`/`user_profiles`; quyền CỘNG DỒN vào `_check_edit_permission` + GET event + lookup. 3 API owner-only (GET/POST upsert/DELETE), mỗi thay đổi ghi revision kind `share` (tái dùng hạ tầng lịch sử chỉnh sửa). UI: phần "Những người có quyền truy cập" trong `#shareEventModal`, chỉ hiện khi `is_owner` (cờ mới trong GET event).

**Tech Stack:** Flask + psycopg2 + Supabase (đã có), jQuery + Bootstrap 5 (đã có). Không thêm dependency.

**Spec:** `docs/superpowers/specs/2026-08-12-event-collaborators-design.md` — đọc trước khi làm.

## Global Constraints

- UI text, comment, error message tiếng Việt (quy ước repo).
- XSS: mọi render dữ liệu user-controlled (`display` = username tự đặt hoặc email) qua `escapeHtml()`/`.text()`.
- Lỗi nội bộ qua `_server_error()`; broad except re-raise `HTTPException` trước; 401 = chưa đăng nhập, 403 = không có quyền.
- 3 API collaborators đều **owner-only**: 401 → 404 (event không tồn tại) → 403 `"Chỉ chủ sở hữu mới quản lý được người có quyền truy cập."` (kể cả event legacy owner_id NULL).
- Quyền cộng dồn: collaborator-editor sửa nội dung + đổi /sharing được, nhưng KHÔNG xóa event (đi cùng cờ `allow_link_editor`).
- `MAX_COLLABORATORS = 50`; vượt → 400. Role chỉ `'viewer'|'editor'`.
- POST upsert no-op (đã có đúng role) → success, KHÔNG ghi revision.
- POST/DELETE collaborators KHÔNG bump `updated_at`; ghi revision kind `share` trong CÙNG transaction (pattern `update_sharing`).
- GET `/api/events/<code>` thêm cờ `is_owner`; không bao giờ trả `edit_key`.
- `#confirmModal` giữ vị trí CUỐI trong DOM; không thêm `saveEvent` call mới.
- Test là plain script (`python3 test_api.py` cần server + Supabase thật; `.env` repo root).
- `requirements.txt`/`api/requirements.txt` không đổi (không dep mới).

---

### Task 1: Bảng `event_collaborators` trong schema

**Files:**
- Modify: `schema.sql` (thêm sau bảng `event_revisions`, index vào phần INDEX, RLS vào cuối)

**Interfaces:**
- Produces: bảng `event_collaborators(event_id uuid FK events, user_id uuid, role text, added_by uuid, created_at timestamptz, PK(event_id, user_id))` — Task 2-4 query bảng này.

- [ ] **Step 1: Thêm bảng vào `schema.sql`**

Sau block `event_revisions` (trước phần `CREATE INDEX`):

```sql
-- Người được mời đích danh (kiểu "Những người có quyền truy cập" của Google Docs).
-- Quyền CỘNG DỒN với quyền chung theo link + edit_key; chỉ owner quản lý danh sách.
-- user_id/added_by là user Supabase Auth — không FK auth.users (giống owner_id)
-- để schema chạy được trên Postgres thường khi dev/test.
CREATE TABLE IF NOT EXISTS event_collaborators (
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL,
    role       text NOT NULL DEFAULT 'viewer', -- 'viewer' | 'editor'
    added_by   uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);
```

Vào phần INDEX (cạnh các `CREATE INDEX` khác):

```sql
CREATE INDEX IF NOT EXISTS idx_event_collaborators_user ON event_collaborators (user_id);
```

Vào phần RLS cuối file:

```sql
ALTER TABLE event_collaborators ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Áp schema lên DB**

Máy này KHÔNG có `psql` — áp bằng psycopg2 (đã dùng cách này cho event_revisions):

```bash
python3 - <<'EOF'
import os
from dotenv import load_dotenv
load_dotenv('.env')
import psycopg2
conn = psycopg2.connect(os.environ['DATABASE_URL'], connect_timeout=10)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute(open('schema.sql').read())
    cur.execute("SELECT to_regclass('public.event_collaborators')")
    print('event_collaborators =', cur.fetchone()[0])
conn.close()
EOF
```

Expected: `event_collaborators = event_collaborators`. Nếu không nối được DB: báo rõ trong report — Task 4 (integration) sẽ không chạy được.

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "feat: bảng event_collaborators — người được mời đích danh"
```

---

### Task 2: Tích hợp quyền — `_collaborator_role`, `_check_edit_permission`, GET event, lookup

**Files:**
- Modify: `vercel_app.py` — thêm helper trước `_check_edit_permission` (~dòng 87), sửa `_check_edit_permission`, sửa `get_event` (~dòng 490-536)
- Modify: `event_store.py` — `load_events_summary` (~dòng 343)

**Interfaces:**
- Consumes: bảng `event_collaborators` (Task 1); `request_user_id` (sẵn có).
- Produces: `_collaborator_role(cursor, event_id, user_id) -> 'viewer'|'editor'|None` (Task 3 KHÔNG dùng — API collab dùng `_require_owner` riêng); GET event trả thêm `is_owner: bool` (Task 5 frontend đọc); lookup hiện event restricted cho collaborator.

- [ ] **Step 1: Thêm helper `_collaborator_role`**

Chèn NGAY TRƯỚC `def _check_edit_permission(...)`:

```python
def _collaborator_role(cursor, event_id, user_id):
    """Vai trò được mời đích danh ('viewer'/'editor') của user trên event, None nếu không.

    Chấp nhận cả cursor thường lẫn RealDictCursor (get_event dùng dict cursor)."""
    if not user_id:
        return None
    cursor.execute(
        'SELECT role FROM event_collaborators WHERE event_id = %s AND user_id = %s::uuid',
        (event_id, user_id),
    )
    row = cursor.fetchone()
    if row is None:
        return None
    return row['role'] if isinstance(row, dict) else row[0]
```

- [ ] **Step 2: `_check_edit_permission` — nhánh collaborator-editor**

Chèn sau block owner check (sau `return 'ok', event_id, updated_at` của owner, trước comment "Chia sẻ kiểu Google Docs"):

```python
    # Người được mời đích danh vai trò "người chỉnh sửa": sửa nội dung + đổi
    # chia sẻ được, nhưng không xóa event (đi cùng cờ allow_link_editor, giống
    # link-editor — DELETE gọi với allow_link_editor=False)
    if allow_link_editor and user_id and _collaborator_role(cursor, event_id, user_id) == 'editor':
        return 'ok', event_id, updated_at
```

Cập nhật docstring của hàm: thêm dòng `HOẶC là collaborator vai trò 'editor' (bảng event_collaborators, trừ DELETE)` vào đoạn liệt kê nguồn quyền.

- [ ] **Step 3: `get_event` — restricted mở cho collaborator + cờ `is_owner`**

Thay block (hiện tại ở ~dòng 494-503):

```python
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        key_ok = bool(stored_key and provided and hmac.compare_digest(stored_key, provided))

        # Chế độ "Hạn chế": chỉ owner hoặc người cầm edit_key xem được
        if event['share_access'] == 'restricted' and not (is_owner or key_ok):
```

bằng:

```python
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        key_ok = bool(stored_key and provided and hmac.compare_digest(stored_key, provided))
        collab_role = _collaborator_role(cursor, event['id'], user_id)

        # Chế độ "Hạn chế": owner / người cầm edit_key / người được mời đích danh
        if event['share_access'] == 'restricted' and not (is_owner or key_ok or collab_role):
```

Thay dòng `has_permission = is_owner or key_ok or (not stored_key) or link_editor` bằng:

```python
        has_permission = (is_owner or key_ok or (not stored_key) or link_editor
                          or collab_role == 'editor')
```

Trong dict response, thêm ngay sau `'can_edit': can_edit,`:

```python
                'is_owner': is_owner,
```

- [ ] **Step 4: `load_events_summary` — restricted hiện với collaborator**

Trong `event_store.py`, thay:

```python
    cursor.execute(
        '''SELECT id, event_code, title, updated_at FROM events
           WHERE event_code = ANY(%s)
             AND (share_access <> 'restricted' OR owner_id = %s::uuid)''',
        (codes, viewer_user_id),
    )
```

bằng:

```python
    cursor.execute(
        '''SELECT id, event_code, title, updated_at FROM events
           WHERE event_code = ANY(%s)
             AND (share_access <> 'restricted' OR owner_id = %s::uuid
                  OR EXISTS (SELECT 1 FROM event_collaborators c
                             WHERE c.event_id = events.id AND c.user_id = %s::uuid))''',
        (codes, viewer_user_id, viewer_user_id),
    )
```

Và cập nhật docstring của hàm: `'restricted' chỉ trả về cho owner HOẶC người được mời đích danh (event_collaborators)`.

- [ ] **Step 5: Syntax check + test thuần**

Run: `python3 -c "import vercel_app; print('OK')" && python3 test_event_store.py && python3 test_revision_diff.py && python3 test_supabase_auth.py`
Expected: `OK` + tất cả pass. (Hành vi mới test ở Task 4 integration.)

- [ ] **Step 6: Commit**

```bash
git add vercel_app.py event_store.py
git commit -m "feat: quyền cộng dồn cho người được mời — _check_edit_permission, GET (is_owner), lookup"
```

---

### Task 3: API collaborators — GET / POST upsert / DELETE (owner-only)

**Files:**
- Modify: `vercel_app.py` — thêm hằng + 3 helper sau `_SHARE_LABEL` (~dòng 161); thêm 3 route sau `restore_event`, trước `delete_event`

**Interfaces:**
- Consumes: `request_user_claims`, `_actor_info`, `_load_full_document`, `record_revision`, `uuid` (đều sẵn có sau feature lịch sử).
- Produces:
  - `GET /api/events/<code>/collaborators` → `{success, collaborators: [{user_id, display, role}]}`
  - `POST /api/events/<code>/collaborators` body `{identifier, role}` → `{success, collaborator: {user_id, display, role}}`
  - `DELETE /api/events/<code>/collaborators/<user_id>` → `{success: true}`
  (Task 4 test, Task 5 frontend gọi đúng shape này.)

- [ ] **Step 1: Thêm hằng + helper (sau `_SHARE_LABEL`)**

```python
# Người được mời đích danh — chỉ owner quản lý danh sách
_MAX_COLLABORATORS = 50
_COLLAB_ROLE_LABEL = {'viewer': 'người xem', 'editor': 'người chỉnh sửa'}


def _require_owner(cursor, event_code, claims):
    """Chỉ owner quản lý danh sách người có quyền truy cập.

    Trả (status, event_id, owner_id) với status 'not_found' | 'forbidden' | 'ok'.
    Event legacy (owner_id NULL) → 'forbidden' (không có owner để quản lý)."""
    cursor.execute('SELECT id, owner_id FROM events WHERE event_code = %s', (event_code,))
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, owner_id = row
    user_id = (claims or {}).get('sub')
    if not (owner_id and user_id and str(owner_id) == user_id):
        return 'forbidden', event_id, owner_id
    return 'ok', event_id, owner_id


def _resolve_identifier(cursor, identifier):
    """Email (chứa '@') hoặc username → (user_id str, email) từ Supabase Auth.

    (None, None) nếu không có tài khoản. Cần schema auth của Supabase —
    precedent: /api/auth/login đã JOIN auth.users."""
    if '@' in identifier:
        cursor.execute('SELECT id, email FROM auth.users WHERE lower(email) = lower(%s)',
                       (identifier,))
    else:
        cursor.execute(
            '''SELECT p.user_id, u.email FROM user_profiles p
               JOIN auth.users u ON u.id = p.user_id
               WHERE p.username = %s''',
            (identifier.lower(),),
        )
    row = cursor.fetchone()
    return (str(row[0]), row[1]) if row else (None, None)


def _collaborator_display(cursor, user_id, email=None):
    """Tên hiển thị của một user: username nếu có, không thì email."""
    cursor.execute('SELECT username FROM user_profiles WHERE user_id = %s::uuid', (user_id,))
    row = cursor.fetchone()
    if row and row[0]:
        return row[0]
    if email is None:
        cursor.execute('SELECT email FROM auth.users WHERE id = %s::uuid', (user_id,))
        row = cursor.fetchone()
        email = row[0] if row else None
    return email or ''
```

- [ ] **Step 2: Route GET danh sách**

Chèn sau `restore_event`, trước `delete_event`:

```python
@app.route('/api/events/<event_code>/collaborators')
@limiter.limit('60 per minute')
def list_collaborators(event_code):
    """Danh sách người được mời — chỉ owner xem được."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401

        conn = get_db_connection()
        cursor = conn.cursor()
        status, event_id, _owner_id = _require_owner(cursor, event_code, claims)
        if status == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if status == 'forbidden':
            cursor.close()
            return jsonify({'success': False,
                            'error': 'Chỉ chủ sở hữu mới quản lý được người có quyền truy cập.'}), 403

        cursor.execute(
            '''SELECT c.user_id, c.role, p.username, u.email
               FROM event_collaborators c
               LEFT JOIN user_profiles p ON p.user_id = c.user_id
               LEFT JOIN auth.users u ON u.id = c.user_id
               WHERE c.event_id = %s ORDER BY c.created_at''',
            (event_id,),
        )
        collaborators = [
            {'user_id': str(r[0]), 'display': r[2] or r[3] or '', 'role': r[1]}
            for r in cursor.fetchall()
        ]
        cursor.close()
        return jsonify({'success': True, 'collaborators': collaborators})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 3: Route POST thêm/đổi vai trò (upsert)**

```python
@app.route('/api/events/<event_code>/collaborators', methods=['POST'])
@limiter.limit('20 per minute; 200 per day')
def add_collaborator(event_code):
    """Thêm người theo email/username, hoặc đổi vai trò người đã có (upsert) — chỉ owner.

    Lưu ý riêng tư: response tiết lộ email/username có tài khoản hay không —
    chấp nhận (cần đăng nhập + là owner + rate limit; Google Docs tương tự)."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401

        body = request.get_json(silent=True) or {}
        identifier = body.get('identifier')
        role = body.get('role')
        if (not isinstance(identifier, str) or not identifier.strip()
                or len(identifier) > 254 or role not in ('viewer', 'editor')):
            return jsonify({'success': False, 'error': 'Dữ liệu không hợp lệ.'}), 400
        identifier = identifier.strip()

        conn = get_db_connection()
        cursor = conn.cursor()
        status, event_id, owner_id = _require_owner(cursor, event_code, claims)
        if status == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if status == 'forbidden':
            cursor.close()
            return jsonify({'success': False,
                            'error': 'Chỉ chủ sở hữu mới quản lý được người có quyền truy cập.'}), 403

        target_id, target_email = _resolve_identifier(cursor, identifier)
        if not target_id:
            cursor.close()
            return jsonify({'success': False,
                            'error': 'Không tìm thấy tài khoản với email/username này.'}), 404
        if str(owner_id) == target_id:
            cursor.close()
            return jsonify({'success': False, 'error': 'Chủ sở hữu đã có toàn quyền.'}), 400

        cursor.execute(
            'SELECT role FROM event_collaborators WHERE event_id = %s AND user_id = %s::uuid',
            (event_id, target_id),
        )
        existing = cursor.fetchone()
        display = _collaborator_display(cursor, target_id, target_email)

        if existing and existing[0] == role:
            # No-op: đã có đúng vai trò này — không ghi lịch sử
            cursor.close()
            return jsonify({'success': True,
                            'collaborator': {'user_id': target_id, 'display': display, 'role': role}})

        if not existing:
            cursor.execute('SELECT count(*) FROM event_collaborators WHERE event_id = %s', (event_id,))
            if cursor.fetchone()[0] >= _MAX_COLLABORATORS:
                cursor.close()
                return jsonify({'success': False,
                                'error': f'Tối đa {_MAX_COLLABORATORS} người mỗi sự kiện.'}), 400

        role_label = _COLLAB_ROLE_LABEL[role]
        text = (f"Đổi vai trò của '{display}' thành {role_label}" if existing
                else f"Thêm quyền truy cập cho '{display}' ({role_label})")
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                '''INSERT INTO event_collaborators (event_id, user_id, role, added_by)
                   VALUES (%s, %s::uuid, %s, %s::uuid)
                   ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role''',
                (event_id, target_id, role, claims['sub']),
            )
            # Không bump updated_at (như /sharing); ghi lịch sử trong cùng transaction
            snapshot = _load_full_document(conn, cursor, event_id)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'share',
                            [{'a': 'update', 'o': f'collab:{target_id}', 't': text}], snapshot)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        return jsonify({'success': True,
                        'collaborator': {'user_id': target_id, 'display': display, 'role': role}})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 4: Route DELETE gỡ quyền**

```python
@app.route('/api/events/<event_code>/collaborators/<user_id>', methods=['DELETE'])
@limiter.limit('20 per minute; 200 per day')
def remove_collaborator(event_code, user_id):
    """Gỡ một người khỏi danh sách — chỉ owner."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        try:
            uuid.UUID(str(user_id))
        except (ValueError, TypeError):
            return jsonify({'success': False,
                            'error': 'Không tìm thấy người này trong danh sách.'}), 404

        conn = get_db_connection()
        cursor = conn.cursor()
        status, event_id, _owner_id = _require_owner(cursor, event_code, claims)
        if status == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if status == 'forbidden':
            cursor.close()
            return jsonify({'success': False,
                            'error': 'Chỉ chủ sở hữu mới quản lý được người có quyền truy cập.'}), 403

        display = _collaborator_display(cursor, user_id)
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                '''DELETE FROM event_collaborators
                   WHERE event_id = %s AND user_id = %s::uuid RETURNING role''',
                (event_id, user_id),
            )
            if cursor.fetchone() is None:
                cursor.execute('ROLLBACK')
                cursor.close()
                return jsonify({'success': False,
                                'error': 'Không tìm thấy người này trong danh sách.'}), 404
            snapshot = _load_full_document(conn, cursor, event_id)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'share',
                            [{'a': 'remove', 'o': f'collab:{user_id}',
                              't': f"Xóa quyền truy cập của '{display}'"}], snapshot)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        return jsonify({'success': True})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

Lưu ý: `cursor.close()` trong nhánh 404 giữa transaction đã ROLLBACK trước đó — sau block này KHÔNG chạy tiếp xuống `finally` của transaction (return nằm trong `try` → `finally: cursor.close()` sẽ chạy và close lần 2 — psycopg2 close 2 lần là no-op an toàn, giữ nguyên cho đơn giản).

- [ ] **Step 5: Syntax check**

Run: `python3 -c "import vercel_app; print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add vercel_app.py
git commit -m "feat: API quản lý người có quyền truy cập (thêm/đổi vai trò/gỡ, owner-only)"
```

---

### Task 4: `test_api.py` — test collaborators end-to-end + chạy integration

**Files:**
- Modify: `test_api.py` — sửa `create_test_user` trả thêm email; thêm `test_collaborators(token, owner_email)`; cập nhật `main()` và các call site

**Interfaces:**
- Consumes: toàn bộ API Task 2-3 trên server thật.

- [ ] **Step 1: `create_test_user` trả thêm email**

Đổi dòng cuối hàm `create_test_user` từ `return user_id, r.json()['access_token']` thành:

```python
    return user_id, r.json()['access_token'], email
```

Cập nhật MỌI call site (4 chỗ) — thêm biến thứ ba:
- `main()`: `user_id, token, owner_email = create_test_user()`
- `test_update_event` (wrapper): `user2_id, token2, _email2 = create_test_user()`
- `test_auth_matrix`: `user2_id, token2, _email2 = create_test_user()`
- `test_revisions_and_restore` (bước 6): `user2_id, token2, _email2 = create_test_user()`

- [ ] **Step 2: Thêm `test_collaborators` (sau `test_revisions_and_restore`)**

```python
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
```

Trong `main()`, gọi ngay sau `test_revisions_and_restore`:

```python
        if not test_collaborators(token, owner_email):
            return
```

- [ ] **Step 3: Chạy integration**

Cần `.env` + schema Task 1 đã áp. Start server nền (`python3 vercel_app.py`), đợi ~3s, chạy `python3 test_api.py`, kill server.
Expected: `🎉 All tests passed!`
Không chạy được (thiếu DB/mạng): báo rõ, KHÔNG claim pass.

- [ ] **Step 4: Commit**

```bash
git add test_api.py
git commit -m "test: collaborators end-to-end — quyền cộng dồn, owner-only, resolve email/username"
```

---

### Task 5: Frontend — phần "Những người có quyền truy cập" trong modal Chia sẻ

**Files:**
- Modify: `templates/index.html` — trong `#shareEventModal` modal-body (~dòng 394), TRÊN label "Quyền truy cập chung"
- Modify: `static/app.js` — state (~dòng 38), `createNewEvent` (~530), `loadEventFromServer` (~806), saveEvent POST success (~741), block chia sẻ (~2848-2907)
- Modify: `static/sw.js` — dòng 1

**Interfaces:**
- Consumes: `is_owner` từ GET event (Task 2); 3 API collaborators (Task 3); helper sẵn có `escapeHtml`, `showToast`, `showConfirm`, `AppAuth.authHeaders/showLoginModal`.

- [ ] **Step 1: Markup — chèn vào `#shareEventModal` modal-body, TRƯỚC `<label class="form-label fw-semibold">Quyền truy cập chung</label>`**

```html
                <div id="collabSection" class="mb-3 d-none">
                    <label class="form-label fw-semibold">Những người có quyền truy cập</label>
                    <div class="d-flex gap-2 mb-2">
                        <input type="text" class="form-control" id="collabIdentifierInput"
                               placeholder="Email hoặc username" autocomplete="off">
                        <select class="form-select w-auto flex-shrink-0" id="collabRoleSelect">
                            <option value="viewer">Người xem</option>
                            <option value="editor">Người chỉnh sửa</option>
                        </select>
                        <button type="button" class="btn btn-primary flex-shrink-0" id="collabAddBtn">Thêm</button>
                    </div>
                    <div id="collabList" class="list-group list-group-flush"></div>
                    <hr>
                </div>
```

- [ ] **Step 2: State `isOwner` trong app.js**

Sau dòng `let shareRole = 'viewer';` (~dòng 38):

```js
        let isOwner = false;    // chủ sở hữu event hiện tại (quản lý người được mời)
```

Trong `createNewEvent`, sau `shareRole = 'viewer';` (~dòng 531):

```js
            isOwner = true;     // sự kiện mới do chính mình tạo
```

Trong `loadEventFromServer` success, sau `shareRole = eventData.share_role || 'viewer';` (~dòng 806):

```js
                        isOwner = !!eventData.is_owner;
```

Trong `saveEvent` nhánh POST tạo mới, trong `success` sau `lastKnownUpdatedAt = response.updated_at || null;` (~dòng 741):

```js
                            isOwner = true; // người tạo là chủ sở hữu
```

- [ ] **Step 3: JS quản lý collaborators — chèn sau `renderShareModal()` (trước `saveShareSettings`)**

```js
        // ===== Người có quyền truy cập (chỉ owner thấy/quản lý) =====
        function renderCollaborators(collaborators) {
            const $list = $('#collabList').empty();
            $list.append(`
                <div class="list-group-item d-flex justify-content-between align-items-center px-0">
                    <span><i class="fas fa-user-circle me-2 text-secondary"></i>Bạn (chủ sở hữu)</span>
                    <span class="text-muted small">Chủ sở hữu</span>
                </div>`);
            (collaborators || []).forEach(c => {
                // XSS: display là username tự đặt hoặc email — phải escape,
                // kể cả khi đưa vào data-attribute
                const safeId = escapeHtml(c.user_id);
                const safeDisplay = escapeHtml(c.display || 'Không rõ');
                $list.append(`
                    <div class="list-group-item d-flex justify-content-between align-items-center gap-2 px-0">
                        <span class="text-truncate"><i class="fas fa-user me-2 text-secondary"></i>${safeDisplay}</span>
                        <span class="d-flex align-items-center gap-1 flex-shrink-0">
                            <select class="form-select form-select-sm w-auto collab-role-select"
                                    data-identifier="${escapeHtml(c.display || '')}">
                                <option value="viewer"${c.role === 'viewer' ? ' selected' : ''}>Người xem</option>
                                <option value="editor"${c.role === 'editor' ? ' selected' : ''}>Người chỉnh sửa</option>
                            </select>
                            <button type="button" class="btn btn-sm btn-outline-danger collab-remove-btn"
                                    data-user-id="${safeId}" data-display="${escapeHtml(c.display || '')}"
                                    title="Gỡ quyền truy cập">
                                <i class="fas fa-times"></i>
                            </button>
                        </span>
                    </div>`);
            });
        }

        function loadCollaborators() {
            $.ajax({
                url: `/api/events/${currentEventCode}/collaborators`,
                headers: AppAuth.authHeaders(),
                success: function (res) {
                    if (res.success) renderCollaborators(res.collaborators || []);
                },
                error: function (xhr) {
                    if (xhr.status === 401) {
                        AppAuth.showLoginModal();
                    } else {
                        showToast('Không tải được danh sách người có quyền truy cập.', 'error');
                    }
                }
            });
        }

        function upsertCollaborator(identifier, role, onDone) {
            $.ajax({
                url: `/api/events/${currentEventCode}/collaborators`,
                method: 'POST',
                contentType: 'application/json',
                headers: AppAuth.authHeaders(),
                data: JSON.stringify({ identifier: identifier, role: role }),
                success: function () {
                    loadCollaborators();
                    if (onDone) onDone(true);
                },
                error: function (xhr) {
                    // 404/400 có message tiếng Việt cụ thể từ server
                    showToast((xhr.responseJSON && xhr.responseJSON.error)
                        || 'Không thêm được người này, vui lòng thử lại.', 'error');
                    if (xhr.status === 401) {
                        AppAuth.showLoginModal();
                    } else {
                        loadCollaborators(); // đồng bộ lại UI (ví dụ dropdown role vừa đổi hụt)
                    }
                    if (onDone) onDone(false);
                }
            });
        }

        $('#collabAddBtn').on('click', function () {
            const identifier = $('#collabIdentifierInput').val().trim();
            if (!identifier) return;
            upsertCollaborator(identifier, $('#collabRoleSelect').val(), function (ok) {
                if (ok) {
                    $('#collabIdentifierInput').val('');
                    showToast('Đã thêm quyền truy cập.', 'success');
                }
            });
        });

        // Đổi vai trò tại chỗ: display (username/email) chính là identifier hợp lệ
        $(document).on('change', '.collab-role-select', function () {
            const identifier = $(this).data('identifier');
            if (!identifier) {
                showToast('Không đổi được vai trò của người này.', 'error');
                loadCollaborators();
                return;
            }
            upsertCollaborator(identifier, $(this).val(), null);
        });

        $(document).on('click', '.collab-remove-btn', function () {
            const userId = $(this).data('user-id');
            const display = $(this).data('display') || 'người này';
            showConfirm(`Gỡ quyền truy cập của ${display}?`, function () {
                $.ajax({
                    url: `/api/events/${currentEventCode}/collaborators/${encodeURIComponent(userId)}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders(),
                    success: function () {
                        showToast('Đã gỡ quyền truy cập.', 'success');
                        loadCollaborators();
                    },
                    error: function (xhr) {
                        if (xhr.status === 401) {
                            AppAuth.showLoginModal();
                            return;
                        }
                        showToast('Không gỡ được quyền truy cập, vui lòng thử lại.', 'error');
                    }
                });
            }, { okLabel: 'Gỡ', okClass: 'btn-danger' });
        });
```

- [ ] **Step 4: Nạp danh sách khi mở modal (chỉ owner)**

Trong handler `$('#shareEventBtn').click(...)`, sau `renderShareModal();` và trước `$('#shareEventModal').modal('show');`:

```js
            $('#collabSection').toggleClass('d-none', !isOwner);
            if (isOwner) loadCollaborators();
```

(KHÔNG gọi `loadCollaborators` trong `renderShareModal` — hàm đó chạy lại mỗi lần đổi quyền-chung, danh sách người không đổi.)

- [ ] **Step 5: Bump service worker cache**

`static/sw.js` dòng 1: `'v5'` → `'v6'`.

- [ ] **Step 6: Syntax check**

Run: `node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js`
Expected: exit 0, không output.

- [ ] **Step 7: Commit**

```bash
git add templates/index.html static/app.js static/sw.js
git commit -m "feat: UI quản lý người có quyền truy cập trong modal Chia sẻ (chỉ chủ sở hữu)"
```

---

### Task 6: Tài liệu — CLAUDE.md, CHANGELOG.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Cập nhật `CLAUDE.md`**

1. Mục **Storage model**, thêm câu vào cuối đoạn mô tả bảng (trước đoạn "Lịch sử chỉnh sửa"):
   ```
   Bảng `event_collaborators` (event_id, user_id, role viewer/editor): người được mời
   đích danh — quyền CỘNG DỒN với quyền chung theo link/edit_key.
   ```
2. Mục **Auth model**, thêm bullet (sau bullet "Mọi thao tác ghi yêu cầu đăng nhập"):
   ```
   - **Người được mời đích danh** (`event_collaborators`, thêm qua email/username — resolve
     server-side qua `auth.users`/`user_profiles`): `viewer` xem được event Hạn chế; `editor`
     sửa nội dung + đổi /sharing nhưng KHÔNG xóa event. CHỈ owner quản lý danh sách
     (3 endpoint `/api/events/<code>/collaborators`, tối đa 50 người). GET event trả thêm
     `is_owner` — frontend chỉ hiện UI quản lý người cho owner. Thêm/đổi/gỡ đều ghi
     revision kind 'share'.
   ```
3. Mục **Share links & quyền truy cập**, sửa câu mô tả `restricted` từ
   `` `restricted`: GET trả 403 cho người không phải owner/không có edit_key, lookup cũng ẩn (trừ owner). ``
   thành:
   ```
   `restricted`: GET trả 403 trừ owner/người có edit_key/người được mời đích danh
   (event_collaborators); lookup cũng ẩn trừ owner và người được mời.
   ```

- [ ] **Step 2: Thêm entry `CHANGELOG.md`**

Ngay sau dòng `# Changelog` (trước entry `[1.1.0]`):

```markdown
## [1.2.0] - 2026-08-12

### Thêm mới
- ✅ Thêm người có quyền truy cập qua email/username (kiểu Google Docs): vai trò Người xem / Người chỉnh sửa riêng từng người, chỉ chủ sở hữu quản lý
- ✅ Người được mời truy cập được sự kiện ở chế độ Hạn chế; thao tác thêm/đổi vai trò/gỡ đều ghi vào lịch sử chỉnh sửa

### Sửa lỗi
- 🐛 Sự kiện Hạn chế không còn biến mất khỏi "Sự Kiện Của Tôi" của người được mời
```

- [ ] **Step 3: Chạy toàn bộ test thuần lần cuối**

Run: `python3 test_revision_diff.py && python3 test_event_store.py && python3 test_supabase_auth.py && node --check static/app.js && node --check static/sw.js`
Expected: tất cả pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: cập nhật CLAUDE.md/CHANGELOG cho người được mời đích danh"
```

---

## Ghi chú cho người thực thi

- Thứ tự task bắt buộc (2-3 sửa cùng `vercel_app.py`; 4 test hành vi 2-3; 5 cần `is_owner` của 2).
- Integration (Task 1 Step 2, Task 4 Step 3) cần `.env` + DB Supabase thật; máy không có `psql` — dùng psycopg2 như hướng dẫn.
- `_resolve_identifier`/`_collaborator_display`/GET danh sách JOIN `auth.users` — chỉ chạy trên Supabase (dev Postgres thường không có schema auth; precedent: `/api/auth/login`).
- Deploy: áp `schema.sql` lên DB production TRƯỚC khi deploy code (bảng mới, code cũ không đụng — an toàn).
