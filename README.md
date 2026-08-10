# Ứng Dụng Chia Tiền Nhóm - Flask Version

Ứng dụng chia tiền nhóm online nhanh chóng và tiện lợi, được xây dựng bằng Flask với Postgres (deploy trên Vercel, database trên Supabase).

## Tính năng chính

- ✅ Tạo và quản lý sự kiện chia tiền
- ✅ Thêm/xóa thành viên
- ✅ Thêm chi phí với người thanh toán và người hưởng lợi
- ✅ Tính toán tự động số tiền cần chuyển
- ✅ Chia sẻ sự kiện qua event_code
- ✅ Cấu hình thông tin ngân hàng cho từng thành viên
- ✅ Tạo QR code chuyển tiền
- ✅ Lưu trữ dữ liệu trên Postgres (Supabase)

## Cài đặt và chạy

### Yêu cầu hệ thống
- Python 3.9+
- pip
- Một database Postgres trên Supabase (schema quan hệ, xem `schema.sql`), hoặc Postgres local

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

3. Tạo bảng (chạy trên database Supabase, idempotent — chạy lại không lỗi):
```bash
psql "$DATABASE_URL" -f schema.sql
```

4. Chạy ứng dụng — `DATABASE_URL` là connection string qua Supabase pooler
   (transaction mode, cổng 6543); `SUPABASE_URL` và `SUPABASE_ANON_KEY` lấy từ
   Project Settings → API của project Supabase, cần để đăng nhập hoạt động:
```bash
DATABASE_URL="postgres://...pooler...:6543/postgres" \
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_ANON_KEY="<anon-key>" \
python vercel_app.py
```

5. Mở trình duyệt và truy cập:
```
http://localhost:5002
```

### Bật đăng nhập Google (Supabase Auth)

1. Vào Supabase Dashboard → Authentication → Providers → bật **Google**, điền
   Client ID/Secret lấy từ Google Cloud Console (OAuth 2.0 Client ID).
2. Trong Google Cloud Console, thêm domain production và
   `http://localhost:5002` vào danh sách Redirect URLs/Authorized redirect URIs
   (URL callback do Supabase cung cấp ở màn hình bật provider).
3. Trong Supabase Dashboard → Authentication → URL Configuration, thêm domain
   production và `http://localhost:5002` vào **Redirect URLs**.

### Deploy Vercel

Repo đã có sẵn `vercel.json` (entry `api/index.py` → `vercel_app.py`). Cần đặt
các env sau trong project settings trước lần deploy: `DATABASE_URL` (hoặc
`POSTGRES_URL`), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (không đặt
`SUPABASE_SERVICE_ROLE_KEY` — key này chỉ dùng trong test, tuyệt đối không
đưa lên môi trường chạy app thật). Chạy `schema.sql` trên database trước lần
deploy đầu.

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
- `GET /api/events/<event_code>` - Lấy thông tin sự kiện. Nhận header `X-Edit-Key`
  (tùy chọn) và trả về cờ `can_edit` cho biết key đó có quyền sửa không —
  UI dựa vào cờ này để hiện giao diện chỉnh sửa hay chỉ xem. Không bao giờ trả `edit_key`.
- `PUT /api/events/<event_code>` - Cập nhật sự kiện (yêu cầu header `X-Edit-Key`).
  Hỗ trợ optimistic locking: gửi kèm `expectedUpdatedAt` (giá trị `updated_at`
  client đang biết) — nếu server đã có bản mới hơn sẽ trả 409 thay vì ghi đè.
  Response trả `updated_at` mới để client dùng cho lần lưu sau.
- `DELETE /api/events/<event_code>` - Xóa sự kiện (yêu cầu header `X-Edit-Key`)

Link chia sẻ:
- Chỉ xem: `/?event_code=<event_code>`
- Chỉnh sửa: `/?event_code=<event_code>&key=<edit_key>`
- `/share/<event_code>` và `/event/<event_code>` (định dạng cũ) redirect về
  `/?event_code=<event_code>` để các link đã gửi đi không bị chết.

Sự kiện tạo trước khi có cơ chế `edit_key` (cột NULL trong DB) sẽ được "nhận" key
từ lần ghi hợp lệ đầu tiên có gửi `X-Edit-Key`; từ đó về sau key này là bắt buộc.

### Banks
- `GET /api/banks` - Lấy danh sách ngân hàng

## Biến môi trường

- `DATABASE_URL` / `POSTGRES_URL` - Kết nối Postgres Supabase qua pooler (transaction
  mode, cổng 6543), ví dụ: `postgres://postgres.<project>:<password>@<host>:6543/postgres`
- `SUPABASE_URL` - URL project Supabase (`https://<project-ref>.supabase.co`), dùng để
  verify JWT (JWKS) và trả cho frontend qua `GET /api/config`
- `SUPABASE_ANON_KEY` - Anon/public key của project Supabase, trả cho frontend qua
  `GET /api/config` để khởi tạo Supabase Auth client
- `SUPABASE_SERVICE_ROLE_KEY` - **Chỉ dùng khi chạy `test_api.py`** (tạo/xóa user test
  qua Admin API) — không cần và không nên đặt trên môi trường chạy app thật
- `RATELIMIT_STORAGE_URI` - Storage cho rate limiter (mặc định `memory://`).
  Trên serverless (Vercel), `memory://` gần như vô hiệu vì mỗi instance có bộ nhớ
  riêng — nên trỏ tới Redis, ví dụ Upstash: `redis://default:<password>@<host>:<port>`

## Migrate dữ liệu từ DB cũ

Nếu database cũ (JSON blob, ví dụ Neon) còn dữ liệu cần giữ, chạy `migrate_to_supabase.py`
để chuyển sang schema quan hệ mới (chạy lại được — upsert theo `event_code`,
giữ nguyên `event_code`/`edit_key` nên link chia sẻ cũ vẫn sống):

```bash
OLD_DATABASE_URL=postgres://...(Neon) \
DATABASE_URL=postgres://...(Supabase pooler 6543) \
python3 migrate_to_supabase.py
```

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

Schema quan hệ, xem chi tiết ở `schema.sql`. Bảng `events` (title, event_code,
edit_key, owner_id, created_at, updated_at) là bảng chính; các bảng con `members`,
`expenses`, `expense_beneficiaries`, `member_bank_info`, `couples`, `couple_members`,
`event_rates` lưu chi tiết theo `event_id`. API vẫn nhận/trả nguyên document JSON
như cũ — `event_store.py` lo việc decompose/compose giữa document và các bảng.

## LocalStorage

Ứng dụng chỉ lưu `event_code` trong localStorage để duy trì phiên làm việc.

## License

MIT License