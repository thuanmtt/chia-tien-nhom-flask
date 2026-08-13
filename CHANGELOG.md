# Changelog

## 2026-08-13 — Tải sự kiện nhanh hơn

- Ghim serverless function về Singapore cùng region với database (`regions: sin1`) —
  trước đó mỗi câu truy vấn phải bay vòng Mỹ ↔ Singapore (~220ms/câu).
- Mở link sự kiện: app gọi dữ liệu sự kiện NGAY khi trang chạy, song song với
  bước khởi tạo đăng nhập (trước đây phải chờ xong mới gọi — chậm thêm ~0.5–1s).
- Backend đọc sự kiện bằng 1 câu truy vấn thay vì 7 câu tuần tự.
- Thư viện biểu đồ và xuất Excel/PDF (~1.5MB) chỉ tải khi cần thay vì chặn
  lúc mở trang — lần ghé đầu tiên nhẹ hơn hẳn, đặc biệt trên mạng di động.

## 2026-08-13 — Người hưởng đích danh cho mọi khoản chi

- Mọi khoản chi giờ lưu rõ chia cho những ai — không còn kiểu "Tất cả" tự động chia
  lại khi nhóm thay đổi. Chọn "Tất cả" khi nhập chỉ là cách tick nhanh đủ mọi
  người tại thời điểm đó.
- Thêm thành viên mới: app hỏi có chia thêm người đó vào các khoản đang chia
  cho đủ mọi người không (mặc định KHÔNG — đóng hộp thoại là không đụng gì).
- Xóa thành viên: tự gỡ tên khỏi các khoản chi kèm xác nhận; chặn nếu là người
  thanh toán hoặc người hưởng duy nhất của một khoản.
- Dữ liệu cũ kiểu "Tất cả" được chuyển theo danh sách lúc tạo khoản chi
  (script dọn một lần trên DB).
- Danh sách chi phí + xuất Excel luôn hiện tên người hưởng cụ thể.

## 2026-08-13 — Hỏi trước khi chia khoản "Tất cả" cho thành viên mới

- Khi thêm thành viên mà sự kiện đang có khoản chi chia cho "Tất cả", app hỏi
  có chia các khoản đó cho người mới không. Chọn "Không chia" → các khoản này
  được chốt lại cho danh sách thành viên cũ (chuyển thành "Chọn người hưởng");
  chọn "Có" hoặc đóng hộp thoại → giữ như trước: người mới được tính vào.
- Trước đây khoản "Tất cả" luôn tự chia lại cho người vào sau — gây bất ngờ khi
  người mới bị tính vào các khoản chi từ trước khi họ tham gia.

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

## [1.2.0] - 2026-08-12

### Thêm mới
- ✅ Thêm người có quyền truy cập qua email/username (kiểu Google Docs): vai trò Người xem / Người chỉnh sửa riêng từng người, chỉ chủ sở hữu quản lý
- ✅ Người được mời truy cập được sự kiện ở chế độ Hạn chế; thao tác thêm/đổi vai trò/gỡ đều ghi vào lịch sử chỉnh sửa

### Sửa lỗi
- 🐛 Sự kiện Hạn chế không còn biến mất khỏi "Sự Kiện Của Tôi" của người được mời

## [1.1.0] - 2026-08-12

### Thêm mới
- ✅ Lịch sử chỉnh sửa: mỗi lần thêm/sửa/xóa ghi lại ai làm, lúc nào, thay đổi gì (diff tiếng Việt)
- ✅ Khôi phục sự kiện về phiên bản bất kỳ trong lịch sử (kiểu Google Docs)
- ✅ API `GET /api/events/<event_code>/revisions` và `POST /api/events/<event_code>/restore`

### Thay đổi
- 🔄 Mọi thao tác chỉnh sửa (lưu/xóa/đổi chia sẻ/khôi phục) yêu cầu đăng nhập — quyền qua edit_key/link chia sẻ giữ nguyên, đăng nhập để gắn danh tính vào lịch sử

## [1.0.0] - 2025-08-01

### Thêm mới
- ✅ Chuyển đổi từ static HTML sang Flask app
- ✅ Tích hợp SQLite database với model events
- ✅ Tạo event_code theo format YYMMDD + 8 ký tự ngẫu nhiên
- ✅ API endpoints cho CRUD operations
- ✅ Chia sẻ sự kiện qua event_code thay vì data URL
- ✅ LocalStorage chỉ lưu event_code
- ✅ Tự động tải dữ liệu khi có event_code trong URL
- ✅ Tính năng xem danh sách sự kiện đã lưu
- ✅ Chức năng xóa sự kiện
- ✅ Chia sẻ sự kiện trực tiếp từ danh sách

### Thay đổi
- 🔄 Thay đổi từ localStorage sang SQLite database
- 🔄 Thay đổi từ data URL sang event_code cho chia sẻ
- 🔄 Cập nhật UI để hoạt động với Flask backend
- 🔄 Tối ưu hóa cấu trúc thư mục

### Cấu trúc mới
```
chia-tien-nhom-flask/
├── app.py                 # Flask app chính
├── requirements.txt       # Python dependencies
├── events.db             # SQLite database
├── templates/
│   └── index.html        # Template chính
└── static/
    └── banks.json        # Danh sách ngân hàng
```

### API Endpoints
- `POST /api/events` - Tạo sự kiện mới
- `GET /api/events` - Lấy danh sách tất cả sự kiện
- `GET /api/events/<event_code>` - Lấy thông tin sự kiện
- `PUT /api/events/<event_code>` - Cập nhật sự kiện
- `DELETE /api/events/<event_code>` - Xóa sự kiện
- `GET /api/banks` - Lấy danh sách ngân hàng

### Database Schema
```sql
CREATE TABLE events (
    id TEXT PRIMARY KEY,
    event_code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    members TEXT NOT NULL,
    expenses TEXT NOT NULL,
    bank_info TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Event Code Format
- Format: `YYMMDD + 8 ký tự ngẫu nhiên`
- Ví dụ: `250801FDQ2GBGY`

### LocalStorage
- Chỉ lưu `currentEventCode` thay vì toàn bộ dữ liệu
- Tự động tải dữ liệu từ server khi cần

### Chia sẻ
- Link chia sẻ: `http://localhost:5001/?event_code=XXXXX`
- Tự động tải dữ liệu khi mở link
- Không cần nén/giải nén dữ liệu 