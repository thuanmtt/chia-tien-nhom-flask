# Lịch sử chỉnh sửa + Khôi phục phiên bản + Bắt buộc đăng nhập — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi lần thêm/sửa/xóa nội dung event được ghi vào bảng `event_revisions` (ai, lúc nào, diff tiếng Việt, snapshot cả document), có API + UI xem lịch sử và khôi phục về phiên bản bất kỳ; mọi thao tác ghi bắt buộc đăng nhập (Supabase JWT).

**Architecture:** PUT của app là cả document nên mỗi lần lưu ≈ một hành động — server diff bản cũ (trong DB) với bản mới (payload) bằng module thuần `revision_diff.py`, ghi snapshot JSONB + summary vào `event_revisions` (module `revision_store.py`) trong cùng transaction với save. Khôi phục = validate lại snapshot rồi ghi đè document + log thêm dòng `restore`. Quyền giữ nguyên (owner/edit_key/link-editor) — đăng nhập là điều kiện bổ sung cho mọi endpoint ghi.

**Tech Stack:** Flask + psycopg2 + Supabase Postgres/Auth (đã có), jQuery + Bootstrap 5 (đã có). Không thêm dependency mới.

**Spec:** `docs/superpowers/specs/2026-08-12-audit-log-restore-design.md` — đọc trước khi làm.

## Global Constraints

- UI text, comment, error message đều tiếng Việt (quy ước repo).
- XSS: mọi render dữ liệu user-controlled qua `escapeHtml()` / `.text()` — summary chứa tên chi phí/thành viên, `actor_name` là username tự đặt.
- Lỗi nội bộ qua `_server_error()`; `except Exception` quanh request-body phải re-raise `HTTPException` trước.
- 401 = chưa đăng nhập, 403 = không có quyền. Message 401 cho endpoint ghi: `"Vui lòng đăng nhập để chỉnh sửa."`
- `GET /api/events/<code>` tuyệt đối không trả `edit_key`.
- Không thêm package mới → không đụng `requirements.txt`/`api/requirements.txt`.
- Test thuần chạy bằng `python3 <file>.py` (plain script, không pytest), theo mẫu `test_event_store.py`.
- `#confirmModal` phải giữ vị trí CUỐI cùng trong DOM (`templates/index.html`).
- Autosave: không thêm `saveEvent` vào đường render/calculate.
- Squash window: 10 phút; giữ tối đa 200 revision/event; cap 10 dòng summary + "… và N thay đổi khác".

---

### Task 1: Bảng `event_revisions` trong schema

**Files:**
- Modify: `schema.sql` (thêm sau bảng `user_profiles`, trước phần INDEX)

**Interfaces:**
- Produces: bảng `event_revisions(id, event_id, actor_id, actor_name, kind, summary, snapshot, created_at)` — các task sau INSERT/SELECT vào đây.

- [ ] **Step 1: Thêm bảng vào `schema.sql`**

Thêm sau block `user_profiles` (sau dòng 99):

```sql
-- Lịch sử chỉnh sửa: mỗi lần ghi (tạo/sửa/khôi phục/đổi chia sẻ) một dòng.
-- snapshot = CẢ document (title + members + expenses + bankInfo + couples +
-- rates) SAU hành động → "khôi phục về bản này" = ghi lại snapshot của dòng đó.
-- actor_id là user Supabase Auth (mọi thao tác ghi giờ bắt buộc đăng nhập);
-- actor_name denormalize (username/email tại thời điểm đó) để đọc không phải
-- join auth.users và tên còn nguyên nếu tài khoản đổi/xóa.
CREATE TABLE IF NOT EXISTS event_revisions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    actor_id   uuid NOT NULL,
    actor_name text NOT NULL DEFAULT '',
    kind       text NOT NULL DEFAULT 'edit', -- 'create' | 'edit' | 'restore' | 'share'
    summary    jsonb NOT NULL DEFAULT '[]',
    snapshot   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

Thêm vào phần INDEX (cạnh các `CREATE INDEX` khác):

```sql
CREATE INDEX IF NOT EXISTS idx_event_revisions_event_created
    ON event_revisions (event_id, created_at DESC);
```

Thêm vào phần RLS cuối file (cùng format các dòng `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`):

```sql
ALTER TABLE event_revisions       ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Áp schema lên DB**

Run: `psql "$DATABASE_URL" -f schema.sql` (DATABASE_URL lấy từ `.env` repo root: `export $(grep -E '^DATABASE_URL=' .env | xargs)` hoặc `source` thủ công).
Expected: các lệnh chạy không lỗi (idempotent).
Nếu máy không có `psql` hoặc không nối được DB: ghi chú lại trong commit message là schema chưa áp, phải chạy tay trước khi deploy — KHÔNG bỏ qua im lặng.

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "feat: bảng event_revisions cho lịch sử chỉnh sửa"
```

---

### Task 2: Diff engine `revision_diff.py` (TDD)

**Files:**
- Create: `revision_diff.py`
- Create: `test_revision_diff.py`

**Interfaces:**
- Consumes: shape document đã validate (xem docstring `event_store.py`): `{title, members: [str], expenses: [{title, amount, currency, payer, benefitType, beneficiaries, expense_date, created_time, updated_time}], bankInfo: {tên: {bank, account}}, couples: [{id, label, members, primary}], rates: {mã: {...}}}`.
- Produces: `diff_documents(old_doc, new_doc) -> list[dict]`, mỗi phần tử `{'a': 'add'|'update'|'remove'|'more', 'o': str, 't': str}`. Hằng `MAX_ACTIONS = 10`. Task 6 gọi hàm này; Task 4 so tập `(a, o)` để squash.

- [ ] **Step 1: Viết test fail trước — `test_revision_diff.py`**

```python
#!/usr/bin/env python3
"""Unit test thuần cho revision_diff (không cần DB/server): diff hai document
phải ra đúng danh sách hành động tiếng Việt, match expense theo created_time,
cap 10 dòng, và không đổi → rỗng."""

import copy
import sys

from revision_diff import diff_documents, MAX_ACTIONS

BASE = {
    'title': 'Đi Đà Lạt',
    'members': ['An', 'Bình'],
    'expenses': [
        {'title': 'Khách sạn', 'amount': 1500000, 'currency': 'VND',
         'payer': 'An', 'benefitType': 'all', 'beneficiaries': [],
         'expense_date': '2026-08-01', 'created_time': '2026-08-01T10:00:00',
         'updated_time': '2026-08-01T10:00:00'},
    ],
    'bankInfo': {'An': {'bank': 'VCB', 'account': '123456'}},
    'couples': [{'id': 'c1', 'label': 'Vợ chồng An', 'members': ['An', 'Bình'], 'primary': 'An'}],
    'rates': {'USD': {'rate': 25000, 'source': 'test', 'rateDate': '2026-08-01',
                      'rateType': 'mid', 'currencyName': 'US Dollar'}},
}


def _texts(actions):
    return [a['t'] for a in actions]


def test_no_change():
    assert diff_documents(BASE, copy.deepcopy(BASE)) == []
    print('✅ không đổi → []')


def test_updated_time_only_ignored():
    new = copy.deepcopy(BASE)
    new['expenses'][0]['updated_time'] = '2026-08-05T09:00:00'
    assert diff_documents(BASE, new) == []
    print('✅ chỉ đổi updated_time → [] (không phải thay đổi thật)')


def test_title_change():
    new = copy.deepcopy(BASE)
    new['title'] = 'Đi Sapa'
    actions = diff_documents(BASE, new)
    assert actions == [{'a': 'update', 'o': 'title', 't': "Đổi tên sự kiện thành 'Đi Sapa'"}]
    print('✅ đổi title')


def test_member_add_remove():
    new = copy.deepcopy(BASE)
    new['members'] = ['An', 'Chi']  # Bình bị xóa, Chi được thêm
    actions = diff_documents(BASE, new)
    assert {'a': 'add', 'o': 'member:Chi', 't': "Thêm thành viên 'Chi'"} in actions
    assert {'a': 'remove', 'o': 'member:Bình', 't': "Xóa thành viên 'Bình'"} in actions
    assert len(actions) == 2
    print('✅ thêm/xóa thành viên')


def test_expense_add_shows_amount():
    new = copy.deepcopy(BASE)
    new['expenses'].append({
        'title': 'Ăn tối', 'amount': 500000, 'currency': 'VND',
        'payer': 'Bình', 'benefitType': 'all', 'beneficiaries': [],
        'expense_date': '', 'created_time': '2026-08-02T19:00:00', 'updated_time': ''})
    actions = diff_documents(BASE, new)
    assert actions == [{'a': 'add', 'o': 'expense:2026-08-02T19:00:00',
                        't': "Thêm chi phí 'Ăn tối' (500.000 đ)"}]
    print('✅ thêm chi phí kèm số tiền định dạng VN')


