# Supabase Migration + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển storage từ 1 bảng JSON-blob sang schema quan hệ trên Supabase Postgres, rồi thêm đăng ký/đăng nhập (email/password + Google) bằng Supabase Auth.

**Architecture:** Hybrid — frontend dùng supabase-js cho auth; dữ liệu vẫn đi qua Flask API (contract document GET/PUT giữ nguyên); Flask verify JWT của Supabase qua JWKS và decompose/compose document ↔ các bảng quan hệ trong một transaction. Spec đầy đủ: `docs/superpowers/specs/2026-08-10-supabase-migration-auth-design.md`.

**Tech Stack:** Flask 2.3 + psycopg2, Supabase (Postgres + Auth), PyJWT[crypto], supabase-js v2 (CDN), jQuery/Bootstrap SPA hiện có.

## Global Constraints

- Toàn bộ UI text, comment, error message bằng **tiếng Việt**.
- Mọi render dữ liệu user-controlled qua `escapeHtml()` hoặc `.text()`/`.val()` (chống stored-XSS).
- API contract document **không đổi**: GET/PUT cả document; PUT mang `expectedUpdatedAt` → 409 khi lệch; PUT/POST trả `updated_at` mới; GET **không bao giờ** trả `edit_key`.
- `edit_key` so sánh bằng `hmac.compare_digest`; rule "adopt" key cho event có `edit_key` NULL giữ nguyên.
- Lỗi nội bộ qua `_server_error()` (không lộ `str(e)`); `except Exception` quanh request-body phải re-raise `HTTPException` trước.
- `templates/index.html` không chứa Jinja expression.
- Script CDN phải có SRI `integrity` hash: `curl -sfL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
- `requirements.txt` và `api/requirements.txt` luôn sync.
- Đổi hành vi caching/danh sách file trong `static/sw.js` → bump `CACHE_VERSION`.
- `#confirmModal` phải là modal CUỐI CÙNG trong DOM.
- Bảng mới trên Supabase: bật RLS, **không** tạo policy (deny-all cho PostgREST); Flask kết nối qua pooler transaction mode (port 6543).
- Bất biến round-trip: PUT document D → GET trả document tương đương D.
- Test là plain script (không pytest): `python3 test_*.py`, `node test_split.js`.

## Điều kiện tiên quyết (làm tay, một lần)

Trước Task 6 cần có project Supabase:

1. Tạo project tại https://supabase.com/dashboard (region gần VN, ví dụ Singapore).
2. Lấy **connection string pooler**: Project Settings → Database → Connection string → Transaction mode (port **6543**, dạng `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`). Đây là `DATABASE_URL` mới.
3. Lấy Project Settings → API: **Project URL** (`SUPABASE_URL`), **anon key** (`SUPABASE_ANON_KEY`), **service_role key** (`SUPABASE_SERVICE_ROLE_KEY` — chỉ dùng cho test, không deploy vào Vercel).
4. Trước Task 12 (auth): Authentication → Providers → bật **Google** (cần OAuth Client ID/Secret từ Google Cloud Console, authorized redirect URI lấy từ dashboard Supabase); Authentication → URL Configuration → thêm domain production + `http://localhost:5002` vào Redirect URLs.

---

# GIAI ĐOẠN 1 — MIGRATE DB SANG SCHEMA QUAN HỆ

Sau giai đoạn này app hoạt động **y hệt cũ** (chưa có auth), chỉ khác DB bên dưới.

### Task 1: Schema quan hệ mới (`schema.sql`)

**Files:**
- Rewrite: `schema.sql`

**Interfaces:**
- Produces: 8 bảng (`events`, `members`, `expenses`, `expense_beneficiaries`, `member_bank_info`, `couples`, `couple_members`, `event_rates`) mà Task 2-5 đọc/ghi.

- [ ] **Step 1: Thay toàn bộ nội dung `schema.sql`**

```sql
-- Schema quan hệ (v2) cho Supabase Postgres. Idempotent — chạy lại nhiều lần không sao:
--   psql "$DATABASE_URL" -f schema.sql
-- KHÔNG chạy file này lên DB cũ (Neon) — DB cũ giữ nguyên để migrate_to_supabase.py đọc.
-- Thành viên được định danh bằng TÊN trong toàn bộ document model, nên các bảng con
-- tham chiếu member_name (text) thay vì FK id — giữ đúng ngữ nghĩa client hiện tại.

CREATE TABLE IF NOT EXISTS events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_code text UNIQUE NOT NULL,
    title      text NOT NULL,
    edit_key   text,
    -- id user Supabase Auth; NULL = event legacy/migrate. Không FK sang auth.users
    -- để schema chạy được trên Postgres thường khi dev/test.
    owner_id   uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name     text NOT NULL,
    position int  NOT NULL,
    UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title        text NOT NULL DEFAULT '',
    amount       numeric NOT NULL DEFAULT 0,
    currency     text NOT NULL DEFAULT 'VND',
    payer_name   text NOT NULL DEFAULT '',
    benefit_type text NOT NULL DEFAULT 'all',
    expense_date text NOT NULL DEFAULT '',
    created_time text NOT NULL DEFAULT '',
    updated_time text NOT NULL DEFAULT '',
    position     int  NOT NULL
);

CREATE TABLE IF NOT EXISTS expense_beneficiaries (
    expense_id  uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    position    int  NOT NULL,
    PRIMARY KEY (expense_id, member_name)
);

CREATE TABLE IF NOT EXISTS member_bank_info (
    event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    bank        text NOT NULL DEFAULT '',
    account     text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, member_name)
);

CREATE TABLE IF NOT EXISTS couples (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    client_id    text NOT NULL DEFAULT '',
    label        text NOT NULL DEFAULT '',
    primary_name text NOT NULL DEFAULT '',
    position     int  NOT NULL
);

CREATE TABLE IF NOT EXISTS couple_members (
    couple_id   uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    member_name text NOT NULL,
    position    int  NOT NULL,
    PRIMARY KEY (couple_id, member_name)
);

CREATE TABLE IF NOT EXISTS event_rates (
    event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    currency_code text NOT NULL,
    rate          numeric,            -- NULL = thiếu tỷ giá (client hiện cảnh báo)
    source        text NOT NULL DEFAULT '',
    rate_date     text,
    rate_type     text,
    currency_name text NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_events_event_code ON events (event_code);
CREATE INDEX IF NOT EXISTS idx_events_owner_id   ON events (owner_id);
CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_event_id          ON members (event_id);
CREATE INDEX IF NOT EXISTS idx_expenses_event_id         ON expenses (event_id);
CREATE INDEX IF NOT EXISTS idx_member_bank_info_event_id ON member_bank_info (event_id);
CREATE INDEX IF NOT EXISTS idx_couples_event_id          ON couples (event_id);
CREATE INDEX IF NOT EXISTS idx_event_rates_event_id      ON event_rates (event_id);

-- Supabase expose PostgREST công khai với anon key → bật RLS, KHÔNG tạo policy
-- (deny-all cho anon/authenticated). Flask kết nối bằng role postgres (owner của
-- bảng) nên không bị chặn.
ALTER TABLE events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE members               ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses              ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_bank_info      ENABLE ROW LEVEL SECURITY;
ALTER TABLE couples               ENABLE ROW LEVEL SECURITY;
ALTER TABLE couple_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_rates           ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Kiểm tra idempotent (nếu đã có DATABASE_URL Supabase; nếu chưa, làm ở Task 6)**

Run: `psql "$DATABASE_URL" -f schema.sql && psql "$DATABASE_URL" -f schema.sql`
Expected: chạy 2 lần đều không lỗi (toàn `CREATE TABLE`/`NOTICE ... already exists`).

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "feat: schema quan hệ v2 cho Supabase (8 bảng, RLS deny-all)"
```

### Task 2: `event_store.py` — biến đổi thuần document ↔ rows + unit test

**Files:**
- Create: `event_store.py`
- Test: `test_event_store.py`

**Interfaces:**
- Consumes: document đã qua `validate_event_payload()` (shape trong docstring dưới).
- Produces (Task 3, 4, 5 dùng):
  - `document_to_rows(data: dict) -> dict` — dict 7 key: `members`, `expenses`, `expense_beneficiaries`, `member_bank_info`, `couples`, `couple_members`, `event_rates`; mỗi key là list dict (chưa có event_id).
  - `rows_to_document(rows: dict) -> dict` — nghịch đảo, trả `{members, expenses, bankInfo, couples, rates}` (không gồm title).

- [ ] **Step 1: Viết test round-trip thuần (chưa có module → sẽ fail)**

Tạo `test_event_store.py`:

