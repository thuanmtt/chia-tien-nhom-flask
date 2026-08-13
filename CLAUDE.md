# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ứng dụng chia tiền nhóm (Vietnamese group expense-splitting web app). Flask + Postgres, deployed on Vercel. UI text, comments, and error messages are in Vietnamese — keep them that way.

## Commands

```bash
# Run locally (requires a Postgres — there is no SQLite fallback).
# Env đọc từ file .env ở repo root (python-dotenv, không ghi đè biến export sẵn;
# xem .env.example). Trên Vercel không có .env — env đặt trong project settings.
python3 vercel_app.py   # → http://localhost:5002

# Create/migrate schema (idempotent, must be run manually — no auto-migration)
psql "$DATABASE_URL" -f schema.sql

# Integration tests (plain script, not pytest) — needs a running server + real DB.
# Creates and deletes a real event and a real Supabase test user. Đọc env từ .env
# (cần SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — service key
# chỉ dùng trong test, never referenced in app code). BASE_URL mặc định :5002.
python3 test_api.py

# Unit tests for the split algorithm (pure logic, no server/DB needed)
node test_split.js

python3 test_event_store.py   # unit test decompose/compose (không cần DB)
python3 test_supabase_auth.py   # unit test verify JWT (không cần DB/mạng)
python3 test_revision_diff.py   # unit test diff lịch sử chỉnh sửa (không cần DB)

# Syntax-check the frontend
node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js
```

There is no linter, bundler, or JS build step.

When Postgres is unavailable locally, test backend logic by monkeypatching `vercel_app.get_db_connection` with a fake conn/cursor (in-memory dict of rows) and using `app.test_client()`. Routes that don't touch the DB (`/`, `/api/banks`, `/sw.js`, `/manifest.json`) work without any stub.

## Architecture

**Backend** — `vercel_app.py` is the entire backend. `api/index.py` is a thin Vercel entry point that adds the repo root to `sys.path` and imports it (`vercel.json` routes everything there). `validation.py` holds `validate_event_payload()` — every POST/PUT body goes through it (type checks + size caps, raises `ValidationError` with client-safe Vietnamese messages → 400).

**Storage model** — schema quan hệ trên Supabase Postgres (`schema.sql`): bảng `events`
(title, event_code, owner_id, share_access, share_role, updated_at) + các bảng con `members`, `expenses`,
`expense_beneficiaries`, `member_bank_info`, `couples`, `couple_members`, `event_rates`.
Thành viên định danh bằng TÊN (member_name text, không FK id) — đúng ngữ nghĩa document
của client (chấp nhận tên "mồ côi"). API vẫn kiểu document: client GET/PUT cả document;
`event_store.py` decompose/compose (PUT = xóa bảng con + insert lại trong 1 transaction,
khử trùng lặp tên vì validation không dedupe). Concurrency: optimistic locking như cũ
(`expectedUpdatedAt` → 409). Kết nối qua Supabase pooler transaction mode (port 6543).
Bảng nào cũng bật RLS không policy — chặn PostgREST công khai; Flask (role postgres,
owner bảng) không bị ảnh hưởng. `migrate_to_supabase.py` chuyển dữ liệu từ DB cũ.
Bảng `event_collaborators` (event_id, user_id, role viewer/editor): người được mời
đích danh — quyền CỘNG DỒN với quyền chung (owner / event không chủ / share link).
Bảng `saved_events` (user_id, event_id): event user LƯU vào "Sự Kiện Của Tôi" —
bookmark theo tài khoản, không mang quyền.

Lịch sử chỉnh sửa: bảng `event_revisions` (actor, kind create/edit/restore/share, summary
diff tiếng Việt từ `revision_diff.py`, snapshot JSONB cả document SAU hành động) — ghi trong
CÙNG transaction với save qua `revision_store.py` (squash chuỗi update cùng đối tượng cùng
actor trong 10 phút; giữ 200 bản/event). `GET /api/events/<code>/revisions` (quyền sửa) xem
lịch sử; `POST /api/events/<code>/restore` khôi phục snapshot (validate lại, log dòng
'restore', optimistic locking 409). Xóa event vẫn là DELETE cứng — revisions mất theo.