def test_expense_update_matched_by_created_time_despite_reorder():
    new = copy.deepcopy(BASE)
    new['expenses'].append({
        'title': 'Ăn tối', 'amount': 45.5, 'currency': 'USD',
        'payer': 'Bình', 'benefitType': 'all', 'beneficiaries': [],
        'expense_date': '', 'created_time': '2026-08-02T19:00:00', 'updated_time': ''})
    old = copy.deepcopy(new)
    # đảo thứ tự + sửa số tiền của 'Khách sạn' — vẫn phải nhận ra là update
    new['expenses'].reverse()
    new['expenses'][1]['amount'] = 1800000
    actions = diff_documents(old, new)
    assert len(actions) == 1 and actions[0]['a'] == 'update'
    assert actions[0]['o'] == 'expense:2026-08-01T10:00:00'
    assert 'số tiền 1.500.000 đ → 1.800.000 đ' in actions[0]['t']
    print('✅ match expense theo created_time, kể cả khi đổi thứ tự')


def test_expense_remove():
    new = copy.deepcopy(BASE)
    new['expenses'] = []
    actions = diff_documents(BASE, new)
    assert actions == [{'a': 'remove', 'o': 'expense:2026-08-01T10:00:00',
                        't': "Xóa chi phí 'Khách sạn'"}]
    print('✅ xóa chi phí')


def test_expense_without_created_time_falls_back_to_position():
    old = copy.deepcopy(BASE)
    old['expenses'][0]['created_time'] = ''
    new = copy.deepcopy(old)
    new['expenses'][0]['payer'] = 'Bình'
    actions = diff_documents(old, new)
    assert len(actions) == 1 and actions[0]['a'] == 'update'
    assert "người trả 'An' → 'Bình'" in actions[0]['t']
    print('✅ fallback theo position khi thiếu created_time')


def test_foreign_currency_format():
    new = copy.deepcopy(BASE)
    new['expenses'].append({
        'title': 'Vé máy bay', 'amount': 45.5, 'currency': 'USD',
        'payer': 'An', 'benefitType': 'all', 'beneficiaries': [],
        'expense_date': '', 'created_time': 'x1', 'updated_time': ''})
    actions = diff_documents(BASE, new)
    assert actions[0]['t'] == "Thêm chi phí 'Vé máy bay' (45,50 USD)"
    print('✅ định dạng ngoại tệ')


def test_bank_couple_rate_changes():
    new = copy.deepcopy(BASE)
    new['bankInfo']['An']['account'] = '999999'
    new['bankInfo']['Bình'] = {'bank': 'MB', 'account': '1'}
    new['couples'][0]['label'] = 'Nhà An'
    new['rates']['USD'] = dict(new['rates']['USD'], rate=26000)
    new['rates']['THB'] = {'rate': 700, 'source': 'test', 'rateDate': None,
                           'rateType': None, 'currencyName': ''}
    texts = _texts(diff_documents(BASE, new))
    assert "Cập nhật tài khoản ngân hàng của 'An'" in texts
    assert "Thêm tài khoản ngân hàng của 'Bình'" in texts
    assert "Sửa nhóm chung quỹ 'Nhà An'" in texts
    assert 'Cập nhật tỷ giá USD' in texts
    assert 'Thêm tỷ giá THB' in texts
    print('✅ bankInfo / couples / rates')


def test_cap_10_actions():
    old = {'title': 'X', 'members': [], 'expenses': [], 'bankInfo': {},
           'couples': [], 'rates': {}}
    new = dict(old, members=[f'TV{i}' for i in range(15)])
    actions = diff_documents(old, new)
    assert len(actions) == MAX_ACTIONS + 1
    assert actions[-1] == {'a': 'more', 'o': '', 't': '… và 5 thay đổi khác'}
    print('✅ cap 10 hành động + dòng "… và N thay đổi khác"')


if __name__ == '__main__':
    test_no_change()
    test_updated_time_only_ignored()
    test_title_change()
    test_member_add_remove()
    test_expense_add_shows_amount()
    test_expense_update_matched_by_created_time_despite_reorder()
    test_expense_remove()
    test_expense_without_created_time_falls_back_to_position()
    test_foreign_currency_format()
    test_bank_couple_rate_changes()
    test_cap_10_actions()
    print('\n🎉 test_revision_diff: tất cả pass')
    sys.exit(0)
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `python3 test_revision_diff.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'revision_diff'`

- [ ] **Step 3: Viết `revision_diff.py`**

```python
"""Diff hai document sự kiện → danh sách hành động tiếng Việt cho lịch sử.

Mỗi hành động: {'a': 'add'|'update'|'remove'|'more', 'o': <khóa đối tượng>, 't': <mô tả>}.
Khóa đối tượng ổn định giữa các lần lưu để squash nhận ra "vẫn đang sửa cùng
một thứ": expense theo created_time (client sinh lúc tạo, coi như id; fallback
vị trí khi trống), member/bank theo tên, couple theo client_id, rate theo mã
tiền. Module thuần — không DB; test: python3 test_revision_diff.py.
"""

MAX_ACTIONS = 10


def _fmt_money(amount, currency='VND'):
    """Định dạng kiểu VN: 1.500.000 đ / 45,50 USD."""
    if amount is None:
        return '?'
    amount = float(amount)
    if amount == int(amount):
        s = f'{int(amount):,}'.replace(',', '.')
    else:
        s = f'{amount:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
    unit = 'đ' if (currency or 'VND') == 'VND' else currency
    return f'{s} {unit}'


def _index_expenses(expenses):
    out = {}
    for i, exp in enumerate(expenses or []):
        created = (exp.get('created_time') or '').strip()
        key = f'expense:{created}' if created else f'expense:#{i}'
        if key in out:  # created_time trùng nhau — tách bằng vị trí
            key = f'{key}#{i}'
        out[key] = exp
    return out


def _diff_expense(old, new):
    """Các phần thay đổi của một chi phí (bỏ qua updated_time — client tự bump)."""
    parts = []
    if old.get('title') != new.get('title'):
        parts.append(f"tiêu đề '{old.get('title')}' → '{new.get('title')}'")
    if (old.get('amount') != new.get('amount')
            or (old.get('currency') or 'VND') != (new.get('currency') or 'VND')):
        parts.append(
            f"số tiền {_fmt_money(old.get('amount'), old.get('currency'))}"
            f" → {_fmt_money(new.get('amount'), new.get('currency'))}")
    if old.get('payer') != new.get('payer'):
        parts.append(f"người trả '{old.get('payer')}' → '{new.get('payer')}'")
    if (old.get('benefitType') != new.get('benefitType')
            or old.get('beneficiaries') != new.get('beneficiaries')):
        parts.append('người hưởng')
    if old.get('expense_date') != new.get('expense_date'):
        parts.append(f"ngày {old.get('expense_date') or '—'} → {new.get('expense_date') or '—'}")
    return parts


def _couple_label(couple):
    return couple.get('label') or ', '.join(couple.get('members') or [])


def diff_documents(old_doc, new_doc):
    """So document cũ/mới (shape đã validate) → list hành động, cap MAX_ACTIONS."""
    actions = []

    if (old_doc.get('title') or '') != (new_doc.get('title') or ''):
        actions.append({'a': 'update', 'o': 'title',
                        't': f"Đổi tên sự kiện thành '{new_doc.get('title') or ''}'"})

    old_members = old_doc.get('members') or []
    new_members = new_doc.get('members') or []
    for name in new_members:
        if name not in old_members:
            actions.append({'a': 'add', 'o': f'member:{name}', 't': f"Thêm thành viên '{name}'"})
    for name in old_members:
        if name not in new_members:
            actions.append({'a': 'remove', 'o': f'member:{name}', 't': f"Xóa thành viên '{name}'"})

    old_exp = _index_expenses(old_doc.get('expenses'))
    new_exp = _index_expenses(new_doc.get('expenses'))
    for key, exp in new_exp.items():
        if key not in old_exp:
            actions.append({'a': 'add', 'o': key,
                            't': f"Thêm chi phí '{exp.get('title')}'"
                                 f" ({_fmt_money(exp.get('amount'), exp.get('currency'))})"})
        else:
            parts = _diff_expense(old_exp[key], exp)
            if parts:
                actions.append({'a': 'update', 'o': key,
                                't': f"Sửa chi phí '{exp.get('title')}': " + ', '.join(parts)})
    for key, exp in old_exp.items():
        if key not in new_exp:
            actions.append({'a': 'remove', 'o': key, 't': f"Xóa chi phí '{exp.get('title')}'"})

    old_bank = old_doc.get('bankInfo') or {}
    new_bank = new_doc.get('bankInfo') or {}
    for name, info in new_bank.items():
        if name not in old_bank:
            actions.append({'a': 'add', 'o': f'bank:{name}',
                            't': f"Thêm tài khoản ngân hàng của '{name}'"})
        elif old_bank[name] != info:
            actions.append({'a': 'update', 'o': f'bank:{name}',
                            't': f"Cập nhật tài khoản ngân hàng của '{name}'"})
    for name in old_bank:
        if name not in new_bank:
            actions.append({'a': 'remove', 'o': f'bank:{name}',
                            't': f"Xóa tài khoản ngân hàng của '{name}'"})

    old_couples = {c.get('id') or f'#{i}': c for i, c in enumerate(old_doc.get('couples') or [])}
    new_couples = {c.get('id') or f'#{i}': c for i, c in enumerate(new_doc.get('couples') or [])}
    for cid, couple in new_couples.items():
        if cid not in old_couples:
            actions.append({'a': 'add', 'o': f'couple:{cid}',
                            't': f"Thêm nhóm chung quỹ '{_couple_label(couple)}'"})
        elif old_couples[cid] != couple:
            actions.append({'a': 'update', 'o': f'couple:{cid}',
                            't': f"Sửa nhóm chung quỹ '{_couple_label(couple)}'"})
    for cid, couple in old_couples.items():
        if cid not in new_couples:
            actions.append({'a': 'remove', 'o': f'couple:{cid}',
                            't': f"Xóa nhóm chung quỹ '{_couple_label(couple)}'"})

    old_rates = old_doc.get('rates') or {}
    new_rates = new_doc.get('rates') or {}
    for code, entry in new_rates.items():
        if code not in old_rates:
            actions.append({'a': 'add', 'o': f'rate:{code}', 't': f'Thêm tỷ giá {code}'})
        elif old_rates[code] != entry:
            actions.append({'a': 'update', 'o': f'rate:{code}', 't': f'Cập nhật tỷ giá {code}'})
    for code in old_rates:
        if code not in new_rates:
            actions.append({'a': 'remove', 'o': f'rate:{code}', 't': f'Xóa tỷ giá {code}'})

    if len(actions) > MAX_ACTIONS:
        extra = len(actions) - MAX_ACTIONS
        actions = actions[:MAX_ACTIONS]
        actions.append({'a': 'more', 'o': '', 't': f'… và {extra} thay đổi khác'})
    return actions
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `python3 test_revision_diff.py`
Expected: tất cả `✅`, kết thúc `🎉 test_revision_diff: tất cả pass`

- [ ] **Step 5: Commit**

```bash
git add revision_diff.py test_revision_diff.py
git commit -m "feat: diff engine tiếng Việt cho lịch sử chỉnh sửa (revision_diff)"
```

---

### Task 3: `supabase_auth.py` trả claims (email) — TDD

**Files:**
- Modify: `supabase_auth.py`
- Modify: `test_supabase_auth.py`

**Interfaces:**
- Produces: `verify_access_claims(token) -> dict|None` (claims đã verify), `request_user_claims(request) -> dict|None`. `request_user_id`/`verify_access_token` giữ nguyên chữ ký, refactor để dùng chung. Task 5-7 dùng `request_user_claims` (cần `sub` + `email`).

- [ ] **Step 1: Thêm test fail vào `test_supabase_auth.py`**

Sửa `_make_token` để nhét thêm claim email (thay hàm hiện có):

```python
def _make_token(key=PRIVATE_KEY, aud='authenticated', sub=USER_ID, expired=False,
                email='test@example.com'):
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now - datetime.timedelta(hours=1) if expired else now + datetime.timedelta(hours=1)
    return pyjwt.encode(
        {'sub': sub, 'aud': aud, 'exp': exp, 'iat': now, 'email': email},
        key, algorithm='ES256',
    )