```python
#!/usr/bin/env python3
"""Unit test thuần cho event_store (không cần DB/server): round-trip
document -> rows -> document phải giữ nguyên dữ liệu, và khử trùng lặp tên."""

import sys

from validation import validate_event_payload
from event_store import document_to_rows, rows_to_document

FULL_DOC = {
    'title': 'Đi Đà Lạt',
    'members': ['An', 'Bình', 'Chi'],
    'expenses': [
        {
            'title': 'Khách sạn', 'amount': 1500000, 'currency': 'VND',
            'payer': 'An', 'benefitType': 'all', 'beneficiaries': [],
            'expense_date': '2026-08-01', 'created_time': '2026-08-01T10:00:00',
            'updated_time': '2026-08-01T10:00:00',
        },
        {
            'title': 'Ăn tối', 'amount': 45.5, 'currency': 'USD',
            'payer': 'Bình', 'benefitType': 'selected',
            'beneficiaries': ['An', 'Chi'],
            'expense_date': '2026-08-02', 'created_time': '', 'updated_time': '',
        },
    ],
    'bankInfo': {'An': {'bank': 'VCB', 'account': '123456'}},
    'couples': [{'id': 'c1', 'label': 'Vợ chồng An', 'members': ['An', 'Bình'], 'primary': 'An'}],
    'rates': {'USD': {'rate': 25000, 'source': 'test', 'rateDate': '2026-08-01',
                      'rateType': 'mid', 'currencyName': 'US Dollar'}},
}


def test_roundtrip_full():
    doc = validate_event_payload(FULL_DOC)
    out = rows_to_document(document_to_rows(doc))
    for key in ('members', 'expenses', 'bankInfo', 'couples', 'rates'):
        assert out[key] == doc[key], f'round-trip lệch ở {key}:\n{out[key]}\n!=\n{doc[key]}'
    print('✅ round-trip document đầy đủ')


def test_roundtrip_empty():
    doc = validate_event_payload({'title': 'Trống', 'members': [], 'expenses': []})
    out = rows_to_document(document_to_rows(doc))
    assert out['members'] == [] and out['expenses'] == []
    assert out['bankInfo'] == {} and out['couples'] == [] and out['rates'] == {}
    print('✅ round-trip document rỗng')


def test_dedupe_names():
    # validate_event_payload KHÔNG khử trùng lặp — document_to_rows phải làm,
    # nếu không INSERT sẽ vỡ UNIQUE(event_id, name) / PK (expense_id, member_name).
    doc = validate_event_payload({
        'title': 'Trùng tên',
        'members': ['An', 'An', 'Bình'],
        'expenses': [{
            'title': 'Ăn', 'amount': 10, 'currency': 'VND', 'payer': 'An',
            'benefitType': 'selected', 'beneficiaries': ['An', 'An', 'Bình'],
            'expense_date': '', 'created_time': '', 'updated_time': '',
        }],
        'couples': [{'id': 'c1', 'label': 'x', 'members': ['An', 'An'], 'primary': 'An'}],
    })
    rows = document_to_rows(doc)
    assert [r['name'] for r in rows['members']] == ['An', 'Bình']
    assert [b['member_name'] for b in rows['expense_beneficiaries']] == ['An', 'Bình']
    assert [c['member_name'] for c in rows['couple_members']] == ['An']
    # Round-trip trả bản đã khử trùng lặp (hành vi hiển thị không đổi — tham
    # chiếu theo tên nên bản sao vốn không phân biệt được)
    out = rows_to_document(rows)
    assert out['members'] == ['An', 'Bình']
    print('✅ khử trùng lặp tên khi decompose')


def test_positions_preserve_order():
    doc = validate_event_payload({
        'title': 'Thứ tự', 'members': ['C', 'A', 'B'],
        'expenses': [
            {'title': 'e1', 'amount': 1, 'currency': 'VND', 'payer': 'C',
             'benefitType': 'all', 'beneficiaries': [], 'expense_date': '',
             'created_time': '', 'updated_time': ''},
            {'title': 'e2', 'amount': 2, 'currency': 'VND', 'payer': 'A',
             'benefitType': 'all', 'beneficiaries': [], 'expense_date': '',
             'created_time': '', 'updated_time': ''},
        ],
    })
    out = rows_to_document(document_to_rows(doc))
    assert out['members'] == ['C', 'A', 'B']
    assert [e['title'] for e in out['expenses']] == ['e1', 'e2']
    print('✅ giữ nguyên thứ tự members/expenses')


if __name__ == '__main__':
    test_roundtrip_full()
    test_roundtrip_empty()
    test_dedupe_names()
    test_positions_preserve_order()
    print('\n🎉 test_event_store: tất cả pass')
    sys.exit(0)
```

- [ ] **Step 2: Chạy test — phải FAIL**

Run: `python3 test_event_store.py`
Expected: `ModuleNotFoundError: No module named 'event_store'`

- [ ] **Step 3: Viết `event_store.py` (phần biến đổi thuần)**

```python
"""Chuyển đổi giữa document JSON của client và các bảng quan hệ.

Document (đầu ra của validate_event_payload):
  {title, members: [str],
   expenses: [{title, amount, currency, payer, benefitType, beneficiaries,
               expense_date, created_time, updated_time}],
   bankInfo: {tên: {bank, account}},
   couples: [{id, label, members, primary}],
   rates: {mã: {rate, source, rateDate, rateType, currencyName}}}

Phần "rows" trung gian là dict 7 key theo bảng; beneficiaries/couple_members nối
với expense/couple qua *_position (vì id do DB sinh, chưa có ở tầng thuần).
"""

import psycopg2.extras


def _dedupe_keep_first(names):
    """Khử trùng lặp, giữ lần xuất hiện đầu — bắt buộc trước khi INSERT vì
    schema có UNIQUE(event_id, name) và PK theo member_name, còn
    validate_event_payload không khử trùng lặp."""
    seen = set()
    out = []
    for name in names:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def document_to_rows(data):
    """Document đã validate → dict các list-dict theo bảng (chưa có event_id)."""
    member_rows = [
        {'name': name, 'position': i}
        for i, name in enumerate(_dedupe_keep_first(data.get('members') or []))
    ]

    expense_rows = []
    beneficiary_rows = []
    for i, exp in enumerate(data.get('expenses') or []):
        expense_rows.append({
            'title': exp.get('title', ''),
            'amount': exp.get('amount', 0),
            'currency': exp.get('currency', 'VND'),
            'payer_name': exp.get('payer', ''),
            'benefit_type': exp.get('benefitType', 'all'),
            'expense_date': exp.get('expense_date', ''),
            'created_time': exp.get('created_time', ''),
            'updated_time': exp.get('updated_time', ''),
            'position': i,
        })
        for j, name in enumerate(_dedupe_keep_first(exp.get('beneficiaries') or [])):
            beneficiary_rows.append({
                'expense_position': i, 'member_name': name, 'position': j,
            })

    bank_rows = [
        {'member_name': name, 'bank': info.get('bank', ''), 'account': info.get('account', '')}
        for name, info in (data.get('bankInfo') or {}).items()
    ]

    couple_rows = []
    couple_member_rows = []
    for i, couple in enumerate(data.get('couples') or []):
        couple_rows.append({
            'client_id': couple.get('id', ''),
            'label': couple.get('label', ''),
            'primary_name': couple.get('primary', ''),
            'position': i,
        })
        for j, name in enumerate(_dedupe_keep_first(couple.get('members') or [])):
            couple_member_rows.append({
                'couple_position': i, 'member_name': name, 'position': j,
            })

    rate_rows = [
        {
            'currency_code': code,
            'rate': entry.get('rate'),
            'source': entry.get('source', ''),
            'rate_date': entry.get('rateDate'),
            'rate_type': entry.get('rateType'),
            'currency_name': entry.get('currencyName', ''),
        }
        for code, entry in (data.get('rates') or {}).items()
    ]

    return {
        'members': member_rows,
        'expenses': expense_rows,
        'expense_beneficiaries': beneficiary_rows,
        'member_bank_info': bank_rows,
        'couples': couple_rows,
        'couple_members': couple_member_rows,
        'event_rates': rate_rows,
    }


def _num(value):
    """numeric từ DB về là Decimal — đổi sang float cho jsonify (Flask không
    serialize Decimal). Dữ liệu thuần (int/float) giữ nguyên."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    return float(value)


def rows_to_document(rows):
    """Nghịch đảo của document_to_rows (không gồm title)."""
    members = [
        r['name'] for r in sorted(rows.get('members', []), key=lambda r: r['position'])
    ]

    bens_by_expense = {}
    for b in rows.get('expense_beneficiaries', []):
        bens_by_expense.setdefault(b['expense_position'], []).append(b)

    expenses = []
    for r in sorted(rows.get('expenses', []), key=lambda r: r['position']):
        bens = sorted(bens_by_expense.get(r['position'], []), key=lambda b: b['position'])
        expenses.append({
            'title': r['title'],
            'amount': _num(r['amount']),
            'currency': r['currency'],
            'payer': r['payer_name'],
            'benefitType': r['benefit_type'],
            'beneficiaries': [b['member_name'] for b in bens],
            'expense_date': r['expense_date'],
            'created_time': r['created_time'],
            'updated_time': r['updated_time'],
        })

    bank_info = {
        r['member_name']: {'bank': r['bank'], 'account': r['account']}
        for r in rows.get('member_bank_info', [])
    }

    cms_by_couple = {}
    for cm in rows.get('couple_members', []):
        cms_by_couple.setdefault(cm['couple_position'], []).append(cm)

    couples = []
    for r in sorted(rows.get('couples', []), key=lambda r: r['position']):
        cms = sorted(cms_by_couple.get(r['position'], []), key=lambda c: c['position'])
        couples.append({
            'id': r['client_id'],
            'label': r['label'],
            'members': [c['member_name'] for c in cms],
            'primary': r['primary_name'],
        })

    rates = {
        r['currency_code']: {
            'rate': _num(r['rate']),
            'source': r['source'],
            'rateDate': r['rate_date'],
            'rateType': r['rate_type'],
            'currencyName': r['currency_name'],
        }
        for r in rows.get('event_rates', [])
    }

    return {
        'members': members,
        'expenses': expenses,
        'bankInfo': bank_info,
        'couples': couples,
        'rates': rates,
    }
```

- [ ] **Step 4: Chạy test — phải PASS**

Run: `python3 test_event_store.py`
Expected: 4 dòng ✅ và `🎉 test_event_store: tất cả pass`

- [ ] **Step 5: Commit**

```bash
git add event_store.py test_event_store.py
git commit -m "feat: event_store — biến đổi thuần document <-> rows, có unit test round-trip"
```

### Task 3: `event_store.py` — tầng SQL (ghi/đọc bảng con)

**Files:**
- Modify: `event_store.py` (thêm vào cuối file)

**Interfaces:**
- Consumes: `document_to_rows` / `rows_to_document` (Task 2).
- Produces (Task 4, 5 dùng):
  - `replace_event_children(cursor, event_id, data)` — xóa toàn bộ dữ liệu con của event và ghi lại từ document. Gọi BÊN TRONG transaction do caller mở. Cursor thường (tuple).
  - `load_event_children(cursor, event_id) -> dict` — `{members, expenses, bankInfo, couples, rates}`. Cursor phải là `RealDictCursor`.
  - `load_events_summary(cursor, codes) -> list` — cho `/api/events/lookup`; mỗi phần tử `{event_code, title, members, expenses, rates, updated_at}` trong đó `expenses` chỉ gồm `{amount, currency}` (UI danh sách chỉ cần đếm + tính tổng). Cursor phải là `RealDictCursor`.

- [ ] **Step 1: Thêm code SQL vào cuối `event_store.py`**

