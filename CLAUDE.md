# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ứng dụng chia tiền nhóm (Vietnamese group expense-splitting web app). Flask + Postgres, deployed on Vercel. UI text, comments, and error messages are in Vietnamese — keep them that way.

## Commands

```bash
# Run locally (requires a Postgres — there is no SQLite fallback)
DATABASE_URL=postgres://... python3 vercel_app.py   # → http://localhost:5002

# Create/migrate schema (idempotent, must be run manually — no auto-migration)
psql "$DATABASE_URL" -f schema.sql

# Integration tests (plain script, not pytest) — needs a running server + real DB.
# Creates and deletes a real event and a real Supabase test user; BASE_URL defaults
# to http://localhost:5002. Requires SUPABASE_URL, SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY (service_role — test-only, never referenced in app code).
BASE_URL=http://localhost:5002 SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... python3 test_api.py

# Unit tests for the split algorithm (pure logic, no server/DB needed)
node test_split.js

python3 test_event_store.py   # unit test decompose/compose (không cần DB)
python3 test_supabase_auth.py   # unit test verify JWT (không cần DB/mạng)

# Syntax-check the frontend
node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js
```

There is no linter, bundler, or JS build step.

When Postgres is unavailable locally, test backend logic by monkeypatching `vercel_app.get_db_connection` with a fake conn/cursor (in-memory dict of rows) and using `app.test_client()`. Routes that don't touch the DB (`/`, `/api/banks`, `/sw.js`, `/manifest.json`) work without any stub.

## Architecture

**Backend** — `vercel_app.py` is the entire backend. `api/index.py` is a thin Vercel entry point that adds the repo root to `sys.path` and imports it (`vercel.json` routes everything there). `validation.py` holds `validate_event_payload()` — every POST/PUT body goes through it (type checks + size caps, raises `ValidationError` with client-safe Vietnamese messages → 400).

**Storage model** — schema quan hệ trên Supabase Postgres (`schema.sql`): bảng `events`
(title, event_code, edit_key, owner_id, updated_at) + các bảng con `members`, `expenses`,
`expense_beneficiaries`, `member_bank_info`, `couples`, `couple_members`, `event_rates`.
Thành viên định danh bằng TÊN (member_name text, không FK id) — đúng ngữ nghĩa document
của client (chấp nhận tên "mồ côi"). API vẫn kiểu document: client GET/PUT cả document;
`event_store.py` decompose/compose (PUT = xóa bảng con + insert lại trong 1 transaction,
khử trùng lặp tên vì validation không dedupe). Concurrency: optimistic locking như cũ
(`expectedUpdatedAt` → 409). Kết nối qua Supabase pooler transaction mode (port 6543).
Bảng nào cũng bật RLS không policy — chặn PostgREST công khai; Flask (role postgres,
owner bảng) không bị ảnh hưởng. `migrate_to_supabase.py` chuyển dữ liệu từ DB cũ.

**Auth model** — no user accounts. Two tokens per event:
- `event_code` — public identifier, appears in share links.
- `edit_key` — secret; returned **exactly once** by POST. `GET /api/events/<code>` must NEVER return it. PUT/DELETE require the `X-Edit-Key` header (compared with `hmac.compare_digest`) → 403 otherwise.
- GET accepts an optional `X-Edit-Key` and returns a `can_edit` flag; the frontend derives edit-vs-view UI entirely from this flag, not from URL shape.
- Legacy rows with NULL `edit_key`: anyone can write; the first write carrying a key "adopts" it (`_check_edit_permission`), after which that key is required.
- `POST /api/events` now requires a Supabase JWT (`Authorization: Bearer <token>`) → 401 if missing/invalid; the creating user becomes `owner_id`. The owner's JWT grants full rights (GET/PUT/DELETE) on their own events with no `edit_key` needed — checked by comparing `owner_id` to the verified user id. `supabase_auth.py` verifies tokens offline via JWKS (`PyJWKClient`, cached per-process) — no network call per request. `GET /api/config` serves the public `SUPABASE_URL`/anon key to the frontend. `GET /api/my-events` (JWT required) lists events owned by the caller.