```

Thêm vào `main()` ngay trước dòng `print('\n🎉 ...')`:

```python
    claims = supabase_auth.verify_access_claims(_make_token())
    assert claims and claims['sub'] == USER_ID and claims['email'] == 'test@example.com'
    print('✅ verify_access_claims: token hợp lệ → dict claims (sub + email)')

    assert supabase_auth.verify_access_claims(_make_token(expired=True)) is None
    assert supabase_auth.verify_access_claims('rác') is None
    assert supabase_auth.verify_access_claims(None) is None
    print('✅ verify_access_claims: token hỏng → None')
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `python3 test_supabase_auth.py`
Expected: FAIL — `AttributeError: module 'supabase_auth' has no attribute 'verify_access_claims'`

- [ ] **Step 3: Refactor `supabase_auth.py`**

Thay hai hàm `verify_access_token` và `request_user_id` bằng:

```python
def verify_access_claims(token):
    """Trả về dict claims đã verify nếu token hợp lệ, ngược lại None.

    Không raise — token thiếu/hết hạn/sai chữ ký/sai audience đều coi như
    chưa đăng nhập (caller quyết định 401 hay đi tiếp ẩn danh)."""
    if not token:
        return None
    client = _get_jwk_client()
    if client is None:
        return None
    try:
        signing_key = client.get_signing_key_from_jwt(token)
        return pyjwt.decode(
            token,
            signing_key.key,
            algorithms=['ES256', 'RS256'],
            audience='authenticated',
        )
    except Exception:
        return None


def verify_access_token(token):
    """Trả về user id (claim sub) nếu token hợp lệ, ngược lại None."""
    claims = verify_access_claims(token)
    return (claims.get('sub') or None) if claims else None


def request_user_claims(request):
    """Claims đã verify từ header Authorization của request Flask (None nếu không có)."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    return verify_access_claims(auth[len('Bearer '):].strip())


def request_user_id(request):
    """Lấy user id từ header Authorization của request Flask (None nếu không có)."""
    claims = request_user_claims(request)
    return (claims.get('sub') or None) if claims else None
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `python3 test_supabase_auth.py`
Expected: tất cả `✅` (cả các test cũ), `🎉 test_supabase_auth: tất cả pass`

- [ ] **Step 5: Commit**

```bash
git add supabase_auth.py test_supabase_auth.py
git commit -m "feat: supabase_auth trả claims (email) cho actor_name của lịch sử"
```

---

### Task 4: `revision_store.py` — ghi/đọc revision, squash, prune

**Files:**
- Create: `revision_store.py`

**Interfaces:**
- Consumes: bảng `event_revisions` (Task 1); format summary của `revision_diff` (Task 2).
- Produces (Task 6-7 gọi):
  - `record_revision(cursor, event_id, actor_id, actor_name, kind, summary, snapshot_doc)` — cursor thường, PHẢI gọi trong transaction caller đã mở.
  - `list_revisions(cursor, event_id)` — cursor RealDictCursor → `list[{'id': str, 'actor_name': str, 'kind': str, 'summary': list[str], 'created_at': str_iso}]`, mới nhất trước, tối đa 200.
  - `get_revision(cursor, event_id, revision_id)` — cursor thường → `(snapshot_dict, created_at_datetime)` hoặc `(None, None)`.
  - Hằng: `SQUASH_WINDOW_SECONDS = 600`, `MAX_REVISIONS_PER_EVENT = 200`.

Tầng này là SQL mỏng (như phần SQL của `event_store.py` — không có unit test thuần); hành vi được cover bằng integration test ở Task 8.

- [ ] **Step 1: Viết `revision_store.py`**

```python
"""Ghi/đọc lịch sử chỉnh sửa (bảng event_revisions).

Mỗi revision: ai (actor), lúc nào, làm gì (summary — output của
revision_diff.diff_documents) và snapshot JSONB cả document SAU hành động.

Squash chống nhiễu autosave: nếu revision MỚI NHẤT của event là cùng actor,
cùng kind 'edit', trong vòng 10 phút, đụng đúng cùng tập đối tượng và toàn
hành động 'update' → cập nhật dòng đó thay vì thêm dòng mới (kiểu Google Docs
gộp chuỗi gõ phím sửa cùng một thứ thành một phiên bản).
"""

import json

SQUASH_WINDOW_SECONDS = 600
MAX_REVISIONS_PER_EVENT = 200


def record_revision(cursor, event_id, actor_id, actor_name, kind, summary, snapshot_doc):
    """Ghi 1 revision. PHẢI được gọi trong transaction caller đã mở
    (BEGIN ... COMMIT) — lỗi ghi log phải fail cả save, audit không được thiếu dòng."""
    if kind == 'edit' and _try_squash(cursor, event_id, actor_id, summary, snapshot_doc):
        return
    cursor.execute(
        '''INSERT INTO event_revisions (event_id, actor_id, actor_name, kind, summary, snapshot)
           VALUES (%s, %s, %s, %s, %s, %s)''',
        (event_id, actor_id, actor_name, kind, json.dumps(summary), json.dumps(snapshot_doc)),
    )
    _prune(cursor, event_id)