```python
# ===== Tầng SQL =====

def replace_event_children(cursor, event_id, data):
    """Xóa toàn bộ dữ liệu con của event rồi ghi lại từ document.

    PUT thay cả document nên delete+insert là đúng ngữ nghĩa. PHẢI được gọi
    bên trong transaction do caller mở (BEGIN ... COMMIT) để không có trạng
    thái nửa vời. expense_beneficiaries/couple_members tự xóa theo CASCADE.
    """
    rows = document_to_rows(data)

    cursor.execute('DELETE FROM expenses WHERE event_id = %s', (event_id,))
    cursor.execute('DELETE FROM couples WHERE event_id = %s', (event_id,))
    cursor.execute('DELETE FROM members WHERE event_id = %s', (event_id,))
    cursor.execute('DELETE FROM member_bank_info WHERE event_id = %s', (event_id,))
    cursor.execute('DELETE FROM event_rates WHERE event_id = %s', (event_id,))

    if rows['members']:
        psycopg2.extras.execute_values(
            cursor,
            'INSERT INTO members (event_id, name, position) VALUES %s',
            [(event_id, r['name'], r['position']) for r in rows['members']],
        )

    if rows['expenses']:
        inserted = psycopg2.extras.execute_values(
            cursor,
            '''INSERT INTO expenses (event_id, title, amount, currency, payer_name,
                                     benefit_type, expense_date, created_time,
                                     updated_time, position)
               VALUES %s RETURNING id, position''',
            [
                (event_id, r['title'], r['amount'], r['currency'], r['payer_name'],
                 r['benefit_type'], r['expense_date'], r['created_time'],
                 r['updated_time'], r['position'])
                for r in rows['expenses']
            ],
            fetch=True,
        )
        expense_id_by_position = {row[1]: row[0] for row in inserted}
        if rows['expense_beneficiaries']:
            psycopg2.extras.execute_values(
                cursor,
                'INSERT INTO expense_beneficiaries (expense_id, member_name, position) VALUES %s',
                [
                    (expense_id_by_position[b['expense_position']], b['member_name'], b['position'])
                    for b in rows['expense_beneficiaries']
                ],
            )

    if rows['member_bank_info']:
        psycopg2.extras.execute_values(
            cursor,
            'INSERT INTO member_bank_info (event_id, member_name, bank, account) VALUES %s',
            [(event_id, r['member_name'], r['bank'], r['account']) for r in rows['member_bank_info']],
        )

    if rows['couples']:
        inserted = psycopg2.extras.execute_values(
            cursor,
            '''INSERT INTO couples (event_id, client_id, label, primary_name, position)
               VALUES %s RETURNING id, position''',
            [
                (event_id, r['client_id'], r['label'], r['primary_name'], r['position'])
                for r in rows['couples']
            ],
            fetch=True,
        )
        couple_id_by_position = {row[1]: row[0] for row in inserted}
        if rows['couple_members']:
            psycopg2.extras.execute_values(
                cursor,
                'INSERT INTO couple_members (couple_id, member_name, position) VALUES %s',
                [
                    (couple_id_by_position[cm['couple_position']], cm['member_name'], cm['position'])
                    for cm in rows['couple_members']
                ],
            )

    if rows['event_rates']:
        psycopg2.extras.execute_values(
            cursor,
            '''INSERT INTO event_rates (event_id, currency_code, rate, source,
                                        rate_date, rate_type, currency_name)
               VALUES %s''',
            [
                (event_id, r['currency_code'], r['rate'], r['source'],
                 r['rate_date'], r['rate_type'], r['currency_name'])
                for r in rows['event_rates']
            ],
        )


def load_event_children(cursor, event_id):
    """Đọc dữ liệu con của event → phần document (không gồm title).

    cursor PHẢI là RealDictCursor. Nối beneficiaries/couple_members về
    *_position bằng JOIN vì tầng thuần không biết id DB.
    """
    cursor.execute(
        'SELECT name, position FROM members WHERE event_id = %s ORDER BY position',
        (event_id,),
    )
    member_rows = cursor.fetchall()

    cursor.execute(
        '''SELECT title, amount, currency, payer_name, benefit_type,
                  expense_date, created_time, updated_time, position
           FROM expenses WHERE event_id = %s ORDER BY position''',
        (event_id,),
    )
    expense_rows = cursor.fetchall()

    cursor.execute(
        '''SELECT x.position AS expense_position, b.member_name, b.position
           FROM expense_beneficiaries b
           JOIN expenses x ON x.id = b.expense_id
           WHERE x.event_id = %s''',
        (event_id,),
    )
    beneficiary_rows = cursor.fetchall()

    cursor.execute(
        'SELECT member_name, bank, account FROM member_bank_info WHERE event_id = %s ORDER BY member_name',
        (event_id,),
    )
    bank_rows = cursor.fetchall()

    cursor.execute(
        '''SELECT client_id, label, primary_name, position
           FROM couples WHERE event_id = %s ORDER BY position''',
        (event_id,),
    )
    couple_rows = cursor.fetchall()

    cursor.execute(
        '''SELECT c.position AS couple_position, cm.member_name, cm.position
           FROM couple_members cm
           JOIN couples c ON c.id = cm.couple_id
           WHERE c.event_id = %s''',
        (event_id,),
    )
    couple_member_rows = cursor.fetchall()

    cursor.execute(
        '''SELECT currency_code, rate, source, rate_date, rate_type, currency_name
           FROM event_rates WHERE event_id = %s''',
        (event_id,),
    )
    rate_rows = cursor.fetchall()

    return rows_to_document({
        'members': member_rows,
        'expenses': expense_rows,
        'expense_beneficiaries': beneficiary_rows,
        'member_bank_info': bank_rows,
        'couples': couple_rows,
        'couple_members': couple_member_rows,
        'event_rates': rate_rows,
    })


def load_events_summary(cursor, codes):
    """Cho /api/events/lookup: các trường tối thiểu danh sách "Sự Kiện Của Tôi"
    cần (đếm thành viên/chi phí + tính tổng theo rates). Giữ shape response cũ
    nhưng expenses chỉ gồm {amount, currency}. cursor là RealDictCursor."""
    cursor.execute(
        'SELECT id, event_code, title, updated_at FROM events WHERE event_code = ANY(%s)',
        (codes,),
    )
    events = cursor.fetchall()
    if not events:
        return []
    event_ids = [e['id'] for e in events]

    cursor.execute(
        'SELECT event_id, name FROM members WHERE event_id = ANY(%s::uuid[]) ORDER BY position',
        (event_ids,),
    )
    members_by_event = {}
    for r in cursor.fetchall():
        members_by_event.setdefault(r['event_id'], []).append(r['name'])

    cursor.execute(
        'SELECT event_id, amount, currency FROM expenses WHERE event_id = ANY(%s::uuid[])',
        (event_ids,),
    )
    expenses_by_event = {}
    for r in cursor.fetchall():
        expenses_by_event.setdefault(r['event_id'], []).append(
            {'amount': _num(r['amount']), 'currency': r['currency']}
        )

    cursor.execute(
        'SELECT event_id, currency_code, rate FROM event_rates WHERE event_id = ANY(%s::uuid[])',
        (event_ids,),
    )
    rates_by_event = {}
    for r in cursor.fetchall():
        rates_by_event.setdefault(r['event_id'], {})[r['currency_code']] = {'rate': _num(r['rate'])}

    return [
        {
            'event_code': e['event_code'],
            'title': e['title'],
            'members': members_by_event.get(e['id'], []),
            'expenses': expenses_by_event.get(e['id'], []),
            'rates': rates_by_event.get(e['id'], {}),
            'updated_at': e['updated_at'].isoformat() if e['updated_at'] else None,
        }
        for e in events
    ]
```

- [ ] **Step 2: Kiểm tra syntax + unit test cũ vẫn pass**

Run: `python3 -c "import event_store" && python3 test_event_store.py`
Expected: không lỗi import; 4 test ✅ như trước. (Tầng SQL sẽ được test bằng round-trip qua API thật ở Task 6.)

- [ ] **Step 3: Commit**

```bash
git add event_store.py
git commit -m "feat: event_store — tầng SQL ghi/đọc bảng con (replace/load/summary)"
```

### Task 4: Nối `vercel_app.py` vào schema mới

**Files:**
- Modify: `vercel_app.py` (import, `_check_edit_permission`, 5 route: POST/GET/PUT/DELETE/lookup)

**Interfaces:**
- Consumes: `replace_event_children`, `load_event_children`, `load_events_summary` (Task 3).
- Produces: API contract giữ NGUYÊN — mọi response shape như bản cũ. `_check_edit_permission(cursor, event_code)` đổi giá trị trả về thành 3-tuple `(status, event_id, updated_at)`.

- [ ] **Step 1: Thêm import ở đầu `vercel_app.py`**

Sau dòng `from validation import ValidationError, validate_event_payload`:

```python
from event_store import replace_event_children, load_event_children, load_events_summary
```

- [ ] **Step 2: Sửa `_check_edit_permission` trả thêm `event_id`**

Thay toàn bộ hàm `_check_edit_permission` bằng:

```python
def _check_edit_permission(cursor, event_code):
    """Kiểm tra quyền sửa/xóa event.

    Trả về (status, event_id, updated_at) với status: 'not_found' | 'forbidden' | 'ok'.
    Event cũ chưa có edit_key: chấp nhận request và "nhận" key client gửi lên
    (nếu có) làm key chính thức, để dữ liệu cũ không bị khóa ngoài ý muốn.
    """
    cursor.execute(
        'SELECT id, edit_key, updated_at FROM events WHERE event_code = %s',
        (event_code,),
    )
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, stored, updated_at = row[0], row[1], row[2]
    provided = _provided_edit_key()
    if stored:
        if not provided or not hmac.compare_digest(stored, provided):
            return 'forbidden', event_id, updated_at
        return 'ok', event_id, updated_at
    if provided:
        cursor.execute('UPDATE events SET edit_key = %s WHERE id = %s', (provided, event_id))
    return 'ok', event_id, updated_at
```

- [ ] **Step 3: Thay thân `create_event` (POST)**

Giữ nguyên decorator, phần validate và sinh `event_code`/`edit_key`; bỏ `event_id = str(uuid.uuid4())` (DB tự sinh); thay đoạn INSERT bằng:

```python
        conn = get_db_connection()
        cursor = conn.cursor()
        # Ghi nhiều bảng phải nằm trong 1 transaction (connection đang autocommit
        # nên mở transaction thủ công bằng BEGIN/COMMIT)
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                '''INSERT INTO events (event_code, title, edit_key)
                   VALUES (%s, %s, %s) RETURNING id, updated_at''',
                (event_code, data['title'], edit_key),
            )
            event_id, created_updated_at = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            cursor.execute('COMMIT')
        except Exception:
            cursor.execute('ROLLBACK')
            raise
        finally:
            cursor.close()

        return jsonify({
            'success': True,
            'event_id': str(event_id),
            'event_code': event_code,
            'edit_key': edit_key,
            'updated_at': created_updated_at.isoformat() if created_updated_at else None,
        })
```

(`import uuid` không còn chỗ dùng — xóa dòng import.)

- [ ] **Step 4: Thay thân `get_event` (GET)**

```python
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT id, event_code, title, edit_key, created_at, updated_at
               FROM events WHERE event_code = %s''',
            (event_code,),
        )
        event = cursor.fetchone()
        if not event:
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404

        doc = load_event_children(cursor, event['id'])
        cursor.close()

        # Quyền sửa: sự kiện chưa có khóa (legacy) → ai cũng sửa được;
        # có khóa → chỉ khi header X-Edit-Key khớp. UI dựa vào cờ này.
        stored_key = event['edit_key']
        provided = _provided_edit_key()
        can_edit = (not stored_key) or bool(provided and hmac.compare_digest(stored_key, provided))
        return jsonify({
            'success': True,
            'event': {
                'id': str(event['id']),
                'event_code': event['event_code'],
                'title': event['title'],
                'can_edit': can_edit,
                'members': doc['members'],
                'expenses': doc['expenses'],
                'bankInfo': doc['bankInfo'],
                'couples': doc['couples'],
                'rates': doc['rates'],
                # Lưu ý: tuyệt đối không trả edit_key — link chỉ-xem cũng gọi API này.
                'created_at': event['created_at'].isoformat() if event['created_at'] else None,
                'updated_at': event['updated_at'].isoformat() if event['updated_at'] else None,
            },
        })
```

- [ ] **Step 5: Thay thân `update_event` (PUT)**

Phần validate + `expectedUpdatedAt` giữ nguyên. Từ chỗ lấy connection:

```python
        conn = get_db_connection()
        cursor = conn.cursor()

        permission, event_id, current_updated_at = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền chỉnh sửa sự kiện này.'}), 403

        if (expected_updated_at and current_updated_at
                and current_updated_at.isoformat() != expected_updated_at):
            cursor.close()
            return jsonify({
                'success': False,
                'conflict': True,
                'error': 'Sự kiện đã được cập nhật ở nơi khác.',
            }), 409

        try:
            cursor.execute('BEGIN')
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            cursor.execute('COMMIT')
        except Exception:
            cursor.execute('ROLLBACK')
            raise
        finally:
            cursor.close()
        new_updated_at = new_row[0].isoformat() if new_row and new_row[0] else None
        return jsonify({'success': True, 'updated_at': new_updated_at})
```

- [ ] **Step 6: Sửa `delete_event` (DELETE) theo signature mới**

Chỉ đổi dòng unpack: `permission, _event_id, _unused = _check_edit_permission(cursor, event_code)`. Câu `DELETE FROM events WHERE event_code = %s` giữ nguyên (bảng con xóa theo CASCADE).

- [ ] **Step 7: Thay thân `lookup_events`**

Phần validate `codes` giữ nguyên; thay đoạn query + build `events` bằng:

```python
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        events = load_events_summary(cursor, codes)
        cursor.close()
        return jsonify({'success': True, 'events': events})
```

- [ ] **Step 8: Kiểm tra syntax + unit test**

Run: `python3 -c "import vercel_app" && python3 test_event_store.py && node test_split.js`
Expected: import sạch (không cần DB khi import), các test pass.

- [ ] **Step 9: Commit**

```bash
git add vercel_app.py
git commit -m "feat: chuyển toàn bộ route events sang schema quan hệ (API contract giữ nguyên)"
```

### Task 5: Script migrate dữ liệu cũ (`migrate_to_supabase.py`)

**Files:**
- Create: `migrate_to_supabase.py`

**Interfaces:**
- Consumes: `validate_event_payload`, `replace_event_children`.
- Produces: script CLI chạy tay — `OLD_DATABASE_URL` (Neon, schema cũ) → `DATABASE_URL` (Supabase, schema mới).

- [ ] **Step 1: Viết `migrate_to_supabase.py`**

```python
#!/usr/bin/env python3
"""Migrate dữ liệu từ DB cũ (bảng events kiểu JSON blob) sang schema quan hệ mới.

Cách chạy (một lần, chạy lại được — upsert theo event_code):
    OLD_DATABASE_URL=postgres://...(Neon) \
    DATABASE_URL=postgres://...(Supabase pooler 6543) \
    python3 migrate_to_supabase.py

- Giữ nguyên event_code, edit_key, created_at, updated_at → link chia sẻ cũ sống nguyên.
- owner_id để NULL (event legacy chưa thuộc tài khoản nào).
- Payload từng event đi qua validate_event_payload để chuẩn hóa như request thật;
  event lỗi parse/validate chỉ bị bỏ qua (log lại), không chặn cả đợt.
"""

import json
import os
import sys

import psycopg2
import psycopg2.extras

from validation import ValidationError, validate_event_payload
from event_store import replace_event_children


def main():
    old_url = os.environ.get('OLD_DATABASE_URL')
    new_url = os.environ.get('DATABASE_URL')
    if not old_url or not new_url:
        print('❌ Cần đặt cả OLD_DATABASE_URL (DB cũ) và DATABASE_URL (Supabase).')
        return 2

    old_conn = psycopg2.connect(old_url, connect_timeout=10)
    new_conn = psycopg2.connect(new_url, connect_timeout=10)
    new_conn.autocommit = False  # transaction per-event, commit tay

    old_cur = old_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    old_cur.execute('SELECT * FROM events ORDER BY created_at')
    rows = old_cur.fetchall()
    old_cur.close()
    print(f'Đọc được {len(rows)} event từ DB cũ.')

    ok = 0
    failed = []
    for row in rows:
        code = row['event_code']
        try:
            doc = validate_event_payload({
                'title': row['title'],
                'members': json.loads(row['members'] or '[]'),
                'expenses': json.loads(row['expenses'] or '[]'),
                'bankInfo': json.loads(row['bank_info'] or '{}'),
                'couples': json.loads(row['couples'] or '[]'),
                'rates': json.loads(row['rates'] or '{}'),
            })
            cur = new_conn.cursor()
            cur.execute(
                '''INSERT INTO events (event_code, title, edit_key, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (event_code) DO UPDATE
                   SET title = EXCLUDED.title, edit_key = EXCLUDED.edit_key,
                       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
                   RETURNING id''',
                (code, doc['title'], row['edit_key'], row['created_at'], row['updated_at']),
            )
            event_id = cur.fetchone()[0]
            replace_event_children(cur, event_id, doc)
            new_conn.commit()
            cur.close()
            ok += 1
            print(f'✅ {code} — {doc["title"]}')
        except (ValidationError, ValueError, KeyError, psycopg2.Error) as e:
            new_conn.rollback()
            failed.append(code)
            print(f'❌ {code}: {e}')

    old_conn.close()
    new_conn.close()
    print(f'\nXong: {ok}/{len(rows)} event migrate thành công.')
    if failed:
        print(f'Lỗi ({len(failed)}): {", ".join(failed)}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 2: Kiểm tra syntax**

Run: `python3 -c "import ast; ast.parse(open('migrate_to_supabase.py').read())"`
Expected: không output. (Chạy thật ở Task 6 khi có cả 2 DB.)

- [ ] **Step 3: Commit**

```bash
git add migrate_to_supabase.py
git commit -m "feat: script migrate dữ liệu events JSON blob sang schema quan hệ"
```

### Task 6: Round-trip test + chạy tích hợp giai đoạn 1 + cập nhật docs

**Files:**
- Modify: `test_api.py` (thêm round-trip test), `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: server chạy với `DATABASE_URL` Supabase (schema Task 1), API Task 4.
- Produces: `test_roundtrip_document(event_code, edit_key)` trong `test_api.py`, được gọi trong `main()` sau `test_update_event`.

- [ ] **Step 1: Thêm round-trip test vào `test_api.py`** (đặt trước `def main`)

```python
def test_roundtrip_document(event_code, edit_key):
    """PUT document đầy đủ (đa tiền tệ, couples, rates) rồi GET so từng trường —
    bất biến quan trọng nhất của schema quan hệ: không mất/không méo dữ liệu."""
    print("Testing document round-trip...")
    doc = {
        "title": "Round Trip Đà Lạt",
        "members": ["An", "Bình", "Chi"],
        "expenses": [
            {"title": "Khách sạn", "amount": 1500000, "currency": "VND",
             "payer": "An", "benefitType": "all", "beneficiaries": [],
             "expense_date": "2026-08-01", "created_time": "2026-08-01T10:00:00",
             "updated_time": "2026-08-01T10:00:00"},
            {"title": "Ăn tối", "amount": 45.5, "currency": "USD",
             "payer": "Bình", "benefitType": "selected",
             "beneficiaries": ["An", "Chi"],
             "expense_date": "2026-08-02", "created_time": "", "updated_time": ""},
        ],
        "bankInfo": {"An": {"bank": "VCB", "account": "123456"}},
        "couples": [{"id": "c1", "label": "Vợ chồng An",
                     "members": ["An", "Bình"], "primary": "An"}],
        "rates": {"USD": {"rate": 25000, "source": "test", "rateDate": "2026-08-01",
                          "rateType": "mid", "currencyName": "US Dollar"}},
    }
    r = requests.get(f"{BASE_URL}/api/events/{event_code}")
    doc_put = dict(doc)
    doc_put["expectedUpdatedAt"] = r.json()["event"]["updated_at"]
    r = requests.put(f"{BASE_URL}/api/events/{event_code}", json=doc_put,
                     headers={'X-Edit-Key': edit_key})
    if r.status_code != 200:
        print(f"❌ Round-trip PUT failed - Status: {r.status_code} {r.text}")
        return False
    r = requests.get(f"{BASE_URL}/api/events/{event_code}")
    got = r.json()["event"]
    for key in ("title", "members", "expenses", "bankInfo", "couples", "rates"):
        if got[key] != doc[key]:
            print(f"❌ Round-trip lệch ở '{key}':\n  gửi:  {doc[key]}\n  nhận: {got[key]}")
            return False
    print("✅ Round-trip OK - document giữ nguyên qua PUT/GET")
    return True
```

