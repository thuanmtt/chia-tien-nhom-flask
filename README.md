# Ứng Dụng Chia Tiền Nhóm - Flask Version

Ứng dụng chia tiền nhóm online nhanh chóng và tiện lợi, được xây dựng bằng Flask với Postgres (deploy trên Vercel).

## Tính năng chính

- ✅ Tạo và quản lý sự kiện chia tiền
- ✅ Thêm/xóa thành viên
- ✅ Thêm chi phí với người thanh toán và người hưởng lợi
- ✅ Tính toán tự động số tiền cần chuyển
- ✅ Chia sẻ sự kiện qua event_code
- ✅ Cấu hình thông tin ngân hàng cho từng thành viên
- ✅ Tạo QR code chuyển tiền
- ✅ Lưu trữ dữ liệu trên Postgres (Vercel/Neon)

## Cài đặt và chạy

### Yêu cầu hệ thống
- Python 3.9+
- pip
- Một database Postgres (Neon/Vercel Postgres, hoặc Postgres local)

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

3. Tạo bảng (chạy 1 lần trên database):
```bash
psql "$DATABASE_URL" -f schema.sql
```

4. Chạy ứng dụng:
```bash
DATABASE_URL=postgres://... python vercel_app.py
```

5. Mở trình duyệt và truy cập:
```
http://localhost:5002
```

### Deploy Vercel

Repo đã có sẵn `vercel.json` (entry `api/index.py` → `vercel_app.py`). Chỉ cần
đặt env `DATABASE_URL` (hoặc `POSTGRES_URL`) trong project settings và chạy
`schema.sql` trên database trước lần deploy đầu.

## Cấu trúc dự án

```
chia-tien-nhom-flask/
├── vercel_app.py          # Flask app chính (Postgres)
├── api/index.py           # Entry point cho Vercel
├── validation.py          # Validate payload API
├── schema.sql             # Schema + migration Postgres
├── vercel.json            # Cấu hình Vercel
├── requirements.txt       # Python dependencies
├── templates/
│   └── index.html        # Template chính
└── static/
    └── banks.json        # Danh sách ngân hàng
```

## API Endpoints

### Events
- `POST /api/events` - Tạo sự kiện mới (response chứa `edit_key` — chỉ trả về 1 lần duy nhất)
- `GET /api/events/<event_code>` - Lấy thông tin sự kiện (không bao giờ trả `edit_key`)
- `PUT /api/events/<event_code>` - Cập nhật sự kiện (yêu cầu header `X-Edit-Key`)
- `DELETE /api/events/<event_code>` - Xóa sự kiện (yêu cầu header `X-Edit-Key`)

Sự kiện tạo trước khi có cơ chế `edit_key` (cột NULL trong DB) sẽ được "nhận" key
từ lần ghi hợp lệ đầu tiên có gửi `X-Edit-Key`; từ đó về sau key này là bắt buộc.

### Banks
- `GET /api/banks` - Lấy danh sách ngân hàng

## Biến môi trường

- `DATABASE_URL` / `POSTGRES_URL` - Kết nối Postgres (bản deploy Vercel, `vercel_app.py`)
- `RATELIMIT_STORAGE_URI` - Storage cho rate limiter (mặc định `memory://`).
  Trên serverless (Vercel), `memory://` gần như vô hiệu vì mỗi instance có bộ nhớ
  riêng — nên trỏ tới Redis, ví dụ Upstash: `redis://default:<password>@<host>:<port>`

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