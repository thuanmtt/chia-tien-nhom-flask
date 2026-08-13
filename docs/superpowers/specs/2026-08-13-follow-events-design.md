# Theo dõi / Bỏ theo dõi sự kiện + icon owner — Design

**Ngày:** 2026-08-13
**Trạng thái:** Đã duyệt

## Mục tiêu

- Với sự kiện **không phải của mình** (không phải owner) và được quyền xem: người dùng
  chủ động bấm **Theo dõi** thì sự kiện mới vào "Sự Kiện Của Tôi"; **Bỏ theo dõi** để gỡ.
  Bỏ hoàn toàn hành vi auto-lưu khi mở event như hiện tại.
- Sự kiện do mình tạo (owner) có **icon vương miện** trong danh sách để dễ nhận biết.

## Bối cảnh hiện có (tận dụng, không xây mới)

- Bảng `saved_events` (user_id, event_id) — bookmark theo tài khoản, không mang quyền.
- `POST /api/my-events/save` `{codes: [...]}` — idempotent, cap 200/user → dùng làm **Theo dõi**.
- `DELETE /api/my-events/<code>` — idempotent → dùng làm **Bỏ theo dõi**.
- `GET /api/my-events` = sở hữu ∪ được mời đích danh ∪ đã lưu, kèm cờ `owned`.
- Khách (chưa đăng nhập): danh sách nằm ở localStorage `savedEventCodes`; khi đăng nhập
  `migrateLocalSavedEvents` đẩy lên tài khoản (giữ nguyên cơ chế này).

## Thay đổi backend (`vercel_app.py`)

Một bổ sung duy nhất, **không endpoint mới**:

- `GET /api/events/<event_code>` trả thêm cờ `is_saved` trong object `event`:
  - `true` nếu request có JWT hợp lệ VÀ tồn tại dòng `saved_events` (user_id, event_id).
  - `false` khi chưa đăng nhập hoặc chưa lưu.
  - Thực hiện bằng một câu `SELECT EXISTS(...)` trong cùng cursor với `_event_access`
    (chỉ chạy khi có `user_id`).

## Thay đổi frontend

### `templates/index.html`

- Thêm nút `#followEventBtn` vào `.group-actions` (cạnh nút "Chia sẻ"), class
  `btn btn-sm btn-header-action d-none` (ẩn mặc định). Nội dung do JS đặt
  (icon + chữ đổi theo trạng thái) — KHÔNG script inline (CSP).

### `static/app.js`

- **State**: biến `isSavedEvent` (boolean).
  - Đã đăng nhập: lấy từ cờ `is_saved` trong response GET event.
  - Khách: `readSavedEventCodes().includes(currentEventCode)`.
- **Hiển thị nút** (`updateFollowButton()`):
  - Hiện khi: đã tải event từ server (`currentEventCode` có thật) VÀ `!isOwner`.
  - Ẩn khi: là owner, hoặc đang ở event mới chưa lưu server.
  - Trạng thái: chưa theo dõi → `fa-bell` + "Theo dõi"; đang theo dõi →
    `fa-bell-slash` + "Bỏ theo dõi". Text qua `.text()`/DOM API an toàn.
- **Click handler**:
  - Đã đăng nhập: Theo dõi → `POST /api/my-events/save` `{codes: [code]}`;
    Bỏ theo dõi → `DELETE /api/my-events/<code>`. Thành công → đổi `isSavedEvent`,
    cập nhật nút, toast tiếng Việt ("Đã theo dõi sự kiện" / "Đã bỏ theo dõi sự kiện"),
    gọi `renderSavedEvents()` để danh sách đồng bộ. Lỗi mạng → toast lỗi, giữ nguyên trạng thái.
  - Khách: thêm/gỡ mã trong `savedEventCodes` localStorage (dùng
    `saveEventCodeToLocalStorage` / `removeEventCodeFromLocalStorage` sẵn có),
    cùng toast + cập nhật nút + `renderSavedEvents()`.
- **Bỏ auto-lưu**: xóa cả 2 chỗ gọi `rememberEvent(currentEventCode)`:
  - Trong `loadEventFromServer` (nhánh `allowEdit`).
  - Trong success của `POST /api/events` (tạo event) — thừa: tạo event bắt buộc đăng
    nhập, event sở hữu luôn hiện trong danh sách theo nhánh `owner_id` của
    `/api/my-events`, không cần dòng `saved_events`.
  - Hàm `rememberEvent` không còn call site → xóa luôn hàm.
- **Icon owner**: trong `displaySavedEvents`, event có `owned=true` thì render
  `<i class="fas fa-crown text-warning me-1" title="Sự kiện của bạn"></i>` ngay trước
  tên event. Khách (ownedByCode rỗng) → không có icon.

## Edge cases (chấp nhận, ghi nhận)

- **Người được mời đích danh (collaborator)**: luôn thấy event trong "Sự Kiện Của Tôi"
  qua nhánh "được mời" bất kể saved_events. Nút Theo dõi với họ chỉ là bookmark thêm —
  Bỏ theo dõi KHÔNG làm event biến mất khỏi danh sách. Chấp nhận (GET event không lộ
  collab role nên frontend không phân biệt được; không đáng thêm API cho việc này).
- **Khách là owner thực tế nhưng chưa đăng nhập**: không xác định được → vẫn hiện nút
  Theo dõi (vô hại: chỉ là bookmark local).
- **Dữ liệu cũ**: các dòng `saved_events` đã tạo bởi auto-lưu trước đây giữ nguyên —
  người dùng thấy sẵn "Đang theo dõi", có thể Bỏ theo dõi để dọn. Không migration.
- **Event không chủ (ownerless)**: `is_owner=false` → có nút Theo dõi, hoạt động bình thường.

## Testing

- `test_api.py`: thêm bước sau khi tạo event bằng user test — GET event bằng user KHÁC
  (hoặc kiểm tra `is_saved=false` ban đầu) → `POST /api/my-events/save` → GET lại thấy
  `is_saved=true` và event xuất hiện trong `GET /api/my-events` → `DELETE
  /api/my-events/<code>` → `is_saved=false`.
- `node --check static/app.js` (không có bundler/linter).
- Unit test hiện có không đổi (không đụng split/validation/event_store).

## Ngoài phạm vi

- Không đổi ngữ nghĩa quyền: theo dõi KHÔNG mang quyền (event `restricted` vẫn ẩn khỏi
  danh sách theo rule may_view sẵn có trong query `/api/my-events`).
- Không thêm thông báo/notification thật — "Theo dõi" chỉ là bookmark có chủ đích.
