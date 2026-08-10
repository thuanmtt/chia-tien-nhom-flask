# Thiết kế: Migrate sang Supabase (schema quan hệ) + Tài khoản đăng nhập

**Ngày:** 2026-08-10
**Trạng thái:** Đã duyệt thiết kế, chờ review spec

## Mục tiêu

1. Chuyển storage từ 1 bảng `events` chứa JSON blob (Neon/Vercel Postgres) sang **Supabase Postgres với schema quan hệ** — mỗi khoản chi là một dòng, truy vấn được bằng SQL.
2. Thêm **tài khoản người dùng**: đăng ký/đăng nhập bằng email + mật khẩu và đăng nhập bằng Google, dùng **Supabase Auth**.

## Các quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Kiến trúc | **Hybrid**: Auth bằng supabase-js ở frontend; dữ liệu vẫn đi qua Flask API; Flask verify JWT của Supabase; `DATABASE_URL` trỏ sang Postgres của Supabase |
| Người dùng ẩn danh | **Bắt buộc đăng nhập để TẠO sự kiện**; người được chia sẻ link vẫn xem/sửa không cần tài khoản (qua `edit_key` như cũ) |
| Dữ liệu cũ | **Viết script migrate** — event cũ giữ nguyên `event_code`/`edit_key`, link chia sẻ cũ vẫn hoạt động |
| API style | **Giữ API document** (GET/PUT cả document) trong giai đoạn này; chuyển REST chi tiết để dành đợt sau |
| Tham chiếu thành viên | **Theo tên** (string) trong các bảng con — giữ đúng ngữ nghĩa document hiện tại (chấp nhận tên "mồ côi", `split.js` đã có guard) |

## 1. Schema quan hệ (Supabase Postgres)

Thành viên được định danh bằng **tên** trong toàn bộ data model hiện tại (`expense.payer`,
`beneficiaries`, `bankInfo`, `couples` đều tham chiếu bằng tên). Schema mới giữ nguyên
ngữ nghĩa đó:

```sql
events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_code   text UNIQUE NOT NULL,
    title        text NOT NULL,
    edit_key     text,                          -- NULL với event legacy chưa "adopt" key
    owner_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- NULL: event migrate/legacy
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

members (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name      text NOT NULL,
    position  int  NOT NULL,                    -- giữ thứ tự hiển thị
    UNIQUE (event_id, name)
);

expenses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title         text NOT NULL DEFAULT '',
    amount        numeric NOT NULL,
    currency      text NOT NULL DEFAULT 'VND',
    payer_name    text NOT NULL DEFAULT '',     -- theo tên, không FK (chấp nhận tên mồ côi)
    benefit_type  text NOT NULL DEFAULT 'all',  -- 'all' | 'selected'
    expense_date  text NOT NULL DEFAULT '',     -- giữ nguyên chuỗi client gửi (tối đa 40 ký tự)
    created_time  text NOT NULL DEFAULT '',
    updated_time  text NOT NULL DEFAULT '',
    position      int  NOT NULL                 -- giữ thứ tự trong danh sách
);

expense_beneficiaries (
    expense_id   uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_name  text NOT NULL,
    position     int  NOT NULL,
    PRIMARY KEY (expense_id, member_name)
);

member_bank_info (
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_name  text NOT NULL,
    bank         text NOT NULL DEFAULT '',
    account      text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, member_name)
);

couples (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    client_id    text NOT NULL DEFAULT '',      -- id do client sinh (giữ để round-trip)
    label        text NOT NULL DEFAULT '',
    primary_name text NOT NULL DEFAULT '',      -- người đại diện nhận/trả thay nhóm
    position     int  NOT NULL
);

couple_members (
    couple_id    uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    member_name  text NOT NULL,
    position     int  NOT NULL,
    PRIMARY KEY (couple_id, member_name)
);

event_rates (
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    currency_code text NOT NULL,
    rate          numeric,                      -- NULL = thiếu tỷ giá (block tính toán)
    source        text NOT NULL DEFAULT '',
    rate_date     text,
    rate_type     text,
    currency_name text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, currency_code)
);
```

Index: `events(event_code)`, `events(owner_id)`, `events(updated_at DESC)`, và FK index
trên mọi cột `event_id`/`expense_id`/`couple_id`.

**Bảo mật Supabase (bắt buộc):**
- **Bật RLS trên tất cả các bảng, không tạo policy nào** (deny-all). Lý do: Supabase tự
  expose PostgREST API công khai với anon key; anon key nằm trong frontend nên ai cũng có.
  Không RLS = ai cũng đọc/ghi thẳng vào bảng. Flask kết nối bằng connection string Postgres
  (role `postgres`) nên không bị RLS chặn.
- Flask trên Vercel kết nối qua **Supavisor pooler, transaction mode (port 6543)** — bắt
  buộc cho serverless. Không dùng prepared statements ở session level (psycopg2 mặc định ổn).

