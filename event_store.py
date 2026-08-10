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
