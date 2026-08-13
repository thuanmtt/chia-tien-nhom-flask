# Design: Lưu người hưởng đích danh cho mọi khoản chi (bỏ 'all' động)

Ngày: 2026-08-13 · Trạng thái: đã duyệt (chốt qua brainstorming với chủ dự án)

## Bối cảnh

Khoản chi `benefitType: 'all'` hiện chia **động** theo danh sách thành viên tại thời
điểm tính toán (`getExpenseBeneficiaries` bỏ qua snapshot đã lưu). Hệ quả: người vào
nhóm sau tự động bị chia vào các khoản có từ trước — khó kiểm soát, từng gây bug
report (fix tạm 9226aa4: hỏi "Không chia" khi thêm thành viên, chốt bằng
`freezeAllExpenses`). Chủ dự án quyết định đổi hẳn mô hình: **mọi khoản chi luôn lưu
danh sách người hưởng đích danh**; không còn khái niệm "tất cả" động.

## Các quyết định đã chốt

1. **Dữ liệu 'all' cũ trong DB** → chuyển thành đích danh theo **snapshot lúc tạo**
   (danh sách `expense_beneficiaries` đã lưu kèm). Chấp nhận: sự kiện nào từng dựa
   vào việc người-vào-sau tự được chia thì kết quả sẽ đổi.
2. **Thêm thành viên mới** → hỏi, **mặc định không thêm**: nếu có N khoản đang chia
   cho đủ toàn bộ thành viên cũ, hỏi "Chia N khoản này cho [tên mới] không?" —
   đồng ý mới thêm tên vào các khoản đó; đóng hộp thoại = không đụng gì.
3. **UI** → giữ dropdown "Tất cả / Chọn người hưởng" như shortcut nhập liệu; danh
   sách chi phí **luôn hiển thị tên đích danh** thay cho chữ "Tất cả".
4. **Kiến trúc** → phương án B: chuyển đổi lười ở client (luật tính hiểu đúng dữ
   liệu cũ) **kèm** migration script một lần dọn sạch DB.

## Thiết kế chi tiết

### 1. Luật tính mới — `static/split.js`

`getExpenseBeneficiaries(expense, members)` đổi thành:

- Nếu `expense.beneficiaries` là mảng không rỗng: lọc theo `members` còn tồn tại;
  nếu còn ≥1 tên → **dùng danh sách đó, bất kể `benefitType`**.
- Ngược lại (thiếu mảng, mảng rỗng, hoặc toàn tên đã xóa): fallback về `members`
  hiện tại (giữ tính chống-hỏng cho dữ liệu chia sẻ/tay).

Đây là thay đổi ngữ nghĩa cốt lõi: khoản `'all'` chưa migrate (kể cả do tab client
cũ ghi lại sau này) vẫn được hiểu đúng theo snapshot lúc tạo, vĩnh viễn.

Helper mới (thuần, unit-test được):

- `normalizeExpenses(expenses, members)` — mọi khoản `benefitType !== 'selected'`
  → `benefitType = 'selected'`, `beneficiaries` = snapshot đã lưu lọc theo thành
  viên còn tồn tại; rỗng thì lấy `members` hiện tại. Sửa tại chỗ, trả số khoản đã
  chuyển.
- `addBeneficiaryToFullCoverage(expenses, prevMembers, newMember)` — thêm
  `newMember` vào những khoản mà danh sách người hưởng phủ **đủ toàn bộ**
  `prevMembers`; trả số khoản đã thêm. Dùng cho hộp thoại thêm thành viên.
- **Xóa** `freezeAllExpenses` (thành code chết trong mô hình mới).

### 2. Chuẩn hóa khi tải & luồng lưu — `static/app.js`

- `loadEventFromServer`: ngay sau khi nhận `eventData.expenses`, gọi
  `SplitLogic.normalizeExpenses(expenses, members)`. Từ đó về sau toàn bộ code
  (render, form sửa, tính toán, export) chỉ còn thấy `'selected'` + danh sách.
  KHÔNG thêm `saveEvent` vào đường tải (giữ quy tắc autosave; viewer không có
  quyền ghi) — bản chuẩn hóa tự xuống DB ở lần lưu tự nhiên kế tiếp.
- Form thêm/sửa chi phí: luôn gửi `benefitType: 'selected'`; chọn "Tất cả" trong
  dropdown chỉ là shortcut = chốt đủ thành viên tại thời điểm lưu.
- Sửa khoản chi: dropdown hiện `'selected'` + tick sẵn danh sách (như hành vi
  'selected' hiện tại). Giá trị mặc định cho khoản MỚI vẫn là "Tất cả".

### 3. UI và các luồng liên quan — `static/app.js`

- **Hiển thị**: mọi chỗ đang in "Tất cả" cho `benefitType === 'all'` (bảng chi
  phí, chi tiết `benefitInfo`, xuất Excel/in) → luôn in tên đích danh. Sau
  chuẩn hóa không còn 'all' trong bộ nhớ; giữ nhánh cũ làm fallback phòng thủ.
