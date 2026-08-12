# Đồng bộ "Sự Kiện Của Tôi" theo tài khoản + bỏ cơ chế edit key

**Ngày:** 2026-08-12 · **Trạng thái:** Đã duyệt (user chốt: bỏ hẳn edit key; event không chủ sở hữu mặc định cho sửa)

## Bối cảnh & mục tiêu

Danh sách "Sự Kiện Của Tôi" hiện là hợp của: (1) event user sở hữu — đã theo tài khoản
qua `GET /api/my-events`; (2) `savedEventCodes` trong localStorage — event user mở/được
chia sẻ, chỉ nằm trên máy. `eventEditKeys` (khóa sửa từng event) cũng chỉ nằm trên máy.

Mục tiêu:
1. Danh sách "Sự Kiện Của Tôi" lưu theo tài khoản Supabase — đổi máy vẫn thấy.
2. Bỏ hẳn cơ chế `edit_key` để mô hình quyền chỉ còn kiểu Google Docs
   (owner / người được mời đích danh / chế độ chia sẻ theo link).

## Phần A — Bỏ cơ chế edit key

### Mô hình quyền mới

Nguồn quyền chỉ còn: `owner_id` (JWT) · `event_collaborators` (viewer/editor) ·
`share_access`/`share_role` trên event. Mọi thao tác ghi vẫn yêu cầu đăng nhập
(401 khi thiếu JWT; 403 khi thiếu quyền).

| Hành động | Ai được phép |
|---|---|
| Xem (GET) | `share_access='link'`: ai cũng xem · `'restricted'`: owner + collaborator (mọi vai trò). **Event không chủ (`owner_id IS NULL`): luôn xem được** (bỏ qua share_access) |
| Sửa nội dung, đổi sharing | owner · collaborator `editor` · link-editor (`link`+`editor`) · **event không chủ: ai đăng nhập cũng sửa được** |
| Xóa event | owner · **event không chủ: ai đăng nhập cũng xóa được** (giữ hành vi legacy; link-editor và collaborator editor vẫn KHÔNG xóa được event có chủ) |
| Xem lịch sử / khôi phục | theo quyền sửa (như hiện tại, chỉ bỏ nhánh key) |

Guard bổ sung: `PUT /api/events/<code>/sharing` từ chối đặt `share_access='restricted'`
cho event không chủ (nếu cho phép thì không ai xem được nữa) — 400 với message tiếng Việt.

### Thay đổi backend (`vercel_app.py`)

- `_check_edit_permission(cursor, event_code, allow_link_editor=True)`:
  bỏ tham số `adopt_key`, bỏ toàn bộ nhánh so `X-Edit-Key`/adopt. Thêm nhánh:
  `owner_id IS NULL` → `'ok'`.
- Bỏ helper `_provided_edit_key()` và mọi chỗ đọc header `X-Edit-Key`.
- `POST /api/events`: không sinh, không lưu, không trả `edit_key`.
- `GET /api/events/<code>`: bỏ `key_ok`; `has_permission = is_owner or link_editor
  or collab_role=='editor' or owner_id IS NULL`; restricted chỉ chặn khi có chủ.
- `DELETE`: quyền = owner hoặc event không chủ (vẫn `allow_link_editor=False`).
- Revisions/restore: như cũ, chỉ mất nhánh key.

### Thay đổi schema (`schema.sql`, idempotent)

- Xóa cột khỏi `CREATE TABLE events`; thêm dòng migration
  `ALTER TABLE events DROP COLUMN IF EXISTS edit_key;`.
- `migrate_to_supabase.py`: bỏ `edit_key` khỏi INSERT (script lịch sử, giữ chạy được).

### Thay đổi frontend (`static/app.js`)

- Xóa: map `eventEditKeys` trong localStorage, `setEditKey`, `getOrCreateEditKey`,
  mọi header `X-Edit-Key`, nhánh đọc `&key=` từ URL (link cũ có `&key=` vẫn mở
  bình thường — tham số bị bỏ qua).
- `can_edit`/`is_owner`/`login_required_to_edit` từ server vẫn là nguồn sự thật
  duy nhất cho UI — không đổi.

### Đánh đổi chấp nhận

Người đang giữ link `&key=` cho event **có chủ** (không phải owner, không được mời,
event không ở chế độ link-editor) mất quyền sửa; event Hạn chế đang xem bằng key mất
quyền xem. Khắc phục: owner mời đích danh hoặc bật link-editor. User đã chấp nhận.