Schema nằm ở `schema.sql` (thay bản cũ), idempotent, chạy tay bằng
`psql "$DATABASE_URL" -f schema.sql` theo quy ước repo.

## 2. Xác thực và phân quyền

### Supabase Auth (frontend)

- `supabase-js` v2 nạp từ CDN kèm SRI `integrity` hash (quy ước repo).
- Email/password: đăng ký (email xác nhận theo mặc định Supabase), đăng nhập, quên mật
  khẩu — Supabase lo toàn bộ email.
- Google: `signInWithOAuth({ provider: 'google' })` — cấu hình Google provider trong
  Supabase dashboard (client id/secret của Google Cloud), không tự viết OAuth flow.
- Session do supabase-js quản lý (localStorage, tự refresh token).
- Frontend gửi `Authorization: Bearer <access_token>` kèm mọi request API khi có session.

### Flask verify JWT

- PyJWT + JWKS công khai của Supabase (`https://<project>.supabase.co/auth/v1/.well-known/jwks.json`),
  cache JWKS trong process (PyJWKClient). Không gọi Supabase mỗi request.
- Điều kiện: project Supabase dùng khóa ký bất đối xứng (project mới mặc định ES256).
  Nếu project dùng legacy HS256 thì bật "JWT signing keys" trong dashboard trước.
- Verify chữ ký + `exp` + audience `authenticated`; user id = claim `sub`.
- Token thiếu/sai → coi như chưa đăng nhập (không phải lỗi 500).

### Ma trận quyền

| Endpoint | Quy tắc |
|---|---|
| `POST /api/events` | **Bắt buộc JWT hợp lệ** → 401 nếu chưa đăng nhập. `owner_id` = user id. Vẫn sinh và trả `edit_key` đúng một lần như cũ |
| `PUT /api/events/<code>` | Cho phép nếu: `X-Edit-Key` đúng (`hmac.compare_digest`) **hoặc** JWT là owner. Rule "adopt" edit_key NULL giữ nguyên. Sai cả hai → 403 |
| `DELETE /api/events/<code>` | Như PUT |
| `GET /api/events/<code>` | Công khai như cũ. `can_edit = true` nếu edit_key đúng **hoặc** JWT là owner. **Không bao giờ trả `edit_key`** |
| `GET /api/my-events` (mới) | JWT bắt buộc → danh sách event `owner_id = user` (code, title, updated_at) |
| `GET /api/config` (mới) | Công khai, trả `{ supabaseUrl, supabaseAnonKey }` — anon key vốn là public |

- Optimistic locking không đổi: PUT mang `expectedUpdatedAt`, lệch → 409; PUT/POST trả
  `updated_at` mới. `updated_at` vẫn nằm trên dòng `events`; toàn bộ ghi bảng con + bump
  `updated_at` trong **một transaction**.
- Lỗi 401 (chưa đăng nhập) phân biệt với 403 (không có quyền); message tiếng Việt, an toàn
  cho client; lỗi nội bộ vẫn qua `_server_error()`.

## 3. Backend: decompose/compose document

API giữ nguyên contract document. Backend thêm hai hàm đối xứng:

- **Compose** (GET): JOIN các bảng con theo `event_id`, dựng lại đúng shape JSON hiện tại
  (`members` là mảng tên theo `position`, `expenses` theo `position` với `beneficiaries`
  là mảng tên, `bankInfo` là map tên → {bank, account}, `couples`, `rates`).
- **Decompose** (POST/PUT): payload đã qua `validate_event_payload()` (không đổi) →
  trong một transaction: upsert dòng `events`, xóa toàn bộ bảng con của event, insert lại
  từ payload. PUT thay cả document nên delete+insert là đúng ngữ nghĩa và đơn giản nhất.
- **Khử trùng lặp khi decompose** (bắt buộc): `validate_event_payload()` không dedupe,
  nhưng schema có `UNIQUE(event_id, name)` và các PK theo `member_name`. Decompose phải
  khử trùng lặp theo tên — giữ lần xuất hiện đầu — cho `members`, `beneficiaries` của
  từng expense, và `couple_members`. (Tham chiếu theo tên nên các bản sao vốn không
  phân biệt được; hành vi hiển thị không đổi.)
- `POST /api/events/lookup` (batch cho "Sự Kiện Của Tôi") chỉ cần bảng `events` — giữ nguyên.

**Bất biến round-trip:** PUT document D rồi GET phải trả về document tương đương D
(cùng nội dung, thứ tự giữ nguyên). Có test tự động cho bất biến này.

## 4. Frontend

- Modal đăng nhập/đăng ký tiếng Việt (email/password + nút "Đăng nhập với Google");
  header hiện email + nút đăng xuất khi có session.
