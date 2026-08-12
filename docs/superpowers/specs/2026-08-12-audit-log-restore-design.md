# Thiết kế: Lịch sử chỉnh sửa + Khôi phục phiên bản + Bắt buộc đăng nhập khi sửa

**Ngày:** 2026-08-12
**Trạng thái:** Đã duyệt (brainstorming với chủ dự án)

## Mục tiêu

1. **Trace được hành động**: mỗi lần thêm/sửa/xóa nội dung event đều được ghi lại — ai làm,
   lúc nào, thay đổi gì (mô tả tiếng Việt dễ đọc).
2. **Revoke được**: khôi phục event về trạng thái tại bất kỳ điểm nào trong lịch sử
   (kiểu lịch sử phiên bản Google Docs — khôi phục cả document, không undo chọn lọc).
3. **Bắt buộc đăng nhập khi chỉnh sửa**: để mọi hành động gắn được danh tính. Model quyền
   hiện có (owner / edit_key / link-editor) giữ nguyên vai trò quyết định *quyền*; đăng nhập
   là điều kiện bổ sung cho *mọi* thao tác ghi.

## Quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Phạm vi bắt đăng nhập | Mọi thao tác ghi (PUT/DELETE/sharing) yêu cầu JWT; GET (xem) không cần |
| Kiểu revoke | Khôi phục về phiên bản (snapshot cả document), không undo từng hành động riêng lẻ |
| Chi tiết log | Server tự diff bản cũ vs mới → mô tả hành động tiếng Việt |
| Quyền xem/khôi phục lịch sử | Ai có quyền sửa (và đã đăng nhập) thì xem + khôi phục được; người chỉ-xem không thấy |
| Xóa cả event | Giữ DELETE cứng như hiện tại (lịch sử mất theo event) — ngoài phạm vi revoke |
| Hướng triển khai | A — snapshot JSONB + diff phía server (không dùng client khai báo, không dùng trigger) |

## 1. Dữ liệu

Bảng mới trong `schema.sql` (idempotent, RLS bật không policy như các bảng khác):

```sql
CREATE TABLE IF NOT EXISTS event_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    actor_id   uuid NOT NULL,               -- user Supabase thực hiện hành động
    actor_name text NOT NULL DEFAULT '',    -- tên hiển thị tại thời điểm đó (denormalize)
    kind       text NOT NULL DEFAULT 'edit',-- 'create' | 'edit' | 'restore' | 'share'
    summary    jsonb NOT NULL DEFAULT '[]', -- list hành động structured (xem §3)
    snapshot   jsonb NOT NULL,              -- CẢ document (title + members + expenses +
                                            -- bankInfo + couples + rates) SAU hành động
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_revisions_event_created
    ON event_revisions (event_id, created_at DESC);
ALTER TABLE event_revisions ENABLE ROW LEVEL SECURITY;
```

- `snapshot` là document **sau** hành động → "Khôi phục về bản này" = ghi lại snapshot của
  chính dòng đó (giống Google Docs). Dòng `create` giữ trạng thái ban đầu nên mọi thời điểm
  đều khôi phục được.
- `actor_name` denormalize (username từ `user_profiles` nếu có, không thì email từ JWT):
  đọc lịch sử không phải join `auth.users`, và tên còn nguyên nếu tài khoản đổi/xóa.
- **Retention**: giữ tối đa **200** revision mới nhất mỗi event; prune ngay sau mỗi insert
  (DELETE các dòng ngoài top-200 theo `created_at DESC`).

## 2. Bắt buộc đăng nhập khi ghi

- `PUT /api/events/<code>`, `DELETE /api/events/<code>`, `PUT /api/events/<code>/sharing`,
  `POST /api/events/<code>/restore` (mới): kiểm tra `request_user_id(request)` **trước tiên**;
  thiếu/không hợp lệ → **401** `"Vui lòng đăng nhập để chỉnh sửa."` (401 = chưa đăng nhập,
  phân biệt với 403 = không có quyền — đúng quy ước hiện có ở POST).
- Sau bước 401, `_check_edit_permission` giữ nguyên logic: owner JWT / edit_key /
  link-editor / legacy adopt key. Legacy adopt vẫn hoạt động nhưng giờ diễn ra sau đăng nhập.
- `GET /api/events/<code>` vẫn không cần đăng nhập. Thay đổi cờ:
  - `can_edit` = có quyền sửa **VÀ** đã đăng nhập (semantics: "PUT của bạn sẽ thành công").
  - Thêm `login_required_to_edit: true` khi có quyền mà chưa đăng nhập — UI dựa vào đây
    hiện nút "Đăng nhập để chỉnh sửa".
- `POST /api/events` đã yêu cầu JWT từ trước — không đổi.
- `POST /api/events/lookup`, `GET /api/my-events`, exchange-rates, banks, config: không đổi.