**Auth model** — tài khoản Supabase bắt buộc cho MỌI thao tác ghi (xem bullet bên dưới); cơ chế `edit_key`/`X-Edit-Key` đã BỎ HOÀN TOÀN (không còn `hmac` trong `vercel_app.py`) — quyền trên từng event do `_check_edit_permission` xét theo:
- `event_code` — public identifier, appears in share links.
- Owner (`owner_id`, so khớp `sub` trong JWT) — toàn quyền: GET/PUT/DELETE/sharing/collaborators.
- `event_collaborators` vai trò `editor` — sửa nội dung + đổi `/sharing`, KHÔNG xóa.
- `share_access='link'` + `share_role='editor'` — ai có link đều PUT được, KHÔNG xóa
  (DELETE luôn gọi `_check_edit_permission(..., allow_link_editor=False)`).
- Event KHÔNG có chủ (`owner_id IS NULL` — event legacy/migrate từ trước khi có đăng
  nhập): mặc định ai đăng nhập cũng sửa VÀ xóa được, và luôn xem được bất kể
  `share_access` (không có ai để giới hạn về). `PUT /sharing` từ chối đặt `restricted`
  cho event không chủ → 400.
- `POST /api/events` yêu cầu Supabase JWT (`Authorization: Bearer <token>`) → 401 nếu
  thiếu/không hợp lệ; người tạo thành `owner_id`. KHÔNG còn sinh/trả `edit_key`; GET
  không nhận (bỏ qua hoàn toàn) header `X-Edit-Key`. Link cũ dạng
  `/?event_code=X&key=<gì đó>` vẫn mở được — tham số `key` bị bỏ qua, không còn tác
  dụng gì. `supabase_auth.py` verifies tokens offline via JWKS (`PyJWKClient`, cached
  per-process) — no network call per request. `GET /api/config` serves the public
  `SUPABASE_URL`/anon key to the frontend.
- **"Sự Kiện Của Tôi"**: `GET /api/my-events` (JWT) = event sở hữu ∪ được mời đích danh
  (`event_collaborators`) ∪ đã lưu (`saved_events`), sắp `updated_at DESC`, kèm cờ
  `owned` (frontend phân biệt nút "Xóa sự kiện" / "Gỡ khỏi danh sách"). `POST
  /api/my-events/save` `{codes: [...]}` (≤50 mã/lần) lưu bookmark — idempotent, cap
  200 event đã lưu / user (đếm + chèn trong CÙNG một câu lệnh SQL để thu hẹp race
  khi 2 request đồng thời). `DELETE /api/my-events/<code>` gỡ bookmark, KHÔNG đụng
  event. Cả 3 endpoint rate limit `30 per minute; 500 per day`.
- **Username**: bảng `user_profiles` (user_id → username duy nhất, lowercase, regex `_USERNAME_RE`). `GET/PUT /api/profile` (JWT) đọc/đặt/xóa username. `POST /api/auth/login` nhận `{identifier, password}` — identifier không có `@` thì tra email qua `user_profiles JOIN auth.users` rồi đổi lấy session bằng GoTrue password grant (server-side, anon key); mọi thất bại trả cùng message 401 để không lộ username/email tồn tại. Frontend: modal `#accountModal` (menu user → "Tài khoản") đặt username + đặt/đổi mật khẩu (`updateUser`; có mật khẩu cũ thì xác minh bằng `signInWithPassword` trước; tài khoản Google chưa có mật khẩu — nhận biết qua identity `provider === 'email'` — chỉ hỏi mật khẩu mới).
- **Mọi thao tác ghi yêu cầu đăng nhập**: PUT/DELETE/sharing/restore trả 401 khi thiếu JWT
     (401 = chưa đăng nhập, 403 = không có quyền). Quyền (owner / collaborator editor /
     link-editor / event không chủ, như trên) vẫn quyết định QUYỀN; JWT chỉ để gắn danh
     tính. GET không cần đăng nhập; `can_edit` = có quyền VÀ đã đăng nhập, kèm cờ
     `login_required_to_edit` khi có quyền mà chưa đăng nhập (UI hiện banner mời đăng nhập).