Và trong `main()`, sau khối `test_update_event`:

```python
    # Test round-trip document trên schema quan hệ
    if not test_roundtrip_document(event_code, edit_key):
        return
```

- [ ] **Step 2: Chạy schema lên Supabase (cần Điều kiện tiên quyết 1-3)**

Run: `psql "$DATABASE_URL" -f schema.sql && psql "$DATABASE_URL" -f schema.sql`
Expected: 2 lần đều OK (idempotent).

- [ ] **Step 3: Chạy server local trỏ Supabase + full integration test**

Run (terminal 1): `DATABASE_URL="postgres://...pooler...:6543/postgres" python3 vercel_app.py`
Run (terminal 2): `BASE_URL=http://localhost:5002 python3 test_api.py`
Expected: `🎉 All tests passed!` — gồm cả round-trip mới. Đây là bằng chứng schema mới tương thích 100% API cũ.

- [ ] **Step 4: Chạy migrate thật (nếu DB cũ có dữ liệu cần giữ)**

Run: `OLD_DATABASE_URL="postgres://...(neon)" DATABASE_URL="postgres://...(supabase)" python3 migrate_to_supabase.py`
Expected: `Xong: N/N event migrate thành công.` Spot-check 1 event cũ: mở `http://localhost:5002/?event_code=<mã cũ>` thấy đủ dữ liệu.

- [ ] **Step 5: Cập nhật `CLAUDE.md` và `README.md`**

`CLAUDE.md` — sửa đoạn **Storage model** thành (giữ nguyên phần còn lại của file):

```markdown
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
```

và thêm vào khối Commands: `python3 test_event_store.py   # unit test decompose/compose (không cần DB)`.

`README.md` — cập nhật mục cài đặt/env: `DATABASE_URL` giờ là connection string Supabase pooler (port 6543); thêm hướng dẫn chạy `schema.sql` và `migrate_to_supabase.py` (copy câu lệnh từ docstring của script).

- [ ] **Step 6: Verify + commit (kết thúc giai đoạn 1)**

Run: `python3 test_event_store.py && node test_split.js && node --check static/app.js && node --check static/split.js && node --check static/sw.js`
Expected: tất cả pass (frontend chưa đổi).

```bash
git add test_api.py CLAUDE.md README.md
git commit -m "feat: round-trip test + docs cho schema quan hệ Supabase (xong giai đoạn 1)"
```

---

# GIAI ĐOẠN 2 — TÀI KHOẢN & ĐĂNG NHẬP (SUPABASE AUTH)

### Task 7: Module verify JWT (`supabase_auth.py`) + unit test

**Files:**
- Create: `supabase_auth.py`
- Test: `test_supabase_auth.py`
- Modify: `requirements.txt`, `api/requirements.txt` (thêm `PyJWT[crypto]>=2.8,<3.0` vào CẢ HAI)

**Interfaces:**
- Produces (Task 8, 9 dùng):
  - `request_user_id(request) -> str | None` — đọc header `Authorization: Bearer <token>`, verify chữ ký qua JWKS của Supabase, trả claim `sub` (uuid string) hoặc `None`. KHÔNG BAO GIỜ raise — token thiếu/sai/hết hạn đều là `None`.
  - `verify_access_token(token) -> str | None`.
  - `_get_jwk_client()` — điểm monkeypatch cho test.

- [ ] **Step 1: Thêm dependency vào cả hai file requirements**

Thêm dòng `PyJWT[crypto]>=2.8,<3.0` vào `requirements.txt` VÀ `api/requirements.txt`, rồi:

Run: `pip3 install 'PyJWT[crypto]>=2.8,<3.0'`

- [ ] **Step 2: Viết test (fail vì chưa có module)**

Tạo `test_supabase_auth.py`:

```python
#!/usr/bin/env python3
"""Unit test verify JWT Supabase (không cần mạng/DB): tự sinh cặp khóa ES256,
monkeypatch JWK client, ký token giả và kiểm tra đủ nhánh."""

import datetime
import sys

import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec

import supabase_auth


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJWKClient:
    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())
USER_ID = '11111111-2222-3333-4444-555555555555'


def _make_token(key=PRIVATE_KEY, aud='authenticated', sub=USER_ID, expired=False):
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now - datetime.timedelta(hours=1) if expired else now + datetime.timedelta(hours=1)
    return pyjwt.encode(
        {'sub': sub, 'aud': aud, 'exp': exp, 'iat': now},
        key, algorithm='ES256',
    )


def main():
    supabase_auth._jwk_client_override = _FakeJWKClient(PRIVATE_KEY.public_key())

    assert supabase_auth.verify_access_token(_make_token()) == USER_ID
    print('✅ token hợp lệ → trả sub')

    assert supabase_auth.verify_access_token(_make_token(expired=True)) is None
    print('✅ token hết hạn → None')

    assert supabase_auth.verify_access_token(_make_token(aud='khac')) is None
    print('✅ sai audience → None')

    assert supabase_auth.verify_access_token(_make_token(key=OTHER_KEY)) is None
    print('✅ sai chữ ký (khóa khác) → None')

    assert supabase_auth.verify_access_token('không-phải-jwt') is None
    assert supabase_auth.verify_access_token('') is None
    assert supabase_auth.verify_access_token(None) is None
    print('✅ token rác/rỗng/None → None')

    print('\n🎉 test_supabase_auth: tất cả pass')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 3: Chạy test — phải FAIL**

Run: `python3 test_supabase_auth.py`
Expected: `ModuleNotFoundError: No module named 'supabase_auth'`

- [ ] **Step 4: Viết `supabase_auth.py`**

```python
"""Xác thực access token của Supabase Auth ở phía Flask.

Verify offline bằng khóa công khai từ JWKS endpoint của project
(https://<project>.supabase.co/auth/v1/.well-known/jwks.json) — không gọi
Supabase mỗi request. Yêu cầu project dùng khóa ký bất đối xứng (project mới
mặc định ES256; project cũ HS256 phải bật "JWT signing keys" trong dashboard).
"""

import os

import jwt as pyjwt
from jwt import PyJWKClient

# Cache JWK client theo process (PyJWKClient tự cache key theo kid).
_jwk_client = None
# Cho unit test thay client giả — production luôn để None.
_jwk_client_override = None


def _get_jwk_client():
    global _jwk_client
    if _jwk_client_override is not None:
        return _jwk_client_override
    if _jwk_client is None:
        base = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
        if not base:
            return None
        _jwk_client = PyJWKClient(
            f'{base}/auth/v1/.well-known/jwks.json',
            cache_keys=True,
            lifespan=3600,
        )
    return _jwk_client


def verify_access_token(token):
    """Trả về user id (claim sub) nếu token hợp lệ, ngược lại None.

    Không raise — token thiếu/hết hạn/sai chữ ký/sai audience đều coi như
    chưa đăng nhập (caller quyết định 401 hay đi tiếp ẩn danh)."""
    if not token:
        return None
    client = _get_jwk_client()
    if client is None:
        return None
    try:
        signing_key = client.get_signing_key_from_jwt(token)
        claims = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=['ES256', 'RS256'],
            audience='authenticated',
        )
        return claims.get('sub') or None
    except Exception:
        return None


