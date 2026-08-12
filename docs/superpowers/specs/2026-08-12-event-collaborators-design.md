# Thiết kế: Thêm người có quyền truy cập qua email/username (event collaborators)

**Ngày:** 2026-08-12
**Trạng thái:** Đã duyệt (brainstorming với chủ dự án)

## Mục tiêu

Kiểu Google Docs: trong modal Chia sẻ, chủ sở hữu thêm NGƯỜI CỤ THỂ (qua email hoặc
username) vào danh sách "Những người có quyền truy cập" với vai trò riêng từng người
(Người xem / Người chỉnh sửa). Người được thêm truy cập được event kể cả ở chế độ
"Hạn chế" — quyền chung theo link (`share_access`/`share_role`) giữ nguyên vai trò cũ.

## Quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Email/username chưa có tài khoản | Chỉ thêm được người ĐÃ có tài khoản — 404 "Không tìm thấy tài khoản với email/username này." Không có invite chờ. |
| Vai trò | Riêng từng người: `viewer` / `editor`. Quyền CỘNG DỒN: quyền cuối = cao nhất trong (owner, vai trò cá nhân, quyền chung theo link, edit_key). |
| Ai quản lý danh sách người | CHỈ chủ sở hữu (owner_id). Editor được mời vẫn sửa nội dung + đổi quyền-chung qua /sharing như hiện tại, nhưng không đụng danh sách người. Event legacy không có owner → không dùng được tính năng này. |
| Người được thêm tìm event thế nào | Vẫn qua link chia sẻ (app không gửi email). Sửa lookup để event Hạn chế không biến mất khỏi "Sự Kiện Của Tôi" của người được mời. Không làm mục "Được chia sẻ với tôi". |
| Hướng triển khai | Bảng `event_collaborators` + resolve identifier server-side (không JSON trên events, không RLS/PostgREST). |

## 1. Dữ liệu

Thêm vào `schema.sql` (idempotent, RLS bật không policy như các bảng khác):

```sql
CREATE TABLE IF NOT EXISTS event_collaborators (
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL,                  -- user Supabase Auth được mời (không FK auth.users, giống owner_id)
    role       text NOT NULL DEFAULT 'viewer', -- 'viewer' | 'editor'
    added_by   uuid,                           -- owner đã thêm (để trace)
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_collaborators_user ON event_collaborators (user_id);
ALTER TABLE event_collaborators ENABLE ROW LEVEL SECURITY;
```

Giới hạn: tối đa **50** collaborator/event (`MAX_COLLABORATORS = 50`) → vượt trả 400.

## 2. Tích hợp quyền (cộng dồn)

Helper mới `_collaborator_role(cursor, event_id, user_id) -> 'viewer' | 'editor' | None`.

- **`_check_edit_permission`**: sau bước owner, nếu user đăng nhập là collaborator
  `editor` VÀ `allow_link_editor=True` → `'ok'`. Nghĩa là collaborator-editor sửa được
  nội dung và đổi được quyền-chung (/sharing) nhưng KHÔNG xóa được event (DELETE gọi
  với `allow_link_editor=False` — chỉ owner/edit_key, giống link-editor hiện tại).
- **`GET /api/events/<code>`**:
  - Chế độ `restricted`: cho qua nếu owner HOẶC key đúng HOẶC là collaborator
    (viewer hay editor đều xem được).
  - `has_permission` (nguồn quyền sửa) thêm `collab_editor`; `can_edit` /
    `login_required_to_edit` giữ công thức hiện tại trên has_permission mở rộng.
  - Response thêm cờ **`is_owner`** (bool) — frontend chỉ hiện phần quản lý người
    cho owner (can_edit không phân biệt được owner với người cầm key).
- **`POST /api/events/lookup`** (`load_events_summary`): event `restricted` trả về nếu
  owner HOẶC collaborator:
  `share_access <> 'restricted' OR owner_id = %s::uuid OR EXISTS (SELECT 1 FROM
  event_collaborators c WHERE c.event_id = events.id AND c.user_id = %s::uuid)`.
  (Đây cũng là fix: hiện event Hạn chế bị prune khỏi danh sách đã lưu của người được mời.)

## 3. API mới — cả 3 đều owner-only

Thứ tự check: 401 nếu chưa đăng nhập (message pattern hiện có) → 404 nếu event không
tồn tại → 403 `"Chỉ chủ sở hữu mới quản lý được người có quyền truy cập."` nếu không
phải owner (bao gồm event legacy owner_id NULL).

### `GET /api/events/<code>/collaborators` — rate limit 60/min
Trả `{success, collaborators: [{user_id, display, role}]}`, sắp theo `created_at`.
`display` = username (từ `user_profiles`) nếu có, không thì email (JOIN `auth.users`
— precedent: route login đã JOIN auth.users; dev trên Postgres thường không có schema
auth thì các route này lỗi — chấp nhận như login).

### `POST /api/events/<code>/collaborators` — rate limit 20/min; 200/day
Body `{identifier, role}`; `role` ∈ ('viewer','editor') → sai trả 400.
- Resolve identifier (trim):
  - Có `@` → `SELECT id, email FROM auth.users WHERE lower(email) = lower(%s)`.
  - Không có `@` → `SELECT p.user_id, u.email FROM user_profiles p JOIN auth.users u
    ON u.id = p.user_id WHERE p.username = lower(%s)`.
  - Không thấy → **404** `"Không tìm thấy tài khoản với email/username này."`