- Bấm "Tạo sự kiện" khi chưa đăng nhập → mở modal đăng nhập thay vì gọi API.
- "Sự Kiện Của Tôi": có session → `GET /api/my-events` **gộp** với danh sách localStorage
  (event được share vẫn hiện); không session → localStorage như cũ.
- Wrapper `authFetch` (hoặc tương đương trong `$.ajax`) tự gắn header Authorization khi
  có session.
- Boot: gọi `GET /api/config` để lấy Supabase URL + anon key rồi khởi tạo supabase-js
  (`index.html` giữ nguyên không Jinja).
- Quy ước giữ nguyên: mọi render dữ liệu user (kể cả email) qua `escapeHtml()`/`.text()`;
  confirm qua `showConfirm()`; autosave `saveEvent(false)` đúng một lần mỗi mutation;
  bump `CACHE_VERSION` trong `static/sw.js`.
- Logic chia tiền (`static/split.js`) **không đổi**.

## 5. Script migrate dữ liệu cũ

`migrate_to_supabase.py` (chạy tay một lần, chạy lại được):

- Đọc `OLD_DATABASE_URL` (Neon), parse JSON blob từng event qua chính
  `validate_event_payload()` để chuẩn hóa, ghi vào schema mới ở `DATABASE_URL` (Supabase).
- Transaction per-event; event lỗi parse thì log và bỏ qua, không chặn cả đợt.
- Idempotent: upsert theo `event_code` (event đã tồn tại → xóa bảng con, ghi lại).
- Giữ nguyên `event_code`, `edit_key`, `created_at`, `updated_at`; `owner_id = NULL`.
- In báo cáo cuối: số event migrate thành công / lỗi.

Event `owner_id = NULL`: không ai là owner, chỉ sửa được qua `edit_key` (và rule adopt
key NULL như cũ) — đúng hành vi hiện tại, link cũ sống nguyên vẹn.

## 6. Kiểm thử

- `test_api.py` (integration, cần server + DB thật) mở rộng:
  - Tạo user test qua Supabase Admin API (`service_role` key — chỉ dùng trong test, env
    `SUPABASE_SERVICE_ROLE_KEY`), đăng nhập lấy access token thật.
  - Ma trận quyền: POST không token / token rác / token hết hạn → 401; POST có token
    → 201 + edit_key; PUT bằng
    edit_key → 200; PUT bằng owner JWT (không edit_key) → 200; PUT sai cả hai → 403;
    GET công khai không lộ edit_key; `can_edit` đúng theo từng vai; 409 khi
    `expectedUpdatedAt` lệch; DELETE dọn dữ liệu test (kể cả user test).
  - Round-trip: PUT document đầy đủ (members, expenses đa tiền tệ, couples, bankInfo,
    rates) → GET trả về tương đương.
- Unit (không cần DB): monkeypatch `get_db_connection` + fake JWKS/JWT để test
  compose/decompose và nhánh phân quyền qua `app.test_client()`.
- `node test_split.js` giữ nguyên, phải vẫn pass.
- `node --check` cho các file JS sửa đổi.

## 7. Trình tự triển khai (2 giai đoạn, deploy độc lập)

1. **Giai đoạn 1 — Migrate DB:** schema mới + backend compose/decompose +
   `migrate_to_supabase.py` + trỏ `DATABASE_URL` sang Supabase pooler. App hoạt động
   y hệt cũ (chưa có auth). Rollback: trỏ `DATABASE_URL` về DB cũ.
2. **Giai đoạn 2 — Auth:** cấu hình Supabase Auth (bật Google provider), `GET /api/config`,
   UI đăng nhập, verify JWT, `owner_id`, `GET /api/my-events`, POST yêu cầu đăng nhập.

## 8. Cấu hình / môi trường

| Biến | Dùng ở | Ghi chú |
|---|---|---|
| `DATABASE_URL` | Flask | Trỏ sang Supabase pooler (transaction mode, port 6543) |
| `OLD_DATABASE_URL` | Script migrate | Connection string DB cũ (Neon), chỉ cần lúc migrate |
| `SUPABASE_URL` | Flask (`/api/config`, JWKS) | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | Flask (`/api/config`) | Public, trả cho frontend |
| `SUPABASE_SERVICE_ROLE_KEY` | Chỉ `test_api.py` | Bí mật, không bao giờ vào code chạy production |
| `RATELIMIT_STORAGE_URI` | Flask | Không đổi (Redis cho production) |

`requirements.txt` và `api/requirements.txt` thêm `PyJWT[crypto]` — hai file phải sync
(quy ước repo).

## Ngoài phạm vi (để dành đợt sau)

- Chuyển API document sang REST chi tiết từng resource (đã chốt "document trước, REST sau").
- FK theo member id thay vì tên (đi cùng đợt REST).
- Trang quản lý tài khoản (đổi email, xóa tài khoản), chuyển owner, cộng tác viên có tài khoản.
- Realtime (Supabase Realtime) cho đồng bộ giữa người xem.
