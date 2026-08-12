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