def _try_squash(cursor, event_id, actor_id, summary, snapshot_doc):
    subjects = {(a.get('a'), a.get('o')) for a in summary}
    # Chỉ squash khi toàn 'update' (thêm/xóa là hành động rời rạc, giữ từng dòng)
    if not subjects or any(action != 'update' for action, _obj in subjects):
        return False
    cursor.execute(
        '''SELECT id, actor_id, kind, summary FROM event_revisions
           WHERE event_id = %s
             AND created_at > now() - make_interval(secs => %s)
           ORDER BY created_at DESC LIMIT 1''',
        (event_id, SQUASH_WINDOW_SECONDS),
    )
    row = cursor.fetchone()
    if row is None:
        return False
    rev_id, prev_actor, prev_kind, prev_summary = row
    if prev_kind != 'edit' or str(prev_actor) != str(actor_id):
        return False
    prev_subjects = {(a.get('a'), a.get('o')) for a in (prev_summary or [])}
    if prev_subjects != subjects:
        return False
    cursor.execute(
        'UPDATE event_revisions SET summary = %s, snapshot = %s, created_at = now() WHERE id = %s',
        (json.dumps(summary), json.dumps(snapshot_doc), rev_id),
    )
    return True


def _prune(cursor, event_id):
    cursor.execute(
        '''DELETE FROM event_revisions
           WHERE event_id = %s AND id NOT IN (
               SELECT id FROM event_revisions
               WHERE event_id = %s ORDER BY created_at DESC LIMIT %s)''',
        (event_id, event_id, MAX_REVISIONS_PER_EVENT),
    )


def list_revisions(cursor, event_id):
    """Danh sách revision mới nhất trước (tối đa MAX_REVISIONS_PER_EVENT).

    cursor PHẢI là RealDictCursor. summary trả về CHỈ list text 't' — client
    không cần khóa 'a'/'o' (chúng chỉ phục vụ squash). KHÔNG trả snapshot (nặng)."""
    cursor.execute(
        '''SELECT id, actor_name, kind, summary, created_at
           FROM event_revisions WHERE event_id = %s
           ORDER BY created_at DESC LIMIT %s''',
        (event_id, MAX_REVISIONS_PER_EVENT),
    )
    return [
        {
            'id': str(r['id']),
            'actor_name': r['actor_name'],
            'kind': r['kind'],
            'summary': [a.get('t', '') for a in (r['summary'] or [])],
            'created_at': r['created_at'].isoformat() if r['created_at'] else None,
        }
        for r in cursor.fetchall()
    ]


def get_revision(cursor, event_id, revision_id):
    """(snapshot dict, created_at datetime) của 1 revision thuộc event — filter
    theo event_id để không đọc được revision của event khác. (None, None) nếu
    không có. cursor thường."""
    cursor.execute(
        'SELECT snapshot, created_at FROM event_revisions WHERE event_id = %s AND id = %s',
        (event_id, revision_id),
    )
    row = cursor.fetchone()
    if row is None:
        return None, None
    return row[0], row[1]
```

- [ ] **Step 2: Syntax check**

Run: `python3 -c "import revision_store; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add revision_store.py
git commit -m "feat: revision_store — ghi/đọc lịch sử, squash autosave, prune 200 bản/event"
```

---

### Task 5: Bắt buộc đăng nhập khi ghi + cờ mới trong GET (`vercel_app.py`)

**Files:**
- Modify: `vercel_app.py` — import (dòng 19), `create_event` (~185), `get_event` (~447-486), `update_event` (~494), `update_sharing` (~734), `delete_event` (~765)

**Interfaces:**
- Consumes: `request_user_claims` (Task 3).
- Produces: biến `claims` có sẵn trong `create_event`/`update_event`/`update_sharing`/`delete_event` (Task 6 dùng cho actor); GET trả thêm `login_required_to_edit: bool` và `can_edit` = có-quyền VÀ đã-đăng-nhập (Task 9 frontend dựa vào).

- [ ] **Step 1: Đổi import**

```python
from supabase_auth import request_user_id, request_user_claims
```

- [ ] **Step 2: `create_event` — lấy claims thay vì chỉ user id**

Thay 3 dòng đầu trong `try` (hiện là `user_id = request_user_id(request)` + check + return 401):

```python
        # Tạo sự kiện yêu cầu đăng nhập (401 ≠ 403: chưa đăng nhập vs không có quyền)
        claims = request_user_claims(request)
        user_id = (claims or {}).get('sub')
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để tạo sự kiện.'}), 401
```

- [ ] **Step 3: Gate 401 cho `update_event`**

Thêm NGAY ĐẦU `try` của `update_event` (trước `raw = request.get_json(...)`):

```python
        # Mọi thao tác ghi yêu cầu đăng nhập — để hành động gắn được danh tính
        # vào lịch sử. Quyền sửa (owner/edit_key/link-editor) kiểm tra sau, như cũ.
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401
```

- [ ] **Step 4: Gate 401 cho `update_sharing` và `delete_event`**

Thêm cùng block đó ngay đầu `try` của `update_sharing` (trước `body = request.get_json(...)`) và của `delete_event` (trước `conn = get_db_connection()`). Copy nguyên văn block ở Step 3 vào cả hai chỗ.

- [ ] **Step 5: `get_event` — can_edit tính cả trạng thái đăng nhập + cờ mới**

Thay 2 dòng hiện tại:

```python
        link_editor = event['share_access'] == 'link' and event['share_role'] == 'editor'
        can_edit = is_owner or key_ok or (not stored_key) or link_editor
```

bằng:

```python
        # Quyền sửa: owner / key đúng / sự kiện chưa có khóa (legacy) /
        # chia sẻ "ai có link đều chỉnh sửa". Nhưng mọi thao tác ghi giờ yêu cầu
        # đăng nhập → can_edit ("PUT của bạn sẽ thành công") chỉ true khi CÓ
        # QUYỀN và ĐÃ đăng nhập; có quyền mà chưa đăng nhập → cờ riêng để UI
        # hiện "Đăng nhập để chỉnh sửa".
        link_editor = event['share_access'] == 'link' and event['share_role'] == 'editor'
        has_permission = is_owner or key_ok or (not stored_key) or link_editor
        can_edit = has_permission and bool(user_id)
        login_required_to_edit = has_permission and not user_id
```

và trong dict response (cạnh `'can_edit': can_edit,`) thêm:

```python
                'login_required_to_edit': login_required_to_edit,
```

(Xóa comment cũ "Quyền sửa: owner / key đúng..." phía trên vì đã gộp vào comment mới.)

- [ ] **Step 6: Syntax check + chạy test thuần**

Run: `python3 -c "import vercel_app; print('OK')" && python3 test_supabase_auth.py && python3 test_event_store.py`
Expected: `OK` + tất cả test pass. (`import vercel_app` không cần DB — connection mở lazy.)

- [ ] **Step 7: Commit**

```bash
git add vercel_app.py
git commit -m "feat: bắt buộc đăng nhập cho mọi thao tác ghi (PUT/DELETE/sharing) + cờ login_required_to_edit"
```

---

### Task 6: Ghi revision trong POST / PUT / sharing (`vercel_app.py`)

**Files:**
- Modify: `vercel_app.py` — imports, thêm `_actor_info` + `_SHARE_LABEL` (sau `_check_edit_permission`), `create_event`, `update_event`, `update_sharing`

**Interfaces:**
- Consumes: `diff_documents` (Task 2), `record_revision` (Task 4), `load_event_children` (có sẵn), biến `claims` (Task 5).
- Produces: `_actor_info(cursor, claims) -> (user_id, display_name)` — Task 7 dùng lại.

- [ ] **Step 1: Thêm imports**

```python
from event_store import replace_event_children, load_event_children, load_events_summary
from revision_diff import diff_documents
from revision_store import record_revision, list_revisions, get_revision
```

(dòng `event_store` giữ nguyên — chỉ liệt kê để thấy vị trí; thêm 2 dòng mới ngay dưới nó. `list_revisions`/`get_revision` dùng ở Task 7.)

- [ ] **Step 2: Thêm helper sau `_check_edit_permission`**

```python
def _actor_info(cursor, claims):
    """(user_id, tên hiển thị) của người thực hiện — cho lịch sử chỉnh sửa.
    Ưu tiên username (user_profiles), không có thì email từ JWT. Denormalize
    vào từng revision để đọc lịch sử không phải join auth.users."""
    user_id = claims.get('sub')
    cursor.execute('SELECT username FROM user_profiles WHERE user_id = %s::uuid', (user_id,))
    row = cursor.fetchone()
    name = (row[0] if row and row[0] else None) or claims.get('email') or ''
    return user_id, name


def _load_full_document(conn, cursor, event_id):
    """Document đầy đủ (title + children) của event — cho diff/snapshot lịch sử.
    Mở RealDictCursor riêng vì load_event_children yêu cầu dict cursor; cùng
    connection nên vẫn nằm trong transaction đang mở của caller."""
    cursor.execute('SELECT title FROM events WHERE id = %s', (event_id,))
    title = cursor.fetchone()[0]
    dict_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        doc = load_event_children(dict_cur, event_id)
    finally:
        dict_cur.close()
    return dict(doc, title=title)