- **Người được mời đích danh** (`event_collaborators`, thêm qua email/username — resolve
     server-side qua `auth.users`/`user_profiles`): `viewer` xem được event Hạn chế; `editor`
     sửa nội dung + đổi /sharing nhưng KHÔNG xóa event. CHỈ owner quản lý danh sách
     (3 endpoint `/api/events/<code>/collaborators`, tối đa 50 người). GET event trả thêm
     `is_owner` — frontend chỉ hiện UI quản lý người cho owner. Thêm/đổi/gỡ đều ghi
     revision kind 'share'.

**Share links & quyền truy cập (kiểu Google Docs)** — link chia sẻ duy nhất `/?event_code=X`; quyền do 2 cột trên `events` quyết: `share_access` (`'restricted'` | `'link'`) + `share_role` (`'viewer'` | `'editor'`), mặc định `link`+`viewer`. `restricted`: GET trả 403 trừ owner/người được mời đích danh (event_collaborators) — event KHÔNG có chủ luôn xem được bất kể `share_access` (không có ai để giới hạn về); lookup cũng ẩn trừ owner và người được mời. `link`+`editor`: ai có link đều PUT được (không cần được mời riêng), nhưng KHÔNG xóa được — DELETE gọi `_check_edit_permission(..., allow_link_editor=False)`. Đổi cài đặt qua `PUT /api/events/<code>/sharing` (ai có quyền sửa đều đổi được, không bump `updated_at`; đặt `restricted` cho event không chủ bị từ chối → 400). Link cũ `/?event_code=X&key=...` vẫn mở được — tham số `key` bị bỏ qua (cơ chế edit key đã bỏ hoàn toàn). `/share/<code>` and `/event/<code>` are legacy routes that redirect to `/?event_code=X` (the JS also keeps a `/share/` path branch for the offline/service-worker fallback case). `index.html` contains no Jinja expressions; all routing state is parsed from the URL in JS.

**Frontend** — SPA in three files: `templates/index.html` (markup only, no Jinja), `static/app.css`, and `static/app.js` (~2.8k lines; jQuery + Bootstrap from CDN). `static/auth.js` (`window.AppAuth`) wraps Supabase Auth (email/password + Google) and must be loaded before `app.js`; `app.js`'s boot code runs inside `AppAuth.onReady(...)` so it waits for the initial session check. `static/split.js` holds the pure split-money logic (`SplitLogic`, UMD — used by `app.js` in the browser and by `test_split.js` in Node); `app.js` only binds it to page state and renders. Key state lives in localStorage: `currentEventCode`, `savedEventCodes` (the "Sự Kiện Của Tôi" list — used ONLY when logged out; loaded via one batch `POST /api/events/lookup` — codes missing from the response get pruned), `bankInfo`. `eventEditKeys` is gone (a one-time `localStorage.removeItem('eventEditKeys')` runs at boot to clean up leftovers from older clients). Logged in: the list comes from `GET /api/my-events` (owned ∪ invited ∪ saved, with an `owned` flag) instead of localStorage; a one-time migration (`migrateLocalSavedEvents`, batches of 50, called from `AppAuth.onReady` and on `appauth:change`) pushes any local `savedEventCodes` to the account via `POST /api/my-events/save` and clears local storage only once that succeeds. The per-event action button reflects `owned`: owners see "Xóa sự kiện" (`.delete-event-btn`, hard delete); everyone else sees "Gỡ khỏi danh sách" (`.unsave-event-btn` — `DELETE /api/my-events/<code>` when logged in, local removal when logged out). Both handlers read the `data-event-code` attribute with `.attr()` rather than `.data()` (jQuery's `.data()` type-coerces all-numeric codes, corrupting them). `loadEventFromServer` sets `allowEdit` from `can_edit` and flips the UI to view-only; a 403 on save does the same. Confirmation dialogs go through `showConfirm()` (the shared `#confirmModal`, which must stay LAST among the modals in the DOM so it stacks on top) — don't reintroduce native `confirm()`. `saveEvent` drives the `#saveStatus` header indicator (`setSaveStatus`: saving/saved/error). Modal `#historyModal` (nút "Lịch sử" trên header, chỉ khi allowEdit) hiển thị revisions + nút khôi phục qua showConfirm; `#confirmModal` vẫn phải là modal CUỐI trong DOM.

