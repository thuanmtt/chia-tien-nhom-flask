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
# Creates and deletes a real event; BASE_URL defaults to http://localhost:5002
BASE_URL=http://localhost:5002 python3 test_api.py
```

There is no linter, bundler, or JS build step. To syntax-check the frontend, extract the inline `<script>` blocks from `templates/index.html` and run `node --check` on them.

When Postgres is unavailable locally, test backend logic by monkeypatching `vercel_app.get_db_connection` with a fake conn/cursor (in-memory dict of rows) and using `app.test_client()`. Routes that don't touch the DB (`/`, `/api/banks`, `/sw.js`, `/manifest.json`) work without any stub.

## Architecture

**Backend** — `vercel_app.py` is the entire backend. `api/index.py` is a thin Vercel entry point that adds the repo root to `sys.path` and imports it (`vercel.json` routes everything there). `validation.py` holds `validate_event_payload()` — every POST/PUT body goes through it (type checks + size caps, raises `ValidationError` with client-safe Vietnamese messages → 400).

**Storage model** — one `events` table, document-blob style: `members`, `expenses`, `bank_info`, `couples`, `rates` are JSON strings in TEXT columns. Clients PUT the whole document. Concurrency is handled with optimistic locking: PUT carries `expectedUpdatedAt` (the `updated_at` the client last saw); a mismatch returns 409 and the frontend reloads instead of overwriting. PUT/POST return the new `updated_at` (via SQL `RETURNING`).

**Auth model** — no user accounts. Two tokens per event:
- `event_code` — public identifier, appears in share links.
- `edit_key` — secret; returned **exactly once** by POST. `GET /api/events/<code>` must NEVER return it. PUT/DELETE require the `X-Edit-Key` header (compared with `hmac.compare_digest`) → 403 otherwise.
- GET accepts an optional `X-Edit-Key` and returns a `can_edit` flag; the frontend derives edit-vs-view UI entirely from this flag, not from URL shape.
- Legacy rows with NULL `edit_key`: anyone can write; the first write carrying a key "adopts" it (`_check_edit_permission`), after which that key is required.

**Share links** — view: `/?event_code=X`; edit: `/?event_code=X&key=<edit_key>`. `/share/<code>` and `/event/<code>` are legacy routes that redirect to `/?event_code=X` (the JS also keeps a `/share/` path branch for the offline/service-worker fallback case). `index.html` contains no Jinja expressions; all routing state is parsed from the URL in JS.

**Frontend** — `templates/index.html` is the entire SPA (~3.5k lines of inline JS/CSS; jQuery + Bootstrap from CDN). Key state lives in localStorage: `currentEventCode`, `savedEventCodes` (the "Sự Kiện Của Tôi" list), `eventEditKeys` (map event_code → edit key), `bankInfo`. `loadEventFromServer` sends the stored key, sets `allowEdit` from `can_edit`, deletes invalid keys, and flips the UI to view-only; a 403 on save does the same.

**Money model** — all computation is normalized to VND. Expenses may carry a foreign `currency`; conversion uses the per-event `rates` map (`amountInVND()` returns `null` when a rate is missing, which blocks calculation and shows warnings). Exchange rates come from `/api/exchange-rates` with a fallback chain (fawazahmed0 → open.er-api.com → Vietcombank). The split algorithm (`calculateSplit`) is client-side: per-member balances → "nhóm chung quỹ" (couples) merged into a primary member → greedy creditor/debtor matching. Beneficiaries semantics: `benefitType === 'all'` means the CURRENT member list at calculation time (the stored `beneficiaries` snapshot is ignored — see `getExpenseBeneficiaries()`); only `'selected'` uses the stored list.

## Conventions and gotchas

- **XSS**: every render of user-controlled data (member names, expense titles, event titles, couple labels, currency codes, dates from saved data) must go through `escapeHtml()` or jQuery `.text()`/`.val()`. `showToast` sets its body via `.text()`. Events are shared via links, so any unescaped interpolation is a stored-XSS vector. Maintain this in all new UI code.
- **Error handling**: internal errors go through `_server_error()` (logs server-side, returns a generic message — never `str(e)` to the client). Broad `except Exception` blocks around request-body reads must re-raise `HTTPException` first, or a 413 silently becomes a 500.
- **CDN scripts** carry SRI `integrity` hashes. Changing a library version requires recomputing: `curl -sfL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
- **Rate limiting**: flask-limiter with storage from `RATELIMIT_STORAGE_URI` (default `memory://`, which is ineffective on Vercel serverless — production should point at Redis).
- **Autosave**: every mutating action calls `saveEvent(false)` exactly once; saves are serialized in `saveEvent` (one in-flight request, extra calls coalesce into a single follow-up). Do NOT add `saveEvent` calls to render/calculate paths — `calculateSplit` deliberately does not save.
- `requirements.txt` (repo root, local dev) and `api/requirements.txt` (used by Vercel) must be kept in sync.
