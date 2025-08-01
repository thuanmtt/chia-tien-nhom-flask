# Ứng Dụng Chia Tiền Nhóm - Flask Version

Ứng dụng chia tiền nhóm online nhanh chóng và tiện lợi, được xây dựng bằng Flask với SQLite database.

## Tính năng chính

- ✅ Tạo và quản lý sự kiện chia tiền
- ✅ Thêm/xóa thành viên
- ✅ Thêm chi phí với người thanh toán và người hưởng lợi
- ✅ Tính toán tự động số tiền cần chuyển
- ✅ Chia sẻ sự kiện qua event_code
- ✅ Cấu hình thông tin ngân hàng cho từng thành viên
- ✅ Tạo QR code chuyển tiền
- ✅ Lưu trữ dữ liệu trên SQLite database

## Cài đặt và chạy

### Yêu cầu hệ thống
- Python 3.7+
- pip

### Cài đặt

1. Clone repository:
```bash
git clone <repository-url>
cd chia-tien-nhom-flask
```

2. Cài đặt dependencies:
```bash
pip install -r requirements.txt
```

3. Chạy ứng dụng:
```bash
python app.py
```

4. Mở trình duyệt và truy cập:
```
http://localhost:5001
```

## Cấu trúc dự án

```
chia-tien-nhom-flask/
├── app.py                 # Flask app chính
├── requirements.txt       # Python dependencies
├── events.db             # SQLite database (tự động tạo)
├── templates/
│   └── index.html        # Template chính
└── static/
    └── banks.json        # Danh sách ngân hàng
```

## API Endpoints

### Events
- `POST /api/events` - Tạo sự kiện mới
- `GET /api/events` - Lấy danh sách tất cả sự kiện
- `GET /api/events/<event_code>` - Lấy thông tin sự kiện
- `PUT /api/events/<event_code>` - Cập nhật sự kiện
- `DELETE /api/events/<event_code>` - Xóa sự kiện

### Banks
- `GET /api/banks` - Lấy danh sách ngân hàng

## Cách sử dụng

### Tạo sự kiện mới
1. Truy cập trang chủ
2. Nhập tên sự kiện
3. Thêm thành viên
4. Thêm chi phí
5. Nhấn "Lưu" để tạo sự kiện

### Chia sẻ sự kiện
1. Sau khi lưu sự kiện, nhấn "Chia sẻ"
2. Copy link được tạo ra
3. Gửi link cho các thành viên khác

### Tham gia sự kiện
1. Mở link chia sẻ
2. Dữ liệu sự kiện sẽ được tải tự động
3. Có thể thêm chi phí và cập nhật thông tin

### Xem sự kiện đã lưu
1. Nhấn "Sự Kiện Đã Lưu" trên thanh navigation
2. Xem danh sách tất cả sự kiện đã tạo
3. Click vào sự kiện để mở và chỉnh sửa
4. Sử dụng nút chia sẻ hoặc xóa cho từng sự kiện

## Event Code Format

Event code được tạo theo format: `YYMMDD + 8 ký tự ngẫu nhiên`

Ví dụ: `250115A1B2C3D4`

## Database Schema

### Bảng `events`
- `id`: UUID chính
- `event_code`: Mã sự kiện duy nhất
- `title`: Tên sự kiện
- `members`: JSON array thành viên
- `expenses`: JSON array chi phí
- `bank_info`: JSON object thông tin ngân hàng
- `created_at`: Thời gian tạo
- `updated_at`: Thời gian cập nhật

## LocalStorage

Ứng dụng chỉ lưu `event_code` trong localStorage để duy trì phiên làm việc.

## License

MIT License