# Nhãn tiếng Việt cho revision 'share' (khớp các giá trị validate ở update_sharing)
_SHARE_LABEL = {
    ('restricted', 'viewer'): 'Hạn chế',
    ('restricted', 'editor'): 'Hạn chế',
    ('link', 'viewer'): 'Bất kỳ ai có liên kết — người xem',
    ('link', 'editor'): 'Bất kỳ ai có liên kết — người chỉnh sửa',
}
```

- [ ] **Step 3: `create_event` — log revision `create`**

Trong transaction hiện có, sau `replace_event_children(cursor, event_id, data)` và trước `cursor.execute('COMMIT')`:

```python
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'create',
                            [{'a': 'add', 'o': 'event', 't': 'Tạo sự kiện'}], data)
```

- [ ] **Step 4: `update_event` — load bản cũ, diff, log revision `edit`**

Thay block transaction hiện tại (từ `cursor.execute('BEGIN')` đến `cursor.execute('COMMIT')`) bằng:

```python
        try:
            cursor.execute('BEGIN')
            # Bản cũ phải đọc TRONG transaction, trước khi ghi đè — để diff cho lịch sử
            old_doc = _load_full_document(conn, cursor, event_id)
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            summary = diff_documents(old_doc, data)
            if summary:  # lưu không đổi gì (no-op) → không ghi dòng lịch sử
                actor_id, actor_name = _actor_info(cursor, claims)
                record_revision(cursor, event_id, actor_id, actor_name, 'edit', summary, data)
            cursor.execute('COMMIT')
```

(phần `except/finally` giữ nguyên như cũ.)

- [ ] **Step 5: `update_sharing` — log revision `share` trong transaction**

Thay block hiện tại:

```python
        cursor.execute(
            'UPDATE events SET share_access = %s, share_role = %s WHERE id = %s',
            (access, role, event_id),
        )
        cursor.close()
        return jsonify({'success': True, 'share_access': access, 'share_role': role})
```

bằng:

```python
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                'UPDATE events SET share_access = %s, share_role = %s WHERE id = %s',
                (access, role, event_id),
            )
            # Đổi chia sẻ cũng là hành động cần trace — snapshot là document
            # hiện tại (nội dung không đổi, restore về dòng này vẫn đúng nghĩa)
            snapshot = _load_full_document(conn, cursor, event_id)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'share',
                            [{'a': 'update', 'o': 'sharing',
                              't': f'Đổi quyền truy cập: {_SHARE_LABEL[(access, role)]}'}],
                            snapshot)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        return jsonify({'success': True, 'share_access': access, 'share_role': role})
```

(Lưu ý: vẫn KHÔNG bump `updated_at` — giữ hành vi cũ, tránh 409 vô cớ.)

- [ ] **Step 6: Syntax check**

Run: `python3 -c "import vercel_app; print('OK')"`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add vercel_app.py
git commit -m "feat: ghi lịch sử chỉnh sửa cho tạo/sửa event và đổi chia sẻ"
```

---

### Task 7: Endpoint `GET /revisions` + `POST /restore` (`vercel_app.py`)

**Files:**
- Modify: `vercel_app.py` — thêm 2 route sau `update_sharing`, trước `delete_event`; thêm import `uuid`, `timedelta`

**Interfaces:**
- Consumes: `list_revisions`/`get_revision` (Task 4), `_actor_info`/`_load_full_document` (Task 6), `validate_event_payload`, `replace_event_children`, `_check_edit_permission`.
- Produces: `GET /api/events/<code>/revisions` → `{success, revisions: [...]}`; `POST /api/events/<code>/restore` body `{revision_id, expectedUpdatedAt}` → `{success, updated_at}` (Task 9 frontend gọi).

- [ ] **Step 1: Thêm import**

Đầu file: thêm `import uuid` (cạnh `import secrets`) và đổi `from datetime import datetime` thành `from datetime import datetime, timedelta`.

- [ ] **Step 2: Route xem lịch sử**

