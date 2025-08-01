# Changelog

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