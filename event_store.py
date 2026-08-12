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


def load_events_summary(cursor, codes, viewer_user_id=None):
    """Cho /api/events/lookup: các trường tối thiểu danh sách "Sự Kiện Của Tôi"
    cần (đếm thành viên/chi phí + tính tổng theo rates). Giữ shape response cũ
    nhưng expenses chỉ gồm {amount, currency}. cursor là RealDictCursor.

    Event ở chế độ chia sẻ 'restricted' chỉ trả về cho owner HOẶC người được
    mời đích danh (event_collaborators) HOẶC khi event không có chủ
    (owner_id IS NULL — ownerless luôn xem được, khớp quyền GET)
    (viewer_user_id = None → loại hết event restricted có chủ)."""
    cursor.execute(
        '''SELECT id, event_code, title, updated_at FROM events
           WHERE event_code = ANY(%s)
             AND (share_access <> 'restricted' OR owner_id = %s::uuid
                  OR owner_id IS NULL
                  OR EXISTS (SELECT 1 FROM event_collaborators c
                             WHERE c.event_id = events.id AND c.user_id = %s::uuid))''',
        (codes, viewer_user_id, viewer_user_id),
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