## 3. Diff engine — `revision_diff.py` (module thuần, không DB)

`diff_documents(old_doc, new_doc) -> list[dict]`, mỗi phần tử:
`{"a": <action>, "o": <object_key>, "t": <text tiếng Việt>}`

- `a`: `'add' | 'update' | 'remove'`.
- `o`: khóa định danh đối tượng, ổn định giữa các lần lưu:
  - expense → `"expense:<created_time>"` (client sinh `created_time` khi tạo, coi như id;
    fallback khi trống/trùng: match theo position trong danh sách).
  - member → `"member:<tên>"`; bankInfo → `"bank:<tên>"`; couple → `"couple:<client_id>"`;
    rate → `"rate:<mã tiền>"`; title → `"title"`.
- `t` ví dụ: `"Thêm chi phí 'Ăn tối' (500.000 đ)"`,
  `"Sửa chi phí 'Ăn tối': số tiền 400.000 → 500.000 đ"`, `"Xóa thành viên 'Nam'"`,
  `"Đổi tên sự kiện thành 'Đà Lạt 2026'"`, `"Cập nhật tài khoản ngân hàng của 'Nam'"`,
  `"Thêm nhóm chung quỹ 'Vợ chồng Nam'"`, `"Cập nhật tỷ giá USD"`.
- Đổi tên thành viên = `remove` + `add` (member định danh bằng tên — chấp nhận, ghi cả 2 dòng).
- Số tiền format kiểu Việt Nam (dấu chấm ngăn nghìn) + mã tiền nếu khác VND.
- **Cap**: tối đa 10 hành động; nếu nhiều hơn, giữ 10 dòng đầu + dòng chốt
  `"… và N thay đổi khác"` (`{"a": "more", "o": "", "t": "… và N thay đổi khác"}`).
- Diff rỗng (không có thay đổi thực) → **không ghi revision**.

## 4. Ghi log (backend)

Mọi insert revision nằm **trong cùng transaction** với thao tác ghi — ghi log lỗi thì fail
cả save. Audit không được phép thiếu dòng.

| Thao tác | kind | summary | snapshot |
|---|---|---|---|
| POST tạo event | `create` | `[{"a":"add","o":"event","t":"Tạo sự kiện"}]` | document ban đầu |
| PUT lưu document | `edit` | kết quả `diff_documents` | document mới |
| PUT sharing | `share` | `"Đổi quyền truy cập: <mô tả chế độ>"` | document hiện tại (không đổi) |
| POST restore | `restore` | `"Khôi phục về phiên bản lúc HH:MM dd/mm/yyyy"` | document sau khôi phục |

`summary` luôn là list structured theo format §3 kể cả với `create`/`share`/`restore`
(bảng trên chỉ ghi phần text `t` cho gọn; `o` lần lượt là `"event"`, `"sharing"`,
`"restore"`).

- PUT: load document cũ (`load_event_children` + title) **trước** `replace_event_children`
  trong cùng transaction, diff, rồi insert revision.
- **Squash chống nhiễu autosave**: trước khi insert revision `edit`, nếu revision mới nhất
  của event thỏa TẤT CẢ: (1) cùng `actor_id`, (2) `kind='edit'`, (3) `created_at` trong vòng
  **10 phút**, (4) tập `(a, o)` của summary mới **giống hệt** tập của dòng đó, (5) mọi action
  đều là `update` → **UPDATE** dòng đó (snapshot mới, summary mới, `created_at = now()`)
  thay vì insert. Gộp được chuỗi gõ phím sửa cùng một đối tượng thành một dòng lịch sử.
- PUT sharing: ghi revision `share`, **không** bump `updated_at` (giữ hành vi hiện có).
- Lấy danh tính: mở rộng `supabase_auth.py` — thêm hàm trả về claims đã verify (ít nhất
  `sub` + `email`) thay vì chỉ user id; `request_user_id` giữ nguyên cho chỗ gọi cũ.
  `actor_name` = username (query `user_profiles`) `>` email `>` `''`.

## 5. API mới

### `GET /api/events/<code>/revisions`
- Rate limit 60/min. Yêu cầu: đăng nhập (401) + quyền sửa (403, dùng
  `_check_edit_permission` với `allow_link_editor=True`).
- Trả tối đa 200 dòng, mới nhất trước:
  `{success, revisions: [{id, actor_name, kind, summary: [<text>…], created_at}]}`
  — `summary` trả về **chỉ list text** (client không cần `a`/`o`). **Không trả snapshot.**

### `POST /api/events/<code>/restore`
- Rate limit 10/min. Body: `{revision_id, expectedUpdatedAt}`.
- Yêu cầu: đăng nhập (401) + quyền sửa như PUT (403).
- `expectedUpdatedAt` khác `updated_at` hiện tại → **409** (như PUT — không ghi đè âm thầm
  bản ai đó vừa lưu trong lúc mở lịch sử).