**Service worker** (`static/sw.js`) — `/static/app.js`, `app.css`, `split.js` are served network-first (they change on deploy and have no hashed filenames); icons/banks.json are cache-first. Bump `CACHE_VERSION` when changing caching behavior.

**Money model** — all computation is normalized to VND. Expenses may carry a foreign `currency`; conversion uses the per-event `rates` map (`amountInVND()` returns `null` when a rate is missing, which blocks calculation and shows warnings). Exchange rates come from `/api/exchange-rates` with a fallback chain (fawazahmed0 → open.er-api.com → Vietcombank). The split algorithm is client-side in `SplitLogic.computeSplit` (`static/split.js`, unit-tested by `test_split.js`): per-member balances → "nhóm chung quỹ" (couples) merged into a primary member → balances rounded to integer VND with rounding drift folded into the largest balance (so transfers settle exactly, no 1-đồng leftovers) → greedy creditor/debtor matching. Beneficiaries semantics: mọi khoản chi lưu danh sách người hưởng ĐÍCH DANH — `getExpenseBeneficiaries()` luôn dùng `beneficiaries` đã lưu (lọc theo thành viên còn tồn tại), bất kể `benefitType`; chỉ fallback về danh sách hiện tại khi thiếu/rỗng. Form luôn lưu `benefitType: 'selected'` ("Tất cả" trên form chỉ là shortcut chốt đủ người lúc lưu); dữ liệu `'all'` cũ được `normalizeExpenses()` chuẩn hóa khi tải event và `migrate_beneficiaries.py` dọn một lần trên DB (đã chạy sau deploy). Thêm thành viên: hỏi có chia thêm vào các khoản đang phủ đủ thành viên cũ không (`countFullCoverage`/`addBeneficiaryToFullCoverage`, mặc định KHÔNG). Xóa thành viên: gỡ tên khỏi các khoản chi kèm xác nhận; chặn nếu là người thanh toán hoặc người hưởng duy nhất của khoản nào đó.

## Conventions and gotchas

- **XSS**: every render of user-controlled data (member names, expense titles, event titles, couple labels, currency codes, dates from saved data) must go through `escapeHtml()` or jQuery `.text()`/`.val()`. `showToast` sets its body via `.text()`. Events are shared via links, so any unescaped interpolation is a stored-XSS vector. Maintain this in all new UI code.
- **Error handling**: internal errors go through `_server_error()` (logs server-side, returns a generic message — never `str(e)` to the client). Broad `except Exception` blocks around request-body reads must re-raise `HTTPException` first, or a 413 silently becomes a 500.
- **CDN scripts** carry SRI `integrity` hashes. Changing a library version requires recomputing: `curl -sfL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
- **Rate limiting**: flask-limiter with storage from `RATELIMIT_STORAGE_URI` (default `memory://`, which is ineffective on Vercel serverless — production should point at Redis).
- **Autosave**: every mutating action calls `saveEvent(false)` exactly once; saves are serialized in `saveEvent` (one in-flight request, extra calls coalesce into a single follow-up). Do NOT add `saveEvent` calls to render/calculate paths — `calculateSplit` deliberately does not save.
- `requirements.txt` (repo root, local dev) and `api/requirements.txt` (used by Vercel) must be kept in sync.