**Share links** — view: `/?event_code=X`; edit: `/?event_code=X&key=<edit_key>`. `/share/<code>` and `/event/<code>` are legacy routes that redirect to `/?event_code=X` (the JS also keeps a `/share/` path branch for the offline/service-worker fallback case). `index.html` contains no Jinja expressions; all routing state is parsed from the URL in JS.

**Frontend** — SPA in three files: `templates/index.html` (markup only, no Jinja), `static/app.css`, and `static/app.js` (~2.8k lines; jQuery + Bootstrap from CDN). `static/auth.js` (`window.AppAuth`) wraps Supabase Auth (email/password + Google) and must be loaded before `app.js`; `app.js`'s boot code runs inside `AppAuth.onReady(...)` so it waits for the initial session check. `static/split.js` holds the pure split-money logic (`SplitLogic`, UMD — used by `app.js` in the browser and by `test_split.js` in Node); `app.js` only binds it to page state and renders. Key state lives in localStorage: `currentEventCode`, `savedEventCodes` (the "Sự Kiện Của Tôi" list, loaded via one batch `POST /api/events/lookup` — codes missing from the response get pruned), `eventEditKeys` (map event_code → edit key), `bankInfo`. `loadEventFromServer` sends the stored key, sets `allowEdit` from `can_edit`, deletes invalid keys, and flips the UI to view-only; a 403 on save does the same. Confirmation dialogs go through `showConfirm()` (the shared `#confirmModal`, which must stay LAST among the modals in the DOM so it stacks on top) — don't reintroduce native `confirm()`. `saveEvent` drives the `#saveStatus` header indicator (`setSaveStatus`: saving/saved/error).

**Service worker** (`static/sw.js`) — `/static/app.js`, `app.css`, `split.js` are served network-first (they change on deploy and have no hashed filenames); icons/banks.json are cache-first. Bump `CACHE_VERSION` when changing caching behavior.

**Money model** — all computation is normalized to VND. Expenses may carry a foreign `currency`; conversion uses the per-event `rates` map (`amountInVND()` returns `null` when a rate is missing, which blocks calculation and shows warnings). Exchange rates come from `/api/exchange-rates` with a fallback chain (fawazahmed0 → open.er-api.com → Vietcombank). The split algorithm is client-side in `SplitLogic.computeSplit` (`static/split.js`, unit-tested by `test_split.js`): per-member balances → "nhóm chung quỹ" (couples) merged into a primary member → balances rounded to integer VND with rounding drift folded into the largest balance (so transfers settle exactly, no 1-đồng leftovers) → greedy creditor/debtor matching. Beneficiaries semantics: `benefitType === 'all'` means the CURRENT member list at calculation time (the stored `beneficiaries` snapshot is ignored — see `getExpenseBeneficiaries()`); only `'selected'` uses the stored list.

## Conventions and gotchas

- **XSS**: every render of user-controlled data (member names, expense titles, event titles, couple labels, currency codes, dates from saved data) must go through `escapeHtml()` or jQuery `.text()`/`.val()`. `showToast` sets its body via `.text()`. Events are shared via links, so any unescaped interpolation is a stored-XSS vector. Maintain this in all new UI code.
- **Error handling**: internal errors go through `_server_error()` (logs server-side, returns a generic message — never `str(e)` to the client). Broad `except Exception` blocks around request-body reads must re-raise `HTTPException` first, or a 413 silently becomes a 500.
- **CDN scripts** carry SRI `integrity` hashes. Changing a library version requires recomputing: `curl -sfL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
- **Rate limiting**: flask-limiter with storage from `RATELIMIT_STORAGE_URI` (default `memory://`, which is ineffective on Vercel serverless — production should point at Redis).
- **Autosave**: every mutating action calls `saveEvent(false)` exactly once; saves are serialized in `saveEvent` (one in-flight request, extra calls coalesce into a single follow-up). Do NOT add `saveEvent` calls to render/calculate paths — `calculateSplit` deliberately does not save.
- `requirements.txt` (repo root, local dev) and `api/requirements.txt` (used by Vercel) must be kept in sync.