- Snapshot của revision được validate lại qua `validate_event_payload` (phòng dữ liệu cũ
  không còn hợp lệ với validation hiện hành); validate fail → **400**
  `"Phiên bản này không còn khôi phục được."` (log chi tiết server-side). Hợp lệ → thay
  title + children (reuse `replace_event_children`), bump `updated_at`, ghi revision
  `restore`. `revision_id` không thuộc event → 404.
- Trả `{success, updated_at}` như PUT — client reload event.

## 6. Frontend

**Đăng nhập để sửa:**
- `allowEdit` vẫn lấy từ `can_edit` (server đã tính cả login — không thêm logic client).
- `login_required_to_edit: true` → chế độ chỉ-xem + banner "Đăng nhập để chỉnh sửa sự kiện
  này" + nút mở modal đăng nhập `AppAuth` sẵn có. Listener `appauth:change` hiện hành
  reload event sau đăng nhập → UI tự mở khóa.
- `saveEvent` nhận **401** (phiên hết hạn giữa chừng): mở modal đăng nhập +
  `setSaveStatus('error')`; KHÔNG chuyển view-only (khác 403), dữ liệu trên trang giữ
  nguyên — đăng nhập xong lưu lại được. 403 giữ hành vi cũ (xóa key hỏng, về chỉ-xem).

**Modal Lịch sử (`#historyModal`):**
- Nút icon đồng hồ trên header cạnh `#saveStatus`, chỉ hiện khi `allowEdit`.
- Mở modal → gọi `GET /revisions` → render: thời gian (HH:MM dd/mm), `actor_name`, các dòng
  summary; badge phân biệt `create`/`restore`/`share`. Nút "Khôi phục" từng dòng (ẩn ở dòng
  mới nhất) → `showConfirm()` (dùng `#confirmModal` — modal này phải giữ vị trí **cuối
  DOM**; `#historyModal` thêm vào trước nó) → `POST /restore` kèm `expectedUpdatedAt` →
  thành công: reload event + toast; 409: toast "Sự kiện vừa được cập nhật ở nơi khác" +
  tải lại danh sách lịch sử.
- **XSS**: summary chứa tên chi phí/thành viên do người dùng nhập, `actor_name` là
  username tự đặt — mọi render qua `escapeHtml()`/`.text()` theo quy ước dự án.

**Khác:**
- `.couple-label-input` handler `input` → debounce ~500ms trước khi `saveEvent(false)`
  (giảm số PUT; squash server đã gộp log nhưng bớt request thừa vẫn tốt).
- `sw.js`: bump `CACHE_VERSION`.

## 7. Kiểm thử

- **`test_revision_diff.py`** (mới, thuần, không DB — chạy như `test_event_store.py`):
  thêm/xóa/sửa expense (match theo `created_time`, fallback position), member add/remove,
  đổi title, bankInfo, couples, rates, cap 10 dòng + "N thay đổi khác", không đổi → `[]`.
- **`test_api.py`** mở rộng (cần server + DB + Supabase test user như hiện có):
  - PUT không JWT → 401; PUT có JWT + edit_key → 200.
  - PUT tạo revision với summary đúng; lưu liên tiếp sửa cùng đối tượng → squash còn 1 dòng.
  - GET revisions: không đăng nhập → 401; đăng nhập không quyền → 403; có quyền → danh sách.
  - Restore: nội dung quay về đúng snapshot; ghi thêm dòng `restore`; sai
    `expectedUpdatedAt` → 409.
- `node --check` cho các file JS đã sửa.
- Cập nhật `schema.sql`, `CLAUDE.md` (auth model + storage model + commands), `CHANGELOG.md`.

## 8. Xử lý lỗi & tương thích

- Ghi revision cùng transaction — không bao giờ có save thành công mà thiếu log.
- Event cũ chưa có revision: lịch sử bắt đầu từ lần lưu đầu tiên sau khi deploy (diff so
  với trạng thái hiện tại trong DB nên dòng đầu vẫn mô tả đúng thay đổi).
- Người đang giữ edit_key nhưng không có tài khoản: vẫn giữ quyền, chỉ cần đăng ký/đăng
  nhập (email hoặc Google) — không mất key, không cần owner cấp lại.
- `_server_error()` cho lỗi nội bộ như quy ước; message client-safe tiếng Việt.

## Ngoài phạm vi (đã chốt)

- Xóa cả event vẫn là DELETE cứng (revisions CASCADE mất theo) — chỉ có hộp xác nhận.
- Không có preview nội dung từng phiên bản trong v1 — summary đủ để quyết định khôi phục.
- Không undo chọn lọc một hành động giữa lịch sử (conflict/merge) — chỉ khôi phục toàn bộ.
- Không thay đổi model chia sẻ (không có bảng collaborators per-user).