def request_user_id(request):
    """Lấy user id từ header Authorization của request Flask (None nếu không có)."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    return verify_access_token(auth[len('Bearer '):].strip())
```

- [ ] **Step 5: Chạy test — phải PASS**

Run: `python3 test_supabase_auth.py`
Expected: 5 dòng ✅ và `🎉 test_supabase_auth: tất cả pass`

- [ ] **Step 6: Commit**

```bash
git add supabase_auth.py test_supabase_auth.py requirements.txt api/requirements.txt
git commit -m "feat: verify JWT Supabase qua JWKS (PyJWT), có unit test khóa giả"
```

### Task 8: `/api/config` + POST bắt buộc đăng nhập

**Files:**
- Modify: `vercel_app.py`

**Interfaces:**
- Consumes: `request_user_id` (Task 7).
- Produces: `GET /api/config` → `{supabaseUrl, supabaseAnonKey}`; `POST /api/events` → 401 khi không có JWT hợp lệ, có JWT thì ghi `owner_id`.

- [ ] **Step 1: Import trong `vercel_app.py`**

Sau import `event_store`:

```python
from supabase_auth import request_user_id
```

- [ ] **Step 2: Thêm route `/api/config`** (đặt cạnh `/api/banks`)

```python
@app.route('/api/config')
@limiter.exempt
def get_config():
    """Cấu hình public cho frontend (anon key của Supabase vốn là public;
    index.html không dùng Jinja nên client lấy qua API này)."""
    return jsonify({
        'supabaseUrl': os.environ.get('SUPABASE_URL', ''),
        'supabaseAnonKey': os.environ.get('SUPABASE_ANON_KEY', ''),
    })
```

- [ ] **Step 3: Bắt buộc đăng nhập ở `create_event`**

Đầu hàm `create_event`, TRƯỚC phần validate payload, thêm:

```python
        # Tạo sự kiện yêu cầu đăng nhập (401 ≠ 403: chưa đăng nhập vs không có quyền)
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để tạo sự kiện.'}), 401
```

và sửa câu INSERT của Task 4 Step 3 thành:

```python
            cursor.execute(
                '''INSERT INTO events (event_code, title, edit_key, owner_id)
                   VALUES (%s, %s, %s, %s) RETURNING id, updated_at''',
                (event_code, data['title'], edit_key, user_id),
            )
```

- [ ] **Step 4: Kiểm tra nhanh không cần DB** (routes không đụng DB vẫn chạy được)

Run: `python3 -c "
import vercel_app
c = vercel_app.app.test_client()
r = c.get('/api/config'); assert r.status_code == 200 and 'supabaseUrl' in r.get_json(), r.data
r = c.post('/api/events', json={'title': 'x', 'members': []}); assert r.status_code == 401, r.status_code
print('OK: /api/config 200, POST khong token 401')
"`
Expected: `OK: /api/config 200, POST khong token 401`

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py
git commit -m "feat: /api/config + POST /api/events bắt buộc đăng nhập, ghi owner_id"
```

### Task 9: Owner bypass cho PUT/DELETE/GET + `/api/my-events`

**Files:**
- Modify: `vercel_app.py`

**Interfaces:**
- Consumes: `request_user_id` (Task 7), `_check_edit_permission` (Task 4).
- Produces: owner (JWT) sửa/xóa được event của mình không cần `X-Edit-Key`; `GET /api/events/<code>` trả `can_edit=true` cho owner; `GET /api/my-events` → `{success, events: [{event_code, title, updated_at}]}`.

- [ ] **Step 1: Owner bypass trong `_check_edit_permission`**

Thay hàm bằng bản có owner check (đặt TRƯỚC kiểm tra edit_key — owner không cần key, không kích hoạt adopt):

```python
def _check_edit_permission(cursor, event_code):
    """Kiểm tra quyền sửa/xóa event.

    Trả về (status, event_id, updated_at) với status: 'not_found' | 'forbidden' | 'ok'.
    Quyền hợp lệ khi: là owner (JWT Supabase) HOẶC X-Edit-Key khớp.
    Event cũ chưa có edit_key: chấp nhận request và "nhận" key client gửi lên
    (nếu có) làm key chính thức, để dữ liệu cũ không bị khóa ngoài ý muốn.
    """
    cursor.execute(
        'SELECT id, edit_key, owner_id, updated_at FROM events WHERE event_code = %s',
        (event_code,),
    )
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, stored, owner_id, updated_at = row[0], row[1], row[2], row[3]

    # Owner đăng nhập có toàn quyền — kể cả khi client gửi kèm key sai/tự sinh
    user_id = request_user_id(request)
    if owner_id and user_id and str(owner_id) == user_id:
        return 'ok', event_id, updated_at

    provided = _provided_edit_key()
    if stored:
        if not provided or not hmac.compare_digest(stored, provided):
            return 'forbidden', event_id, updated_at
        return 'ok', event_id, updated_at
    if provided:
        cursor.execute('UPDATE events SET edit_key = %s WHERE id = %s', (provided, event_id))
    return 'ok', event_id, updated_at
```

- [ ] **Step 2: `can_edit` cho owner trong `get_event`**

Trong `get_event` (Task 4 Step 4): thêm `owner_id` vào câu SELECT (`SELECT id, event_code, title, edit_key, owner_id, created_at, updated_at ...`) và thay dòng tính `can_edit` bằng:

```python
        stored_key = event['edit_key']
        provided = _provided_edit_key()
        user_id = request_user_id(request)
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        can_edit = is_owner or (not stored_key) or bool(
            provided and hmac.compare_digest(stored_key, provided))
```

- [ ] **Step 3: Route `/api/my-events`** (đặt cạnh `lookup_events`)

```python
@app.route('/api/my-events')
@limiter.limit('30 per minute; 500 per day')
def my_events():
    """Danh sách event thuộc tài khoản đang đăng nhập — đồng bộ "Sự Kiện Của Tôi"
    giữa các thiết bị. Chỉ trả metadata, không có edit_key (owner sửa bằng JWT)."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT event_code, title, updated_at FROM events
               WHERE owner_id = %s::uuid ORDER BY updated_at DESC''',
            (user_id,),
        )
        rows = cursor.fetchall()
        cursor.close()
        return jsonify({'success': True, 'events': [
            {
                'event_code': r['event_code'],
                'title': r['title'],
                'updated_at': r['updated_at'].isoformat() if r['updated_at'] else None,
            } for r in rows
        ]})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 4: Kiểm tra không cần DB**

Run: `python3 -c "
import vercel_app
c = vercel_app.app.test_client()
r = c.get('/api/my-events'); assert r.status_code == 401, r.status_code
print('OK: my-events khong token 401')
"`
Expected: `OK: my-events khong token 401`

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py
git commit -m "feat: owner JWT có toàn quyền với event của mình + GET /api/my-events"
```

### Task 10: Frontend nền tảng auth — supabase-js, `auth.js`, modal, navbar, sw.js

**Files:**
- Create: `static/auth.js`
- Modify: `templates/index.html`, `static/sw.js`

**Interfaces:**
- Produces (Task 11 dùng): `window.AppAuth` với `onReady(cb)`, `isLoggedIn()`, `userEmail()`, `authHeaders(extra?) -> object` (gắn `Authorization: Bearer` khi có session, luôn trả object), `showLoginModal()`. Event DOM `appauth:change` bắn mỗi khi session đổi. Khi Supabase chưa cấu hình, mọi hàm vẫn an toàn (app chạy như bản cũ, không có nút đăng nhập).

- [ ] **Step 1: Tính SRI hash cho supabase-js (pin version cụ thể)**

Run: `curl -sfL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js | openssl dgst -sha384 -binary | openssl base64 -A`
Expected: một chuỗi base64 — dùng làm `integrity="sha384-<chuỗi>"` ở Step 2.

- [ ] **Step 2: Thêm script tags vào `templates/index.html`**

Trước dòng `<script src="/static/split.js"></script>` thêm:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js"
        integrity="sha384-<KẾT QUẢ STEP 1>" crossorigin="anonymous"></script>
```

và đổi 2 dòng cuối thành 3 dòng (auth.js TRƯỚC app.js):

```html
<script src="/static/split.js"></script>
<script src="/static/auth.js"></script>
<script src="/static/app.js"></script>
```

- [ ] **Step 3: Thêm chỗ đứng auth trên navbar**

Trong `templates/index.html`, trong `<ul class="navbar-nav ms-auto">`, sau `</li>` của `newEventBtn` thêm:

```html
                <li class="nav-item d-flex align-items-center ms-lg-2" id="authArea"></li>
```

- [ ] **Step 4: Thêm modal auth** — dán TRƯỚC `<div class="modal fade" id="confirmModal"` (confirmModal phải giữ vị trí modal CUỐI CÙNG trong DOM):

```html
<!-- Modal đăng nhập / đăng ký (Supabase Auth) -->
<div class="modal fade" id="authModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title"><i class="fas fa-user me-2"></i>Tài Khoản</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <div id="authMessage" class="small mb-2"></div>

                <div id="authPaneLogin">
                    <form id="authLoginForm">
                        <div class="mb-2">
                            <label class="form-label" for="authLoginEmail">Email</label>
                            <input type="email" class="form-control" id="authLoginEmail" autocomplete="email">
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="authLoginPassword">Mật khẩu</label>
                            <input type="password" class="form-control" id="authLoginPassword" autocomplete="current-password">
                        </div>
                        <button type="submit" class="btn btn-primary w-100 mb-2">Đăng nhập</button>
                    </form>
                    <button type="button" class="btn btn-outline-danger w-100 mb-2" id="authGoogleBtn">
                        <i class="fab fa-google me-1"></i>Đăng nhập với Google
                    </button>
                    <div class="d-flex justify-content-between">
                        <button type="button" class="btn btn-link btn-sm p-0" id="authShowRegister">Chưa có tài khoản? Đăng ký</button>
                        <button type="button" class="btn btn-link btn-sm p-0" id="authForgotBtn">Quên mật khẩu?</button>
                    </div>
                </div>

                <div id="authPaneRegister" class="d-none">
                    <form id="authRegisterForm">
                        <div class="mb-2">
                            <label class="form-label" for="authRegisterEmail">Email</label>
                            <input type="email" class="form-control" id="authRegisterEmail" autocomplete="email">
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="authRegisterPassword">Mật khẩu (tối thiểu 6 ký tự)</label>
                            <input type="password" class="form-control" id="authRegisterPassword" autocomplete="new-password">
                        </div>
                        <button type="submit" class="btn btn-primary w-100 mb-2">Đăng ký</button>
                    </form>
                    <button type="button" class="btn btn-link btn-sm p-0" id="authShowLogin">Đã có tài khoản? Đăng nhập</button>
                </div>

                <div id="authPaneRecovery" class="d-none">
                    <form id="authRecoveryForm">
                        <div class="mb-3">
                            <label class="form-label" for="authRecoveryPassword">Mật khẩu mới (tối thiểu 6 ký tự)</label>
                            <input type="password" class="form-control" id="authRecoveryPassword" autocomplete="new-password">
                        </div>
                        <button type="submit" class="btn btn-primary w-100">Đổi mật khẩu</button>
                    </form>
                </div>
            </div>
        </div>
    </div>
</div>
```

- [ ] **Step 5: Viết `static/auth.js`**

```javascript
// static/auth.js — Đăng nhập/đăng ký qua Supabase Auth (email/password + Google).
// Nạp TRƯỚC app.js; app.js chỉ dùng qua window.AppAuth. Khi Supabase chưa cấu
// hình (/api/config rỗng) mọi hàm vẫn an toàn: isLoggedIn()=false,
// authHeaders() trả nguyên headers — app chạy như bản không có auth.
(function () {
    'use strict';

    let client = null;   // Supabase client (null nếu chưa cấu hình)
    let session = null;  // Session hiện tại (null nếu chưa đăng nhập)
    let ready = false;
    const readyCallbacks = [];

    function onReady(cb) {
        if (ready) { cb(); } else { readyCallbacks.push(cb); }
    }

    function isLoggedIn() { return !!session; }

    function userEmail() {
        return (session && session.user && session.user.email) || '';
    }

    function authHeaders(extra) {
        const headers = Object.assign({}, extra || {});
        if (session && session.access_token) {
            headers['Authorization'] = 'Bearer ' + session.access_token;
        }
        return headers;
    }

    // ===== UI =====
    function renderAuthArea() {
        const $area = $('#authArea');
        if (!$area.length || !client) return;
        $area.empty();
        if (session) {
            // Email là dữ liệu user-controlled → .text()
            $area.append($('<span class="navbar-text text-white small me-2"></span>').text(userEmail()));
            $area.append('<button type="button" class="btn btn-outline-light btn-sm" id="logoutBtn">'
                + '<i class="fas fa-sign-out-alt me-1"></i>Đăng xuất</button>');
        } else {
            $area.append('<button type="button" class="btn btn-light btn-sm" id="loginBtn">'
                + '<i class="fas fa-user me-1"></i>Đăng nhập</button>');
        }
    }

    function setAuthMessage(msg, isError) {
        $('#authMessage')
            .attr('class', 'small mb-2 ' + (isError ? 'text-danger' : 'text-success'))
            .text(msg || '');
    }

    function showPane(pane) {
        $('#authPaneLogin').toggleClass('d-none', pane !== 'login');
        $('#authPaneRegister').toggleClass('d-none', pane !== 'register');
        $('#authPaneRecovery').toggleClass('d-none', pane !== 'recovery');
        setAuthMessage('');
    }

    function showLoginModal() {
        if (!client) return;
        showPane('login');
        $('#authModal').modal('show');
    }

    // ===== Khởi tạo =====
    async function init() {
        try {
            const resp = await fetch('/api/config');
            const cfg = await resp.json();
            if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
                client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
                const res = await client.auth.getSession();
                session = (res.data && res.data.session) || null;
                client.auth.onAuthStateChange(function (event, s) {
                    session = s;
                    renderAuthArea();
                    if (event === 'PASSWORD_RECOVERY') {
                        // Người dùng vào từ link đặt lại mật khẩu trong email
                        showPane('recovery');
                        $('#authModal').modal('show');
                    }
                    document.dispatchEvent(new CustomEvent('appauth:change'));
                });
            }
        } catch (e) {
            // Thiếu cấu hình / lỗi mạng → chạy như bản không có auth
        }
        renderAuthArea();
        ready = true;
        readyCallbacks.splice(0).forEach(function (cb) { cb(); });
    }

    // ===== Hành vi (delegated vì #authArea render động) =====
    $(document).on('click', '#loginBtn', showLoginModal);

    $(document).on('click', '#logoutBtn', async function () {
        if (client) await client.auth.signOut();
    });

    $(document).on('click', '#authShowRegister', function () { showPane('register'); });
    $(document).on('click', '#authShowLogin', function () { showPane('login'); });

    $(document).on('submit', '#authLoginForm', async function (e) {
        e.preventDefault();
        const email = $('#authLoginEmail').val().trim();
        const password = $('#authLoginPassword').val();
        if (!email || !password) { setAuthMessage('Vui lòng nhập email và mật khẩu.', true); return; }
        const res = await client.auth.signInWithPassword({ email: email, password: password });
        if (res.error) { setAuthMessage('Đăng nhập thất bại — email hoặc mật khẩu không đúng.', true); return; }
        $('#authModal').modal('hide');
    });

    $(document).on('submit', '#authRegisterForm', async function (e) {
        e.preventDefault();
        const email = $('#authRegisterEmail').val().trim();
        const password = $('#authRegisterPassword').val();
        if (!email || password.length < 6) {
            setAuthMessage('Email không hợp lệ hoặc mật khẩu quá ngắn (tối thiểu 6 ký tự).', true);
            return;
        }
        const res = await client.auth.signUp({ email: email, password: password });
        if (res.error) { setAuthMessage('Đăng ký thất bại — email có thể đã được dùng.', true); return; }
        setAuthMessage('Đăng ký thành công! Vui lòng kiểm tra email để xác nhận tài khoản.');
    });

    $(document).on('click', '#authGoogleBtn', async function () {
        if (!client) return;
        // Redirect sang Google rồi quay lại đúng trang hiện tại;
        // supabase-js tự bắt token trong URL khi quay về (detectSessionInUrl)
        await client.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.href }
        });
    });

    $(document).on('click', '#authForgotBtn', async function () {
        const email = $('#authLoginEmail').val().trim();
        if (!email) { setAuthMessage('Nhập email vào ô phía trên rồi bấm lại "Quên mật khẩu?".', true); return; }
        const res = await client.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/'
        });
        if (res.error) { setAuthMessage('Không gửi được email đặt lại mật khẩu.', true); return; }
        setAuthMessage('Đã gửi email đặt lại mật khẩu — vui lòng kiểm tra hộp thư.');
    });

    $(document).on('submit', '#authRecoveryForm', async function (e) {
        e.preventDefault();
        const password = $('#authRecoveryPassword').val();
        if (password.length < 6) { setAuthMessage('Mật khẩu tối thiểu 6 ký tự.', true); return; }
        const res = await client.auth.updateUser({ password: password });
        if (res.error) { setAuthMessage('Không đổi được mật khẩu, vui lòng thử lại.', true); return; }
        setAuthMessage('Đã đổi mật khẩu thành công.');
        setTimeout(function () { $('#authModal').modal('hide'); }, 1200);
    });

    window.AppAuth = {
        onReady: onReady,
        isLoggedIn: isLoggedIn,
        userEmail: userEmail,
        authHeaders: authHeaders,
        showLoginModal: showLoginModal
    };

    $(function () { init(); });
})();
```

- [ ] **Step 6: Cập nhật `static/sw.js`**

Đổi `const CACHE_VERSION = 'v3';` → `'v4'`; thêm `'/static/auth.js'` vào `PRECACHE_URLS` (sau `'/static/split.js'`) và vào `NETWORK_FIRST_PATHS`.

- [ ] **Step 7: Syntax check**

Run: `node --check static/auth.js && node --check static/sw.js && node --check static/app.js`
Expected: không output.

- [ ] **Step 8: Commit**

```bash
git add static/auth.js static/sw.js templates/index.html
git commit -m "feat: nền tảng auth frontend — supabase-js (SRI), AppAuth, modal đăng nhập, sw v4"
```

### Task 11: Nối auth vào `app.js` (gate tạo mới, headers, my-events)

**Files:**
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `window.AppAuth` (Task 10), API Task 8/9.
- Produces: hành vi UI cuối — chưa đăng nhập không tạo/lưu event mới được (mở modal đăng nhập); mọi request API gắn Authorization khi có session; "Sự Kiện Của Tôi" gộp danh sách server.

- [ ] **Step 1: Bọc khối boot trong `AppAuth.onReady`**

Khối `if (window.location.pathname.startsWith('/share/')) { ... } else { createNewEvent(); }` (ngay sau phần đọc `urlParams`, `app.js:155-180`) bọc thành:

```javascript
        // Chờ AppAuth biết session (từ localStorage, không chờ mạng lâu) rồi mới
        // tải event — để owner mở event của mình trên máy mới nhận đúng can_edit
        // qua JWT thay vì bị rơi về chế độ chỉ xem.
        AppAuth.onReady(function () {
            if (window.location.pathname.startsWith('/share/')) {
                // ... giữ nguyên toàn bộ thân if/else if/else hiện có ...
            } else if (urlEventCode) {
                // ... giữ nguyên ...
            } else if (currentEventCode) {
                // ... giữ nguyên ...
            } else {
                createNewEvent();
            }
        });
```

(Chỉ bọc — không đổi nội dung bên trong.)

- [ ] **Step 2: Gate lưu/tạo trong `saveEvent`**

Ngay sau dòng `if (!allowEdit) return;` (app.js:596) thêm:

```javascript
            // Tạo sự kiện mới cần tài khoản (server cũng chặn 401) — sự kiện đã
            // tồn tại vẫn lưu được bằng edit_key như cũ (người được chia sẻ link)
            if (!currentEventCode && !AppAuth.isLoggedIn()) {
                setSaveStatus('error');
                showToast('Vui lòng đăng nhập để tạo và lưu sự kiện.', 'warning');
                if (showAlert) AppAuth.showLoginModal();
                return;
            }
```

- [ ] **Step 3: Gắn Authorization vào 3 chỗ gọi API**

1. PUT trong `saveEvent` (app.js:635): `headers: { 'X-Edit-Key': getOrCreateEditKey(currentEventCode) },` → `headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(currentEventCode) }),`
2. POST trong `saveEvent` (nhánh else, sau `contentType`): thêm dòng `headers: AppAuth.authHeaders(),`
3. GET trong `loadEventFromServer` (app.js:709): `headers: storedKey ? { 'X-Edit-Key': storedKey } : {},` → `headers: AppAuth.authHeaders(storedKey ? { 'X-Edit-Key': storedKey } : {}),`

- [ ] **Step 4: Xử lý 401 khi POST**

Trong error handler của nhánh POST (app.js:691-694) thay bằng:

```javascript
                    error: function(xhr) {
                        setSaveStatus('error');
                        if (xhr.status === 401) {
                            showToast('Vui lòng đăng nhập để tạo sự kiện.', 'warning');
                            AppAuth.showLoginModal();
                        } else {
                            showToast('Lỗi khi tạo sự kiện!', 'error');
                        }
                    },
```

- [ ] **Step 5: Gate nút "Tạo Sự Kiện Mới"**

Đầu handler `$('#newEventBtn').click` (app.js:2490), trước `if (!allowEdit)`:

```javascript
            if (!AppAuth.isLoggedIn()) {
                showToast('Vui lòng đăng nhập để tạo sự kiện mới.', 'warning');
                AppAuth.showLoginModal();
                return;
            }
```

- [ ] **Step 6: Gộp danh sách server vào "Sự Kiện Của Tôi"**

Thay toàn bộ hàm `renderSavedEvents` (app.js:1522-1555) bằng:

```javascript
        // Hàm hiển thị danh sách sự kiện đã lưu.
        // Đã đăng nhập: gộp event sở hữu trên server (/api/my-events) với danh
        // sách localStorage (event được chia sẻ cho mình vẫn hiện).
        function renderSavedEvents() {
            $('#savedEventsList').empty();
            $('#savedEventsList').append('<p class="text-center text-muted">Đang tải...</p>');

            const localCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');

            function proceed(serverCodes) {
                // lookup nhận tối đa 50 mã — ưu tiên mã trên server (mới hơn)
                const allCodes = Array.from(new Set(serverCodes.concat(localCodes))).slice(0, 50);
                if (allCodes.length === 0) {
                    $('#savedEventsList').empty();
                    $('#savedEventsList').append('<p class="text-center text-muted">Chưa có sự kiện nào được lưu trên máy này.</p>');
                    return;
                }
                $.ajax({
                    url: '/api/events/lookup',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({ codes: allCodes }),
                    success: function (response) {
                        const events = (response && response.events) || [];
                        // Mã LOCAL không còn tồn tại trên server → dọn khỏi localStorage
                        const found = new Set(events.map(e => e.event_code));
                        localCodes
                            .filter(code => !found.has(code))
                            .forEach(removeEventCodeFromLocalStorage);
                        displaySavedEvents(events);
                    },
                    error: function () {
                        $('#savedEventsList').empty();
                        $('#savedEventsList').append('<p class="text-center text-danger">Không tải được danh sách sự kiện. Vui lòng thử lại.</p>');
                    }
                });
            }

            if (AppAuth.isLoggedIn()) {
                $.ajax({ url: '/api/my-events', headers: AppAuth.authHeaders() })
                    .done(function (r) { proceed(((r && r.events) || []).map(e => e.event_code)); })
                    .fail(function () { proceed([]); });
            } else {
                proceed([]);
            }
        }
```

- [ ] **Step 7: Sau khi đăng nhập, tạo luôn event nháp đang dở (nếu có)**

Thêm sau hàm `renderSavedEvents` mới:

```javascript
        // Vừa đăng nhập xong mà đang có dữ liệu nháp chưa tạo trên server → tạo luôn
        document.addEventListener('appauth:change', function () {
            if (AppAuth.isLoggedIn() && !currentEventCode && allowEdit && members.length > 0) {
                saveEvent(false);
            }
        });
```

- [ ] **Step 8: Syntax check**

Run: `node --check static/app.js`
Expected: không output.

- [ ] **Step 9: Commit**

```bash
git add static/app.js
git commit -m "feat: nối auth vào app.js — gate tạo mới, Authorization header, gộp my-events"
```

### Task 12: Ma trận quyền trong `test_api.py` + docs + verify cuối

**Files:**
- Modify: `test_api.py`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: Supabase Auth (Điều kiện tiên quyết 4 xong), env `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; server chạy với đủ env.
- Produces: `test_api.py` chạy full ma trận quyền với user thật (tự tạo, tự dọn).

- [ ] **Step 1: Thêm helpers Supabase vào `test_api.py`** (sau phần `BASE_URL`)

```python
import secrets

# Env cho test auth (bắt buộc từ khi POST /api/events yêu cầu đăng nhập)
SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_ANON_KEY = os.environ.get('SUPABASE_ANON_KEY', '')
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')


def create_test_user():
    """Tạo user test qua Admin API (service_role — CHỈ dùng trong test) và
    đăng nhập lấy access token thật. Trả về (user_id, access_token)."""
    email = f'test-{secrets.token_hex(6)}@example.com'
    password = secrets.token_urlsafe(16)
    r = requests.post(
        f'{SUPABASE_URL}/auth/v1/admin/users',
        headers={'apikey': SUPABASE_SERVICE_ROLE_KEY,
                 'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}'},
        json={'email': email, 'password': password, 'email_confirm': True},
    )
    assert r.status_code in (200, 201), f'Không tạo được user test: {r.status_code} {r.text}'
    user_id = r.json()['id']
    r = requests.post(
        f'{SUPABASE_URL}/auth/v1/token?grant_type=password',
        headers={'apikey': SUPABASE_ANON_KEY},
        json={'email': email, 'password': password},
    )
    assert r.status_code == 200, f'Không đăng nhập được user test: {r.status_code} {r.text}'
    return user_id, r.json()['access_token']


def delete_test_user(user_id):
    requests.delete(
        f'{SUPABASE_URL}/auth/v1/admin/users/{user_id}',
        headers={'apikey': SUPABASE_SERVICE_ROLE_KEY,
                 'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}'},
    )
```

- [ ] **Step 2: Cập nhật các test hiện có nhận `token`**

- `test_create_event()` → `test_create_event(token)`; thêm vào `headers` của POST: `'Authorization': f'Bearer {token}'`.
- `test_roundtrip_document(event_code, edit_key)` giữ nguyên (PUT bằng edit_key vẫn phải chạy — đây là đường của người được chia sẻ).

- [ ] **Step 3: Thêm test ma trận quyền** (trước `def main`)

```python
def test_auth_matrix(token):
    """Ma trận quyền tạo/sửa: 401 vs 403, owner JWT vs edit_key."""
    print("Testing auth matrix...")
    payload = {"title": "Auth Matrix", "members": ["An"], "expenses": []}

    # 1. POST không token / token rác → 401
    r = requests.post(f"{BASE_URL}/api/events", json=payload)
    assert r.status_code == 401, f'POST không token phải 401, được {r.status_code}'
    r = requests.post(f"{BASE_URL}/api/events", json=payload,
                      headers={'Authorization': 'Bearer khong-phai-jwt'})
    assert r.status_code == 401, f'POST token rác phải 401, được {r.status_code}'
    print("  ✅ POST không/sai token → 401")

    # 2. POST có token → tạo được
    r = requests.post(f"{BASE_URL}/api/events", json=payload,
                      headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200 and r.json().get('edit_key'), r.text
    code = r.json()['event_code']
    edit_key = r.json()['edit_key']
    updated_at = r.json()['updated_at']
    print(f"  ✅ POST có token → tạo được ({code})")

    # 3. GET công khai: không lộ edit_key, can_edit=false; owner JWT: can_edit=true
    r = requests.get(f"{BASE_URL}/api/events/{code}")
    ev = r.json()['event']
    assert 'edit_key' not in ev, 'GET không được trả edit_key'
    assert ev['can_edit'] is False, 'người lạ không có can_edit'
    r = requests.get(f"{BASE_URL}/api/events/{code}",
                     headers={'Authorization': f'Bearer {token}'})
    assert r.json()['event']['can_edit'] is True, 'owner phải có can_edit'
    print("  ✅ GET: không lộ edit_key; can_edit đúng theo vai")

    # 4. PUT bằng owner JWT, KHÔNG có edit_key → 200
    put_doc = dict(payload)
    put_doc['expectedUpdatedAt'] = updated_at
    r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                     headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200, f'owner PUT không cần key phải 200, được {r.status_code}'
    updated_at = r.json()['updated_at']
    print("  ✅ PUT bằng owner JWT (không edit_key) → 200")

    # 5. PUT bằng edit_key, không token → 200 (đường người được chia sẻ)
    put_doc['expectedUpdatedAt'] = updated_at
    r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                     headers={'X-Edit-Key': edit_key})
    assert r.status_code == 200, f'PUT bằng edit_key phải 200, được {r.status_code}'
    updated_at = r.json()['updated_at']
    print("  ✅ PUT bằng edit_key → 200")

    # 6. PUT sai cả hai → 403
    put_doc['expectedUpdatedAt'] = updated_at
    r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                     headers={'X-Edit-Key': 'sai-key'})
    assert r.status_code == 403, f'PUT sai key phải 403, được {r.status_code}'
    print("  ✅ PUT sai key, không token → 403")

    # 7. my-events: có event vừa tạo; không token → 401
    r = requests.get(f"{BASE_URL}/api/my-events",
                     headers={'Authorization': f'Bearer {token}'})
    codes = [e['event_code'] for e in r.json()['events']]
    assert code in codes, 'my-events phải chứa event vừa tạo'
    r = requests.get(f"{BASE_URL}/api/my-events")
    assert r.status_code == 401
    print("  ✅ /api/my-events đúng theo vai")

    # 8. Dọn: owner xóa không cần key
    r = requests.delete(f"{BASE_URL}/api/events/{code}",
                        headers={'Authorization': f'Bearer {token}'})
    assert r.status_code == 200, f'owner DELETE phải 200, được {r.status_code}'
    print("✅ Auth matrix OK")
    return True
```

- [ ] **Step 4: Cập nhật `main()`**

```python
def main():
    """Chạy tất cả tests"""
    print("🚀 Starting API tests...\n")

    if not (SUPABASE_URL and SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY):
        print("❌ Cần SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY để test auth.")
        return

    if not test_banks_api():
        return

    user_id, token = create_test_user()
    try:
        event_code, edit_key = test_create_event(token)
        if not event_code:
            return
        if not test_get_event(event_code, edit_key):
            return
        if not test_lookup_events(event_code):
            return
        if not test_update_event(event_code, edit_key):
            return
        if not test_roundtrip_document(event_code, edit_key):
            return
        if not test_auth_matrix(token):
            return
        if not test_delete_event(event_code, edit_key):
            return
        print("\n🎉 All tests passed!")
    finally:
        delete_test_user(user_id)
```

- [ ] **Step 5: Chạy full integration (cần Điều kiện tiên quyết 4 + env đủ)**

Run (terminal 1): `DATABASE_URL="..." SUPABASE_URL="https://<ref>.supabase.co" SUPABASE_ANON_KEY="..." python3 vercel_app.py`
Run (terminal 2): `BASE_URL=http://localhost:5002 SUPABASE_URL="https://<ref>.supabase.co" SUPABASE_ANON_KEY="..." SUPABASE_SERVICE_ROLE_KEY="..." python3 test_api.py`
Expected: `🎉 All tests passed!`

Smoke test tay trên browser (`http://localhost:5002`): đăng ký/đăng nhập (email + Google), tạo event khi đã đăng nhập, mở link view/edit ở cửa sổ ẩn danh, "Sự Kiện Của Tôi" hiện event server.

- [ ] **Step 6: Cập nhật docs**

`CLAUDE.md`:
- Mục **Auth model** thêm: POST cần JWT Supabase (401 nếu thiếu); owner (JWT, so `owner_id`) có toàn quyền không cần edit_key; verify token trong `supabase_auth.py` (JWKS, không gọi mạng mỗi request); `GET /api/config` trả URL + anon key cho frontend; `GET /api/my-events` (JWT) cho danh sách sở hữu.
- Mục **Frontend** thêm: `static/auth.js` (window.AppAuth) nạp trước app.js; boot app.js bọc trong `AppAuth.onReady`.
- Commands thêm: `python3 test_supabase_auth.py   # unit test verify JWT (không cần DB/mạng)` và env cần cho `test_api.py`.

`README.md`: mục cài đặt thêm 3 env (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, và `SUPABASE_SERVICE_ROLE_KEY` chỉ cho test), các bước bật Google provider (Điều kiện tiên quyết 4), lưu ý cấu hình env trên Vercel.

- [ ] **Step 7: Verify toàn bộ + commit cuối**

Run: `python3 test_event_store.py && python3 test_supabase_auth.py && node test_split.js && node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js`
Expected: tất cả pass.

```bash
git add test_api.py CLAUDE.md README.md
git commit -m "feat: ma trận quyền auth trong test_api + docs (xong giai đoạn 2)"
```

Sau khi merge/deploy: đặt env trên Vercel (`DATABASE_URL` pooler, `SUPABASE_URL`, `SUPABASE_ANON_KEY`), chạy `schema.sql` + `migrate_to_supabase.py` như Task 6, và tag `v2.0.0`.