```python
@app.route('/api/events/<event_code>/revisions')
@limiter.limit('60 per minute')
def list_event_revisions(event_code):
    """Lịch sử chỉnh sửa — chỉ người có quyền sửa (và đã đăng nhập) xem được.
    Trả tối đa 200 dòng mới nhất trước, KHÔNG kèm snapshot (nặng)."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để xem lịch sử.'}), 401

        conn = get_db_connection()
        cursor = conn.cursor()
        permission, event_id, _unused = _check_edit_permission(cursor, event_code)
        cursor.close()
        if permission == 'not_found':
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            return jsonify({'success': False, 'error': 'Bạn không có quyền xem lịch sử sự kiện này.'}), 403

        dict_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        revisions = list_revisions(dict_cur, event_id)
        dict_cur.close()
        return jsonify({'success': True, 'revisions': revisions})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 3: Route khôi phục**

```python
@app.route('/api/events/<event_code>/restore', methods=['POST'])
@limiter.limit('10 per minute; 100 per day')
def restore_event(event_code):
    """Khôi phục event về snapshot của một revision (kiểu lịch sử Google Docs).

    Ghi snapshot cũ đè lên document hiện tại và log thêm dòng 'restore' —
    lịch sử không bao giờ bị xóa lùi, khôi phục nhầm thì khôi phục ngược lại."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401

        body = request.get_json(silent=True) or {}
        revision_id = body.get('revision_id')
        try:
            uuid.UUID(str(revision_id))
        except (ValueError, TypeError):
            return jsonify({'success': False, 'error': 'Không tìm thấy phiên bản.'}), 404
        expected_updated_at = body.get('expectedUpdatedAt')

        conn = get_db_connection()
        cursor = conn.cursor()
        permission, event_id, current_updated_at = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền chỉnh sửa sự kiện này.'}), 403

        # Optimistic locking như PUT — không ghi đè âm thầm bản ai đó vừa lưu
        # trong lúc người này mở lịch sử
        if (expected_updated_at and current_updated_at
                and current_updated_at.isoformat() != expected_updated_at):
            cursor.close()
            return jsonify({
                'success': False,
                'conflict': True,
                'error': 'Sự kiện đã được cập nhật ở nơi khác.',
            }), 409

        snapshot, rev_created_at = get_revision(cursor, event_id, str(revision_id))
        if snapshot is None:
            cursor.close()
            return jsonify({'success': False, 'error': 'Không tìm thấy phiên bản.'}), 404
        try:
            # Snapshot cũ phải qua validation hiện hành — dữ liệu từng hợp lệ
            # có thể không còn (đổi rule) → chặn thay vì ghi bừa
            data = validate_event_payload(snapshot)
        except ValidationError:
            cursor.close()
            return jsonify({'success': False, 'error': 'Phiên bản này không còn khôi phục được.'}), 400

        # Giờ VN (UTC+7, không DST) cho text lịch sử
        vn_time = (rev_created_at + timedelta(hours=7)).strftime('%H:%M %d/%m/%Y')
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'restore',
                            [{'a': 'update', 'o': 'restore',
                              't': f'Khôi phục về phiên bản lúc {vn_time}'}], data)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        new_updated_at = new_row[0].isoformat() if new_row and new_row[0] else None
        return jsonify({'success': True, 'updated_at': new_updated_at})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)
```

- [ ] **Step 4: Syntax check**

Run: `python3 -c "import vercel_app; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py
git commit -m "feat: API xem lịch sử chỉnh sửa và khôi phục phiên bản"
```

---

### Task 8: Cập nhật `test_api.py` + chạy integration

**Files:**
- Modify: `test_api.py`

**Interfaces:**
- Consumes: toàn bộ API sau Task 5-7. Hành vi MỚI phải test: PUT/DELETE với edit_key mà KHÔNG có JWT → 401 (trước là 200/403).

- [ ] **Step 1: Cập nhật các test cũ theo yêu cầu đăng nhập**

Các thay đổi trong `test_api.py`:

0. `test_get_event(event_code, edit_key)` → `test_get_event(event_code, edit_key, token)` (cập nhật lời gọi trong `main()`). `can_edit` giờ = có quyền VÀ đã đăng nhập, nên block "Key đúng -> can_edit=True" hiện tại sẽ fail. Thay block đó bằng:
   ```python
   # Key đúng nhưng CHƯA đăng nhập → can_edit=False + cờ mời đăng nhập
   response = requests.get(f"{BASE_URL}/api/events/{event_code}", headers={'X-Edit-Key': edit_key})
   event = response.json().get('event') or {}
   if event.get('can_edit') is not False or event.get('login_required_to_edit') is not True:
       print(f"❌ key đúng không JWT phải can_edit=False + login_required_to_edit=True, nhận: {event.get('can_edit')}/{event.get('login_required_to_edit')}")
       return False
   print("✅ key đúng chưa đăng nhập → can_edit=False, login_required_to_edit=True")

   # Key đúng + đã đăng nhập → can_edit=True
   response = requests.get(f"{BASE_URL}/api/events/{event_code}",
                           headers={'X-Edit-Key': edit_key, 'Authorization': f'Bearer {token}'})
   if response.status_code == 200:
       data = response.json()
       if data.get('success'):
           event = data.get('event')
           if event.get('can_edit') is not True:
               print(f"❌ can_edit phải là True với key đúng + JWT, nhận: {event.get('can_edit')}")
               return False
           print(f"✅ Get event OK - Title: {event.get('title')} (can_edit=True với key đúng + JWT)")
           return True
       else:
           print(f"❌ Get event failed - {data.get('error')}")
           return False
   else:
       print(f"❌ Get event failed - Status: {response.status_code}")
       return False
   ```
   (Block "không key / sai key → can_edit=False" phía trên giữ nguyên.)
1. `test_update_event(event_code, edit_key)` → `test_update_event(event_code, edit_key, token)`. Block "Không có / sai edit_key phải bị chặn":
   - Không token, có key đúng → giờ phải **401**:
     ```python
     r = requests.put(f"{BASE_URL}/api/events/{event_code}", json=event_data,
                      headers={'X-Edit-Key': edit_key})
     if r.status_code != 401:
         print(f"❌ PUT không đăng nhập phải 401, nhận {r.status_code}")
         return False
     print("✅ PUT có key nhưng chưa đăng nhập → 401")
     ```
   - Có token + sai key → **403** (giữ test cũ nhưng thêm `'Authorization': f'Bearer {token}'` vào headers).
   - Mọi PUT hợp lệ còn lại trong hàm: thêm `'Authorization': f'Bearer {token}'` vào headers (giữ `X-Edit-Key` — token này là owner nên vẫn pass; đường "key + JWT người khác" test ở auth matrix).
2. `test_roundtrip_document(event_code, edit_key)` → thêm tham số `token`, thêm `'Authorization': f'Bearer {token}'` vào headers của lệnh PUT.
3. `test_delete_event(event_code, edit_key)` → thêm tham số `token`:
   - DELETE không token → **401** (thay expect 403 hiện tại).
   - DELETE có token owner + key → 200 như cũ (thêm Authorization header).
4. `test_auth_matrix(token)`: cần user thứ hai để test "edit_key + JWT người không phải owner":
   - Đầu hàm thêm: `user2_id, token2 = create_test_user()` và bọc phần thân còn lại trong `try:` ... `finally: delete_test_user(user2_id)`.
   - Bước 5 cũ ("PUT bằng edit_key, không token → 200") đổi thành:
     ```python
     # 5a. PUT bằng edit_key, KHÔNG token → 401 (mọi thao tác ghi cần đăng nhập)
     put_doc['expectedUpdatedAt'] = updated_at
     r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                      headers={'X-Edit-Key': edit_key})
     assert r.status_code == 401, f'PUT edit_key không token phải 401, được {r.status_code}'
     # 5b. PUT bằng edit_key + JWT user KHÁC (không phải owner) → 200
     r = requests.put(f"{BASE_URL}/api/events/{code}", json=put_doc,
                      headers={'X-Edit-Key': edit_key, 'Authorization': f'Bearer {token2}'})
     assert r.status_code == 200, f'PUT edit_key + JWT phải 200, được {r.status_code}'
     updated_at = r.json()['updated_at']
     print("  ✅ PUT edit_key: không token → 401; kèm JWT user khác → 200")
     ```
   - Bước 6 ("PUT sai key → 403"): thêm `'Authorization': f'Bearer {token2}'` vào headers (không có token giờ ra 401 chứ không tới được 403).
5. Trong `main()`: cập nhật lời gọi `test_update_event(event_code, edit_key, token)`, `test_roundtrip_document(event_code, edit_key, token)`, `test_delete_event(event_code, edit_key, token)`.

- [ ] **Step 2: Thêm test mới cho lịch sử + khôi phục**

Thêm hàm (sau `test_auth_matrix`), và gọi trong `main()` ngay trước `test_delete_event`:

```python
def test_revisions_and_restore(token):
    """Lịch sử chỉnh sửa: ghi đúng diff, squash lưu liên tiếp, khôi phục phiên bản."""
    print("Testing revisions & restore...")
    auth = {'Authorization': f'Bearer {token}'}
    base_doc = {
        "title": "Lịch Sử Test", "members": ["An", "Bình"],
        "expenses": [{"title": "Ăn sáng", "amount": 100000, "currency": "VND",
                      "payer": "An", "benefitType": "all", "beneficiaries": [],
                      "expense_date": "", "created_time": "t1", "updated_time": ""}],
    }
    r = requests.post(f"{BASE_URL}/api/events", json=base_doc, headers=auth)
    assert r.status_code == 200, r.text
    code, updated_at = r.json()['event_code'], r.json()['updated_at']
    try:
        # 1. Chưa đăng nhập → 401; đăng nhập → thấy dòng 'create'
        r = requests.get(f"{BASE_URL}/api/events/{code}/revisions")
        assert r.status_code == 401, f'revisions không token phải 401, được {r.status_code}'
        r = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth)
        assert r.status_code == 200, r.text
        revs = r.json()['revisions']
        assert len(revs) == 1 and revs[0]['kind'] == 'create', revs
        assert revs[0]['summary'] == ['Tạo sự kiện']
        assert 'snapshot' not in revs[0], 'revisions không được trả snapshot'
        print("  ✅ revision 'create' + chặn 401")

        # 2. PUT sửa số tiền + thêm thành viên → revision 'edit' với diff đúng
        doc2 = dict(base_doc, members=["An", "Bình", "Chi"])
        doc2['expenses'] = [dict(base_doc['expenses'][0], amount=200000)]
        doc2['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc2, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert len(revs) == 2 and revs[0]['kind'] == 'edit', revs
        joined = ' | '.join(revs[0]['summary'])
        assert "Thêm thành viên 'Chi'" in joined and 'Sửa chi phí' in joined, joined
        print("  ✅ revision 'edit' với diff tiếng Việt")

        # 3. PUT tiếp, lại sửa CÙNG chi phí → squash: vẫn 2 dòng
        doc3 = dict(doc2)
        doc3['expenses'] = [dict(base_doc['expenses'][0], amount=300000)]
        doc3['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc3, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        # lần 2 chỉ sửa expense t1 (update) — nhưng lần 1 có cả 'add' member
        # → tập đối tượng khác → KHÔNG squash với lần 1; tự PUT thêm lần nữa
        doc4 = dict(doc3)
        doc4['expenses'] = [dict(base_doc['expenses'][0], amount=400000)]
        doc4['expectedUpdatedAt'] = updated_at
        r = requests.put(f"{BASE_URL}/api/events/{code}", json=doc4, headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        revs2 = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert len(revs2) == len(revs), f'sửa liên tiếp cùng chi phí phải squash: {len(revs)} → {len(revs2)}'
        assert '400.000' in ' '.join(revs2[0]['summary']), revs2[0]['summary']
        print("  ✅ squash các lần lưu liên tiếp sửa cùng đối tượng")

        # 4. Restore về bản 'create' → nội dung quay lại ban đầu + có dòng 'restore'
        create_rev = revs2[-1]
        assert create_rev['kind'] == 'create'
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': create_rev['id'], 'expectedUpdatedAt': updated_at},
                          headers=auth)
        assert r.status_code == 200, r.text
        updated_at = r.json()['updated_at']
        ev = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth).json()['event']
        assert ev['members'] == ['An', 'Bình'], ev['members']
        assert ev['expenses'][0]['amount'] == 100000, ev['expenses']
        revs = requests.get(f"{BASE_URL}/api/events/{code}/revisions", headers=auth).json()['revisions']
        assert revs[0]['kind'] == 'restore' and 'Khôi phục về phiên bản lúc' in revs[0]['summary'][0]
        print("  ✅ restore đúng nội dung + tự ghi dòng 'restore'")

        # 5. Restore với expectedUpdatedAt cũ → 409; revision_id rác → 404
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': create_rev['id'],
                                'expectedUpdatedAt': '1999-01-01T00:00:00'},
                          headers=auth)
        assert r.status_code == 409, f'restore stale phải 409, được {r.status_code}'
        r = requests.post(f"{BASE_URL}/api/events/{code}/restore",
                          json={'revision_id': 'khong-phai-uuid', 'expectedUpdatedAt': updated_at},
                          headers=auth)
        assert r.status_code == 404, f'revision_id rác phải 404, được {r.status_code}'
        print("  ✅ restore: 409 khi stale, 404 khi revision_id rác")

        # 6. User khác (không quyền) xem lịch sử → 403
        user2_id, token2 = create_test_user()
        try:
            r = requests.get(f"{BASE_URL}/api/events/{code}/revisions",
                             headers={'Authorization': f'Bearer {token2}'})
            assert r.status_code == 403, f'người không quyền phải 403, được {r.status_code}'
        finally:
            delete_test_user(user2_id)
        print("  ✅ người không có quyền sửa không xem được lịch sử")
        print("✅ Revisions & restore OK")
        return True
    finally:
        requests.delete(f"{BASE_URL}/api/events/{code}", headers=auth)
```

- [ ] **Step 3: Chạy integration test**

Cần `.env` đầy đủ (DATABASE_URL, SUPABASE_*) và schema Task 1 đã áp lên DB.
Run: `python3 vercel_app.py &` (đợi ~2s cho server lên) rồi `python3 test_api.py`; xong `kill %1`.
Expected: `🎉 All tests passed!`
Nếu không có DB/mạng: chạy được đến đâu ghi nhận đến đó, KHÔNG được claim pass — báo rõ trong commit message/PR note là integration chưa chạy.

- [ ] **Step 4: Commit**

```bash
git add test_api.py
git commit -m "test: cập nhật test_api theo yêu cầu đăng nhập + test lịch sử/khôi phục"
```

---

### Task 9: Frontend — banner đăng nhập, xử lý 401, modal Lịch sử

**Files:**
- Modify: `templates/index.html` — nút Lịch sử (~dòng 100 khu `group-actions`), banner (~dòng 89 đầu `.col-lg-8`), modal `#historyModal` (TRƯỚC `#confirmModal` ~dòng 722)
- Modify: `static/app.js` — `updateUIForEditMode` (~211), `saveEvent` error handler (~704), `loadEventFromServer` (~778), `createNewEvent` (~526), listener `appauth:change` (~1646), block lịch sử mới (đặt cạnh `showConfirm`, ~2600)
- Modify: `static/sw.js` — dòng 1

**Interfaces:**
- Consumes: `GET /api/events/<code>` trả `login_required_to_edit` (Task 5); `GET .../revisions`, `POST .../restore` (Task 7); helper sẵn có: `escapeHtml`, `showToast`, `showConfirm`, `setSaveStatus`, `getOrCreateEditKey`, `removeEditKey`, `AppAuth.authHeaders/showLoginModal/isLoggedIn`, biến `allowEdit`, `currentEventCode`, `lastKnownUpdatedAt`.

- [ ] **Step 1: `index.html` — banner đăng nhập để sửa**

Ngay sau `<div class="col-lg-8 mx-auto">` (trước card đầu tiên):

```html
            <div id="loginToEditBanner" class="alert alert-info d-none">
                <i class="fas fa-lock me-1"></i>
                Bạn có quyền chỉnh sửa sự kiện này — đăng nhập để bắt đầu chỉnh sửa.
                <button type="button" class="btn btn-sm btn-primary ms-2" id="loginToEditBtn">
                    <i class="fas fa-sign-in-alt me-1"></i>Đăng nhập
                </button>
            </div>
```

- [ ] **Step 2: `index.html` — nút Lịch sử**

Trong `.group-actions`, ngay TRƯỚC nút `#shareEventBtn`:

```html
                            <button class="btn btn-sm btn-outline-secondary me-2 mb-1 mb-md-0" id="historyBtn">
                                <i class="fas fa-clock-rotate-left me-1"></i> Lịch sử
                            </button>
```

- [ ] **Step 3: `index.html` — modal Lịch sử**

Ngay TRƯỚC `<div class="modal fade" id="confirmModal" ...>` (confirmModal phải giữ vị trí cuối DOM):

```html
<!-- Modal lịch sử chỉnh sửa (phải đứng TRƯỚC confirmModal — confirmModal cần stack trên cùng) -->
<div class="modal fade" id="historyModal" tabindex="-1">
    <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title"><i class="fas fa-clock-rotate-left me-2"></i>Lịch sử chỉnh sửa</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <div class="text-center text-muted py-3 d-none" id="historyLoading">
                    <i class="fas fa-circle-notch fa-spin me-1"></i> Đang tải lịch sử...
                </div>
                <ul class="list-group" id="historyList"></ul>
            </div>
        </div>
    </div>
</div>
```

- [ ] **Step 4: `app.js` — `updateUIForEditMode` ẩn/hiện nút Lịch sử**

Trong nhánh `if (!allowEdit)` (cạnh `$('#shareEventBtn').hide();`): thêm `$('#historyBtn').hide();`
Trong nhánh `else` (cạnh `$('#shareEventBtn').show();`): thêm `$('#historyBtn').show();`

- [ ] **Step 5: `app.js` — `loadEventFromServer` xử lý `login_required_to_edit`**

Thay block trong `success` (hiện tại):

```js
                            allowEdit = !!eventData.can_edit;
                            if (!allowEdit && storedKey) {
                                // Khóa sai hoặc đã bị đổi — bỏ khóa hỏng, chuyển chỉ xem
                                removeEditKey(eventCode);
                                showToast('Khóa chỉnh sửa không đúng — đang mở ở chế độ chỉ xem.', 'warning');
                            }
```

bằng:

```js
                            allowEdit = !!eventData.can_edit;
                            // Có quyền sửa nhưng chưa đăng nhập → banner mời đăng nhập,
                            // KHÔNG xóa key (key vẫn đúng, chỉ thiếu đăng nhập)
                            const loginRequired = !!eventData.login_required_to_edit;
                            $('#loginToEditBanner').toggleClass('d-none', !loginRequired);
                            if (!allowEdit && storedKey && !loginRequired) {
                                // Khóa sai hoặc đã bị đổi — bỏ khóa hỏng, chuyển chỉ xem
                                removeEditKey(eventCode);
                                showToast('Khóa chỉnh sửa không đúng — đang mở ở chế độ chỉ xem.', 'warning');
                            }
```

Và trong nhánh `if (opts.forceViewOnly)` phía trên, thêm `$('#loginToEditBanner').addClass('d-none');` sau `allowEdit = false;`.

- [ ] **Step 6: `app.js` — ẩn banner khi tạo sự kiện mới**

Trong `function createNewEvent` (anchor: dòng `allowEdit = true; // sự kiện mới do chính mình tạo`), thêm ngay sau dòng đó:

```js
            $('#loginToEditBanner').addClass('d-none');
```

- [ ] **Step 7: `app.js` — nút banner + reload khi đăng nhập/đăng xuất**

Thêm handler (cạnh các handler khác, ví dụ sau block `appauth:change`):

```js
        $(document).on('click', '#loginToEditBtn', function () {
            AppAuth.showLoginModal();
        });
```

Thay listener `appauth:change` hiện tại:

```js
        // Vừa đăng nhập xong mà đang có dữ liệu nháp chưa tạo trên server → tạo luôn
        document.addEventListener('appauth:change', function () {
            if (AppAuth.isLoggedIn() && !currentEventCode && allowEdit && members.length > 0) {
                saveEvent(false);
            }
        });
```

bằng:

```js
        // Vừa đăng nhập xong mà đang có dữ liệu nháp chưa tạo trên server → tạo luôn.
        // Đang mở event thì tải lại để server tính lại can_edit (đăng nhập → mở
        // khóa chỉnh sửa; đăng xuất → về chỉ xem + banner).
        document.addEventListener('appauth:change', function () {
            if (AppAuth.isLoggedIn() && !currentEventCode && allowEdit && members.length > 0) {
                saveEvent(false);
            } else if (currentEventCode) {
                loadEventFromServer(currentEventCode);
            }
        });
```

- [ ] **Step 8: `app.js` — `saveEvent` xử lý 401 khi PUT**

Trong error handler của nhánh PUT (hiện bắt đầu `if (xhr.status === 403)`), thêm nhánh 401 TRƯỚC 403:

```js
                        if (xhr.status === 401) {
                            // Phiên đăng nhập hết hạn giữa chừng — KHÔNG về chỉ-xem,
                            // giữ nguyên dữ liệu trên trang; đăng nhập xong lưu lại được
                            showToast('Vui lòng đăng nhập để chỉnh sửa sự kiện.', 'warning');
                            AppAuth.showLoginModal();
                        } else if (xhr.status === 403) {
```

- [ ] **Step 9: `app.js` — block Lịch sử chỉnh sửa**

Thêm trước `function showConfirm(...)`:

```js
        // ===== Lịch sử chỉnh sửa =====
        const REVISION_KIND_BADGE = {
            create: '<span class="badge bg-primary me-1">Tạo</span>',
            restore: '<span class="badge bg-warning text-dark me-1">Khôi phục</span>',
            share: '<span class="badge bg-info text-dark me-1">Chia sẻ</span>'
        };

        function formatRevisionTime(iso) {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        }

        function renderHistory(revisions) {
            const $list = $('#historyList').empty();
            if (!revisions.length) {
                $list.append('<li class="list-group-item text-muted">Chưa có lịch sử chỉnh sửa.</li>');
                return;
            }
            revisions.forEach((rev, idx) => {
                // XSS: actor_name là username tự đặt, summary chứa tên chi phí/
                // thành viên người dùng nhập — tất cả phải qua escapeHtml
                const badge = REVISION_KIND_BADGE[rev.kind] || '';
                const summaryHtml = (rev.summary || [])
                    .map(t => `<div class="small text-body-secondary">${escapeHtml(t)}</div>`).join('');
                const restoreBtn = idx === 0 ? '' : `
                    <button class="btn btn-sm btn-outline-warning history-restore-btn"
                            data-id="${escapeHtml(rev.id)}" data-time="${escapeHtml(rev.created_at || '')}">
                        <i class="fas fa-rotate-left me-1"></i>Khôi phục
                    </button>`;
                $list.append(`
                    <li class="list-group-item">
                        <div class="d-flex justify-content-between align-items-start">
                            <div>
                                <div>${badge}<strong>${escapeHtml(rev.actor_name || 'Không rõ')}</strong>
                                    <span class="text-muted small ms-1">${escapeHtml(formatRevisionTime(rev.created_at))}</span>
                                </div>
                                ${summaryHtml}
                            </div>
                            <div class="ms-2 flex-shrink-0">${restoreBtn}</div>
                        </div>
                    </li>`);
            });
        }

        function loadHistory() {
            $('#historyLoading').removeClass('d-none');
            $('#historyList').empty();
            $.ajax({
                url: `/api/events/${currentEventCode}/revisions`,
                headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(currentEventCode) }),
                success: function (res) {
                    $('#historyLoading').addClass('d-none');
                    if (res.success) renderHistory(res.revisions || []);
                },
                error: function (xhr) {
                    $('#historyLoading').addClass('d-none');
                    if (xhr.status === 401) {
                        showToast('Vui lòng đăng nhập để xem lịch sử.', 'warning');
                        AppAuth.showLoginModal();
                    } else {
                        showToast('Không tải được lịch sử chỉnh sửa.', 'error');
                    }
                }
            });
        }

        $('#historyBtn').on('click', function () {
            if (!allowEdit || !currentEventCode) return;
            bootstrap.Modal.getOrCreateInstance(document.getElementById('historyModal')).show();
            loadHistory();
        });

        $(document).on('click', '.history-restore-btn', function () {
            const revisionId = $(this).data('id');
            const timeLabel = formatRevisionTime(String($(this).data('time') || ''));
            showConfirm(
                `Khôi phục sự kiện về phiên bản lúc ${timeLabel}? Nội dung hiện tại sẽ được thay bằng bản này (thao tác khôi phục cũng được ghi vào lịch sử).`,
                function () {
                    $.ajax({
                        url: `/api/events/${currentEventCode}/restore`,
                        method: 'POST',
                        contentType: 'application/json',
                        headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(currentEventCode) }),
                        data: JSON.stringify({ revision_id: revisionId, expectedUpdatedAt: lastKnownUpdatedAt }),
                        success: function (res) {
                            if (res.success) {
                                bootstrap.Modal.getOrCreateInstance(document.getElementById('historyModal')).hide();
                                showToast('Đã khôi phục sự kiện về phiên bản đã chọn.', 'success');
                                loadEventFromServer(currentEventCode);
                            }
                        },
                        error: function (xhr) {
                            if (xhr.status === 409) {
                                showToast('Sự kiện vừa được cập nhật ở nơi khác — đang tải lại.', 'warning');
                                loadEventFromServer(currentEventCode);
                                loadHistory();
                            } else if (xhr.status === 401) {
                                showToast('Vui lòng đăng nhập để khôi phục.', 'warning');
                                AppAuth.showLoginModal();
                            } else {
                                showToast('Không khôi phục được phiên bản này.', 'error');
                            }
                        }
                    });
                },
                { okLabel: 'Khôi phục', okClass: 'btn-warning' }
            );
        });
        // ===== Hết phần lịch sử chỉnh sửa =====
```

- [ ] **Step 10: `sw.js` — bump cache**

Dòng 1: `const CACHE_VERSION = 'v4';` → `const CACHE_VERSION = 'v5';`

- [ ] **Step 11: Syntax check JS**

Run: `node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js`
Expected: không output (exit 0)

- [ ] **Step 12: Commit**

```bash
git add templates/index.html static/app.js static/sw.js
git commit -m "feat: UI lịch sử chỉnh sửa + khôi phục; banner đăng nhập để sửa; xử lý 401 khi lưu"
```

---

### Task 10: Tài liệu — CLAUDE.md, CHANGELOG.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md` (thêm entry đầu file theo format sẵn có trong file)

- [ ] **Step 1: Cập nhật `CLAUDE.md`**

1. Mục **Commands**, sau dòng `python3 test_supabase_auth.py`:
   ```
   python3 test_revision_diff.py   # unit test diff lịch sử chỉnh sửa (không cần DB)
   ```
2. Mục **Auth model**, thêm bullet:
   ```
   - **Mọi thao tác ghi yêu cầu đăng nhập**: PUT/DELETE/sharing/restore trả 401 khi thiếu JWT
     (401 = chưa đăng nhập, 403 = không có quyền). edit_key/link-editor vẫn quyết định QUYỀN,
     JWT chỉ để gắn danh tính. GET không cần đăng nhập; `can_edit` = có quyền VÀ đã đăng nhập,
     kèm cờ `login_required_to_edit` khi có quyền mà chưa đăng nhập (UI hiện banner mời đăng nhập).
   ```
3. Mục **Storage model**, thêm:
   ```
   Lịch sử chỉnh sửa: bảng `event_revisions` (actor, kind create/edit/restore/share, summary
   diff tiếng Việt từ `revision_diff.py`, snapshot JSONB cả document SAU hành động) — ghi trong
   CÙNG transaction với save qua `revision_store.py` (squash chuỗi update cùng đối tượng cùng
   actor trong 10 phút; giữ 200 bản/event). `GET /api/events/<code>/revisions` (quyền sửa) xem
   lịch sử; `POST /api/events/<code>/restore` khôi phục snapshot (validate lại, log dòng
   'restore', optimistic locking 409). Xóa event vẫn là DELETE cứng — revisions mất theo.
   ```
4. Mục **Frontend**, thêm vào đoạn key state / modal:
   ```
   Modal `#historyModal` (nút "Lịch sử" trên header, chỉ khi allowEdit) hiển thị revisions +
   nút khôi phục qua showConfirm; `#confirmModal` vẫn phải là modal CUỐI trong DOM.
   ```

- [ ] **Step 2: Thêm entry `CHANGELOG.md`**

Thêm ngay sau dòng `# Changelog` (trước entry `[1.0.0]`):

```markdown
## [1.1.0] - 2026-08-12

### Thêm mới
- ✅ Lịch sử chỉnh sửa: mỗi lần thêm/sửa/xóa ghi lại ai làm, lúc nào, thay đổi gì (diff tiếng Việt)
- ✅ Khôi phục sự kiện về phiên bản bất kỳ trong lịch sử (kiểu Google Docs)
- ✅ API `GET /api/events/<event_code>/revisions` và `POST /api/events/<event_code>/restore`

### Thay đổi
- 🔄 Mọi thao tác chỉnh sửa (lưu/xóa/đổi chia sẻ/khôi phục) yêu cầu đăng nhập — quyền qua edit_key/link chia sẻ giữ nguyên, đăng nhập để gắn danh tính vào lịch sử
```

- [ ] **Step 3: Chạy lại toàn bộ test thuần lần cuối**

Run: `python3 test_revision_diff.py && python3 test_event_store.py && python3 test_supabase_auth.py && node --check static/app.js && node --check static/sw.js`
Expected: tất cả pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: cập nhật CLAUDE.md/CHANGELOG cho lịch sử chỉnh sửa + đăng nhập bắt buộc"
```

---

## Ghi chú cho người thực thi

- **Thứ tự task là bắt buộc** (5-7 sửa cùng `vercel_app.py`, 8 test hành vi của 5-7).
- Integration test (Task 1 Step 2, Task 8 Step 3) cần `.env` + DB Supabase thật. Không có thì báo rõ là chưa chạy — đừng claim pass.
- Deploy lên Vercel: phải chạy `psql "$DATABASE_URL" -f schema.sql` lên DB production TRƯỚC khi deploy code (bảng mới; code cũ không đụng bảng này nên áp schema trước là an toàn).
- Sau merge, người dùng cũ đang sửa ẩn danh qua link-editor/edit_key sẽ thấy banner mời đăng nhập — hành vi chủ đích của spec, không phải bug.
