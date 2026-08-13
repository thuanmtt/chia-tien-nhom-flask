# Tăng tốc tải sự kiện — 3 cải tiến sau khi ghim region sin1

Ngày: 2026-08-13. Tiếp nối fix `regions: sin1` (commit b3a8806). Scope đã chốt với
user: (1) song song hóa waterfall boot frontend, (2) lazy-load thư viện export,
(3) gộp 7 query con khi đọc event. Không đổi hành vi/ngữ nghĩa nào của app.

## Hiện trạng (nguồn chậm còn lại)

Boot khi mở link event: tải HTML → 8 script CDN đồng bộ (~1.5MB lần đầu, trong đó
xlsx ~900KB, jsPDF ~350KB, Chart.js ~200KB chỉ dùng sau boot) → `auth.js init()`:
`fetch /api/config` → `getSession()` (có thể refresh token qua mạng) → lúc đó
`AppAuth.onReady` mới cho `loadEventFromServer` bắn GET event. Ba chặng mạng tuần
tự trước khi request quan trọng nhất xuất phát. Backend GET event chạy 7 query con
tuần tự trong `load_event_children` (giờ ~vài ms/query sau khi cùng region, nhưng
vẫn là 7 round-trip thừa).

## Cải tiến 1 — GET event song song với khởi tạo auth (`app.js`, `auth.js`)

- Ngay đầu boot (trong `$(document).ready` của app.js), nếu URL/localStorage có
  event code: đọc access token đã lưu của supabase-js **đồng bộ** từ localStorage
  (key `sb-*-auth-token`, chỉ dùng khi `expires_at` còn >30s) và bắn
  `$.ajax GET /api/events/<code>` NGAY — song song với `/api/config` + `getSession`.
- `auth.js` thêm export `AppAuth.accessToken()` (token của session hiện tại, null
  nếu chưa đăng nhập).
- `loadEventFromServer` nhận nuôi (adopt) request sớm này CHỈ KHI: đúng event code
  VÀ token dùng lúc bắn === `AppAuth.accessToken()` lúc auth xong (cả hai null =
  cùng ẩn danh). Lệch (token hết hạn vừa được refresh, đổi user, project cũ) →
  bỏ kết quả sớm, request lại như cũ — đúng bằng hành vi hiện tại, không tệ hơn.
- Request sớm không gắn handler cho tới khi được nhận nuôi → 403/404 sớm không
  kích toast/createNewEvent trước khi auth sẵn sàng.
- `loadEventFromServer` chuyển từ options `success:`/`error:` sang `.done/.fail`
  trên jqXHR (tương đương) để dùng chung cho cả hai đường.
- Trường hợp thường gặp (token còn hạn / chưa đăng nhập): tiết kiệm toàn bộ thời
  gian config+getSession (~0.4–0.8s). Trường hợp token hết hạn: như cũ.

## Cải tiến 2 — Lazy-load thư viện chỉ dùng sau boot (`index.html`, `app.js`)

- Gỡ 4 thẻ script khỏi index.html: Chart.js, xlsx, jsPDF, jspdf-autotable
  (~1.5MB không còn chặn parse/exec trước app.js ở lần ghé đầu).
- Giữ eager: jQuery, Bootstrap, select2 (dropdown ngân hàng dùng ở modal), supabase-js (auth boot).
- app.js thêm `loadScriptOnce(src, integrity)` (inject `<script>` + SRI + crossorigin,
  cache promise, lỗi thì xóa cache để bấm lại thử lại được) + 3 wrapper:
  `ensureChartJs()`, `ensureXlsx()`, `ensureJsPdf()` (jspdf → autotable tuần tự).
  SRI hash giữ nguyên từ index.html.
- `renderDailyStats`: nếu `typeof Chart === 'undefined'` → `ensureChartJs()` rồi
  gọi lại chính nó; lỗi tải → ẩn container biểu đồ (trước đây script tag hỏng sẽ
  ném ReferenceError vỡ luôn render — hành vi mới an toàn hơn).
- Nút xuất Excel/PDF: `ensure*()` trước rồi mới chạy export; lỗi tải → toast.
  Guard `typeof XLSX === 'undefined'` sẵn có giữ nguyên làm lưới an toàn.
- sw.js không đổi (SW bỏ qua cross-origin; caching behavior không đổi → không bump
  CACHE_VERSION).

## Cải tiến 3 — Gộp 7 query con thành 1 (`event_store.py`)

- `load_event_children` chạy MỘT câu SELECT gồm 7 scalar subquery
  `coalesce(json_agg(json_build_object(...) ORDER BY position), '[]')` — mỗi
  subquery trả nguyên một bảng con dạng JSON array, alias đúng tên key mà
  `rows_to_document` nhận (`members`, `expenses`, `expense_beneficiaries`,
  `member_bank_info`, `couples`, `couple_members`, `event_rates`).
- psycopg2 tự parse cột json → list[dict] → đưa thẳng vào `rows_to_document`
  (không đổi hàm này). numeric → JSON number → float, khớp `_num()` hiện tại.
- Interface `load_event_children(cursor, event_id)` giữ nguyên → GET event,
  restore, revision snapshot không đổi.
- `load_events_summary` (my-events/lookup, 4 query) giữ nguyên — ngoài scope.

## Kiểm thử

- Backend: script round-trip trên DB thật (tạo event tạm → `replace_event_children`
  → `load_event_children` → so sánh document → xóa), chạy với bản cũ làm baseline
  rồi bản mới, output phải giống hệt. Thêm `python3 test_event_store.py` (thuần) và
  `python3 test_api.py` (integration, server local + DB thật).
- Frontend: `node --check` cả 4 file JS; smoke test tay trên production sau deploy
  (mở link event: logged-out, logged-in, restricted; bấm xuất Excel/PDF; xem biểu đồ).

## Ngoài scope (YAGNI)

- Cache /api/config vào localStorage (rủi ro stale khi đổi Supabase project).
- Bắn early-fetch từ inline script trong `<head>` (thêm điểm rẽ kiến trúc, lợi nhỏ).
- Gộp query `load_events_summary`.