- **Thêm thành viên** (`#memberForm`): thay hộp thoại 9226aa4. Sau khi thêm tên
  + lưu, đếm khoản "phủ đủ thành viên cũ" (mọi tên trong `prevMembers` đều nằm
  trong danh sách người hưởng). Nếu N > 0: `showConfirm` — message "Có N khoản
  chi đang chia cho đủ mọi người. Chia thêm cho \"[tên]\" không?"; nút hành động
  (btn-primary) = "Có, chia cho [tên]" → `addBeneficiaryToFullCoverage` +
  `renderExpenses()` + `saveEvent(false)`; nút Hủy/ESC/backdrop (cancelLabel
  "Không") = không đụng gì. XSS: message/label qua `.text()` như hiện tại.
- **Xóa thành viên** (`.member-close`): luật hiện tại chặn mọi người hưởng
  'selected' — sau chuẩn hóa sẽ chặn gần hết, thoái hóa UX. Luật mới:
  - Là `payer` của khoản nào đó → chặn như cũ.
  - Là người hưởng **duy nhất** của khoản nào đó → chặn, toast nêu rõ cần sửa/xóa
    khoản chi trước.
  - Còn lại: `showConfirm` "Gỡ \"[tên]\" khỏi N khoản chi và xóa khỏi nhóm?" →
    gỡ tên khỏi mọi `beneficiaries`, xóa khỏi `members` + nhóm chung quỹ (logic
    couples giữ nguyên), `renderMembers()` + `renderExpenses()` +
    `saveEvent(false)` một lần.
  - Không có mặt trong khoản nào → xóa thẳng như cũ, không hỏi.
- `showConfirm` giữ hỗ trợ `cancelLabel` (9226aa4) — tái dùng cho 2 hộp thoại trên.

### 4. Migration script — `migrate_beneficiaries.py` (repo root)

- Chạy **một lần, sau khi** deploy client mới. Kết nối bằng psycopg2 +
  `DATABASE_URL` từ `.env` (máy dev không có psql).
- Với mỗi expense có `benefit_type <> 'selected'`:
  - Đã có rows `expense_beneficiaries` → chỉ `UPDATE benefit_type = 'selected'`.
  - Chưa có rows → `INSERT` theo danh sách `members` hiện tại của event (đúng thứ
    tự `position`), rồi update benefit_type.
- **Không bump `events.updated_at`** (tránh 409 optimistic-lock cho tab đang mở),
  **không ghi `event_revisions`** (dọn dữ liệu, không phải hành động người dùng).
- Idempotent: chạy lại vô hại (điều kiện `benefit_type <> 'selected'`). Toàn bộ
  trong 1 transaction; in số event/expense đã chuyển.
- Tab client cũ còn mở có thể PUT ghi đè lại `'all'` cho event của họ — chấp nhận,
  vô hại nhờ luật tính mục 1; lần load kế tiếp lại chuẩn hóa.

### 5. Tương thích & các đường dữ liệu khác

- **Backend không đổi**: `validation.py` tiếp tục chấp nhận cả `'all'`/`'selected'`
  (client cũ còn gửi 'all' trong giai đoạn giao thời); `event_store.py` lưu nguyên
  văn như hiện tại.
- **Restore lịch sử**: snapshot revision cũ chứa `'all'` — sau restore, GET kế tiếp
  chuẩn hóa lười như thường. Không cần sửa gì.
- **Client cũ (tab chưa reload)**: đọc dữ liệu đã migrate ('selected' + list) →
  tính đúng theo list; tạo khoản 'all' mới → client mới hiểu theo snapshot. Nhất
  quán hai chiều trong giai đoạn giao thời.

### 6. Test & tài liệu

- `test_split.js`:
  - Đảo test "'all' dùng danh sách HIỆN TẠI" → "'all' có snapshot dùng snapshot".
  - Test fallback: thiếu/rỗng/toàn tên chết → danh sách hiện tại.
  - Test `normalizeExpenses`: chuyển 'all'/thiếu benefitType, lọc tên chết,
    fallback rỗng, không đụng 'selected' sẵn có, đếm đúng.
  - Test `addBeneficiaryToFullCoverage`: chỉ thêm vào khoản phủ đủ prevMembers,
    không thêm trùng, đếm đúng.
  - Xóa 2 test `freezeAllExpenses`; cập nhật test/fuzz dùng 'all' cho khớp ngữ
    nghĩa mới.
- Python unit test giữ nguyên (backend không đổi). `test_api.py` chạy lại như
  smoke test tích hợp.
- CLAUDE.md: viết lại đoạn "Beneficiaries semantics" + gotcha thêm/xóa thành viên.
  CHANGELOG: entry mới.

## Thứ tự deploy (bắt buộc)

1. Merge + push → Vercel tự deploy client mới.
2. Xác minh prod phục vụ code mới (curl marker trong `split.js`).
3. Chạy `python3 migrate_beneficiaries.py` (một lần).
4. Xác minh: sự kiện từng bị bug tự về đúng 3 người ban đầu; spot-check vài event.

## Ngoài phạm vi

- Không đổi schema/DB (cột `benefit_type` giữ nguyên, chỉ còn giá trị 'selected'
  sau migration; giá trị 'all' vẫn hợp lệ về mặt kỹ thuật từ client cũ).
- Không đụng backend Python ngoài script migration độc lập.
- Housekeeping DEFER từ 43fb126 (guard None update_sharing, `.data()` cũ, v.v.)
  không thuộc phạm vi này.