- Resolve ra chính owner → **400** `"Chủ sở hữu đã có toàn quyền."`
- Đủ 50 người (và user_id chưa có trong danh sách) → **400**.
- Upsert: `INSERT ... ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role`
  — POST dùng cho cả THÊM MỚI lẫn ĐỔI VAI TRÒ (SELECT trước để biết là thêm hay đổi,
  phục vụ text lịch sử). Đã có sẵn với ĐÚNG role đó (no-op) → vẫn trả success nhưng
  KHÔNG ghi revision (tránh noise lịch sử). Trả
  `{success, collaborator: {user_id, display, role}}`.

### `DELETE /api/events/<code>/collaborators/<user_id>` — rate limit 20/min; 200/day
`user_id` không phải uuid hợp lệ hoặc không có trong danh sách → 404. Trả `{success: true}`.

Chung cho POST/DELETE:
- KHÔNG bump `updated_at` (như /sharing — tránh 409 vô cớ).
- Ghi revision kind **`share`** trong CÙNG transaction (pattern `update_sharing`,
  snapshot = document hiện tại, không squash):
  - Thêm: `"Thêm quyền truy cập cho '<display>' (người xem|người chỉnh sửa)"`
  - Đổi vai trò: `"Đổi vai trò của '<display>' thành người xem|người chỉnh sửa"`
  - Gỡ: `"Xóa quyền truy cập của '<display>'"`
- Lỗi nội bộ qua `_server_error`; re-raise `HTTPException`; message tiếng Việt.

**Ghi chú riêng tư (chấp nhận):** POST tiết lộ một email/username có tài khoản hay
không (account enumeration). Chấp nhận vì: cần đăng nhập + là owner của một event +
rate limit; Google Docs hành xử tương tự.

## 4. Frontend — trong `#shareModal`

Phần mới "Những người có quyền truy cập" đặt TRÊN "Quyền truy cập chung", **chỉ hiện
khi `is_owner`** (lưu từ GET event; người khác thấy modal như hiện tại):

- Hàng nhập: input "Email hoặc username" + select vai trò (Người xem / Người chỉnh
  sửa) + nút "Thêm" → POST; thành công → clear input + nạp lại danh sách; lỗi →
  toast message từ server (404/400) hoặc message chung.
- Danh sách (nạp bằng GET collaborators khi mở modal, chỉ khi is_owner):
  - Hàng đầu tĩnh: "Bạn (chủ sở hữu)" — không có nút.
  - Mỗi collaborator: `display` + dropdown vai trò (change → POST upsert; lỗi thì
    revert giá trị) + nút gỡ → `showConfirm` (`#confirmModal` vẫn là modal cuối DOM,
    cơ chế stack sẵn có) → DELETE → nạp lại danh sách.
- **XSS**: `display` (username tự đặt / email) render qua `escapeHtml()`.
- 401 giữa chừng → mở modal đăng nhập (pattern saveEvent); toast tương ứng.
- Người được mời: không thấy phần này; mở link event Hạn chế giờ vào được, UI
  view/edit theo `can_edit` như cũ.

## 5. Kiểm thử

`test_api.py` mở rộng — pattern user thứ hai sẵn có (`create_test_user`):

1. Owner tạo event, đặt `restricted`. User2 GET → 403, lookup không thấy.
2. Owner POST collaborator bằng **email** user2, role `viewer` → user2 GET được,
   `can_edit=false`, PUT → 403, lookup thấy event.
3. POST lại role `editor` (upsert) → user2 PUT → 200; user2 DELETE event → 403;
   user2 gọi GET/POST collaborators → 403 (không phải owner).
4. User2 đặt username (`PUT /api/profile`) → owner gỡ rồi thêm lại bằng **username**
   → resolve đúng user.
5. Identifier không tồn tại → 404; thêm chính owner → 400; role rác → 400.
6. DELETE collaborator → user2 GET restricted → 403 trở lại, lookup ẩn.
7. GET revisions (owner) có các dòng `share` tương ứng thêm/đổi/gỡ.
8. Không token → 401 cho cả 3 endpoint.

Không có unit test thuần mới (không có logic thuần mới; text lịch sử là chuỗi tĩnh).
`node --check` các file JS như quy ước; bump `CACHE_VERSION` (sw.js) vì app.js đổi.

## 6. Docs & triển khai

- `CLAUDE.md`: cập nhật mục Auth model (nguồn quyền thêm collaborator, is_owner) và
  Share links (danh sách người, owner-only) + Storage model (bảng mới).
- `CHANGELOG.md`: entry mới.
- `schema.sql` idempotent — áp lên DB production TRƯỚC khi deploy code.

## Ngoài phạm vi (đã chốt)

- Không invite chờ theo email (pending invitation).
- Không gửi email thông báo.
- Không mục "Được chia sẻ với tôi" trong /api/my-events.
- Không chuyển quyền sở hữu event.
- Người được mời không tự rời danh sách (owner gỡ).