## Phần B — Danh sách "Sự Kiện Của Tôi" theo tài khoản

### Schema

```sql
CREATE TABLE IF NOT EXISTS saved_events (
    user_id  uuid NOT NULL,
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    saved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_events_user ON saved_events (user_id);
ALTER TABLE saved_events ENABLE ROW LEVEL SECURITY;  -- không policy, như các bảng khác
```

Event bị xóa → dòng saved_events mất theo (CASCADE). Tối đa **200 saved/user**
(vượt → bỏ qua phần thừa khi bulk-save, message không cần).

### API

- `GET /api/my-events` (JWT) — mở rộng thành hợp `sở hữu ∪ được mời ∪ đã lưu`,
  dedup theo event, sắp theo `updated_at DESC`, mỗi phần tử thêm cờ `owned` (bool).
  Shape: `{success, events: [{event_code, title, updated_at, owned}]}`.
- `POST /api/my-events/save` (JWT) — body `{codes: [<=50 mã]}`; validate như lookup;
  chỉ insert mã tồn tại, `ON CONFLICT DO NOTHING`, tôn trọng cap 200; trả
  `{success: true}`. Dùng cho cả lưu một mã lẫn migration từ localStorage.
- `DELETE /api/my-events/<event_code>` (JWT) — xóa dòng saved của chính user
  (không đụng event). Trả `{success: true}` kể cả khi không có dòng nào.
- Không ghi revision cho save/unsave (không phải thay đổi trên event).
- Rate limit: cùng mức `30 per minute; 500 per day` như my-events hiện tại.

### Frontend (`static/app.js`)

- **Đã đăng nhập**: mở event có quyền sửa (`allowEdit`) → `POST /api/my-events/save`
  (idempotent) thay vì ghi localStorage. `renderSavedEvents` chỉ dùng
  `GET /api/my-events` (không gộp localStorage nữa) rồi đưa các mã vào
  `POST /api/events/lookup` lấy chi tiết như cũ (slice 50). Cờ `owned` từ my-events
  merge vào item theo `event_code`.
- **Migration một lần**: khi AppAuth sẵn sàng và đã đăng nhập (hoặc vừa đăng nhập
  qua `appauth:change`), nếu `savedEventCodes` local không rỗng → bulk save lên
  tài khoản (chia lô 50) → thành công thì XÓA key `savedEventCodes` khỏi
  localStorage (tránh event đã gỡ trên máy khác bị "hồi sinh" ở lần merge sau).
- **Chưa đăng nhập**: localStorage như cũ (chỉ phục vụ xem; empty-state giữ chữ
  "trên máy này", còn khi đăng nhập đổi thành "trong tài khoản của bạn").
- **Nút xóa trong danh sách** tách hai hành vi theo cờ `owned`:
  - owner → "Xóa sự kiện" (DELETE /api/events/<code>, confirm như cũ);
  - không owner (đăng nhập) → "Gỡ khỏi danh sách" (DELETE /api/my-events/<code>);
  - chưa đăng nhập → gỡ khỏi localStorage.
- Dọn code: `saveEventCodeToLocalStorage`/`removeEventCodeFromLocalStorage` chỉ còn
  dùng cho nhánh chưa đăng nhập.

### Không làm (YAGNI)

- Không đồng bộ `bankInfo`, `currentEventCode`, draft đang mở.
- Không có UI "lưu event này" thủ công — giữ trigger tự động khi mở event sửa được.
- Không migration server-side cho eventEditKeys (bỏ hẳn theo Phần A).

## Kiểm thử

- `test_api.py`: bỏ/viết lại các test edit-key (48 chỗ tham chiếu) theo mô hình mới;
  thêm test: my-events trả saved+collab+owned flag; save/unsave; event không chủ
  cho sửa/xóa khi đăng nhập; sharing từ chối restricted cho event không chủ;
  link `&key=` cũ vẫn GET được.
- Unit test thuần (`test_split.js`, `test_event_store.py`, …) không đổi.
- `node --check` các file JS sau khi sửa.

## Rủi ro

- Dữ liệu: DROP COLUMN edit_key là một chiều — chạy schema.sql lên prod là mất key
  (chấp nhận, đã duyệt).
- Event không chủ hiện hữu trên prod trở thành "ai đăng nhập cũng sửa/xóa được" —
  đúng yêu cầu, nhưng cần nêu trong CHANGELOG.
