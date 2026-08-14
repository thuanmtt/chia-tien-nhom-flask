"""Kiểm tra & chuẩn hoá payload sự kiện từ client.

Mọi body POST/PUT event của vercel_app.py đều đi qua validate_event_payload —
type check + cap kích thước, message tiếng Việt an toàn để trả client (400).
"""

import math

MAX_TITLE_LEN = 200
MAX_NAME_LEN = 100
MAX_MEMBERS = 100
MAX_EXPENSES = 2000
MAX_EXPENSE_TITLE_LEN = 500
MAX_CURRENCY_LEN = 10
MAX_DATE_LEN = 40
MAX_AMOUNT = 1e15
MAX_COUPLES = 50
MAX_RATES = 100
MAX_SETTLEMENTS = 200
MAX_BANK_CODE_LEN = 20
MAX_BANK_ACCOUNT_LEN = 50

DEFAULT_TITLE = 'Sự Kiện Mới'


class ValidationError(ValueError):
    """Payload không hợp lệ — message an toàn để trả về client."""


def _clean_str(value, max_len, field, allow_empty=True):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValidationError(f'{field} phải là chuỗi')
    value = value.strip()
    if not allow_empty and not value:
        raise ValidationError(f'{field} không được để trống')
    if len(value) > max_len:
        raise ValidationError(f'{field} quá dài (tối đa {max_len} ký tự)')
    return value


def _clean_amount(value, field):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValidationError(f'{field} phải là số')
    if not math.isfinite(value) or value < 0 or value > MAX_AMOUNT:
        raise ValidationError(f'{field} không hợp lệ')
    return value


def _clean_members(raw):
    if not isinstance(raw, list):
        raise ValidationError('Danh sách thành viên không hợp lệ')
    if len(raw) > MAX_MEMBERS:
        raise ValidationError(f'Tối đa {MAX_MEMBERS} thành viên')
    return [_clean_str(m, MAX_NAME_LEN, 'Tên thành viên', allow_empty=False) for m in raw]


def _clean_expenses(raw):
    if not isinstance(raw, list):
        raise ValidationError('Danh sách chi phí không hợp lệ')
    if len(raw) > MAX_EXPENSES:
        raise ValidationError(f'Tối đa {MAX_EXPENSES} chi phí')
    cleaned = []
    for exp in raw:
        if not isinstance(exp, dict):
            raise ValidationError('Chi phí không hợp lệ')
        benefit_type = exp.get('benefitType', 'all')
        if benefit_type not in ('all', 'selected'):
            benefit_type = 'all'
        beneficiaries = exp.get('beneficiaries', [])
        if not isinstance(beneficiaries, list) or len(beneficiaries) > MAX_MEMBERS:
            raise ValidationError('Danh sách người hưởng không hợp lệ')
        cleaned.append({
            'title': _clean_str(exp.get('title'), MAX_EXPENSE_TITLE_LEN, 'Tiêu đề chi phí'),
            'amount': _clean_amount(exp.get('amount', 0), 'Số tiền'),
            'currency': _clean_str(exp.get('currency', 'VND'), MAX_CURRENCY_LEN, 'Mã tiền tệ') or 'VND',
            'payer': _clean_str(exp.get('payer'), MAX_NAME_LEN, 'Người thanh toán'),
            'benefitType': benefit_type,
            'beneficiaries': [
                _clean_str(b, MAX_NAME_LEN, 'Tên người hưởng', allow_empty=False)
                for b in beneficiaries
            ],
            'expense_date': _clean_str(exp.get('expense_date'), MAX_DATE_LEN, 'Ngày phát sinh'),
            'created_time': _clean_str(exp.get('created_time'), MAX_DATE_LEN, 'Thời gian tạo'),
            'updated_time': _clean_str(exp.get('updated_time'), MAX_DATE_LEN, 'Thời gian cập nhật'),
        })
    return cleaned


def _clean_bank_info(raw):
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > MAX_MEMBERS:
        raise ValidationError('Thông tin ngân hàng không hợp lệ')
    cleaned = {}
    for member, info in raw.items():
        member = _clean_str(member, MAX_NAME_LEN, 'Tên thành viên', allow_empty=False)
        if not isinstance(info, dict):
            raise ValidationError('Thông tin ngân hàng không hợp lệ')
        cleaned[member] = {
            'bank': _clean_str(info.get('bank'), MAX_BANK_CODE_LEN, 'Mã ngân hàng'),
            'account': _clean_str(info.get('account'), MAX_BANK_ACCOUNT_LEN, 'Số tài khoản'),
        }
    return cleaned


def _clean_couples(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_COUPLES:
        raise ValidationError('Danh sách nhóm chung quỹ không hợp lệ')
    cleaned = []
    for couple in raw:
        if not isinstance(couple, dict):
            raise ValidationError('Nhóm chung quỹ không hợp lệ')
        member_list = couple.get('members', [])
        if not isinstance(member_list, list) or len(member_list) > MAX_MEMBERS:
            raise ValidationError('Nhóm chung quỹ không hợp lệ')
        cleaned.append({
            'id': _clean_str(couple.get('id'), 50, 'Mã nhóm'),
            'label': _clean_str(couple.get('label'), MAX_TITLE_LEN, 'Tên nhóm'),
            'members': [
                _clean_str(m, MAX_NAME_LEN, 'Tên thành viên', allow_empty=False)
                for m in member_list
            ],
            'primary': _clean_str(couple.get('primary'), MAX_NAME_LEN, 'Người đại diện'),
        })
    return cleaned


def _clean_settlements(raw):
    """Đánh dấu "đã chuyển tiền": mỗi mục khớp ĐÚNG một giao dịch trong kết quả
    chia tiền theo (from, to, amount) — số dư đổi thì mất khớp và coi như chưa
    đánh dấu (đúng ngữ nghĩa: giao dịch cũ không còn tồn tại)."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_SETTLEMENTS:
        raise ValidationError('Danh sách đánh dấu đã chuyển không hợp lệ')
    cleaned = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValidationError('Đánh dấu đã chuyển không hợp lệ')
        cleaned.append({
            'from': _clean_str(item.get('from'), MAX_NAME_LEN, 'Người chuyển', allow_empty=False),
            'to': _clean_str(item.get('to'), MAX_NAME_LEN, 'Người nhận', allow_empty=False),
            'amount': _clean_amount(item.get('amount', 0), 'Số tiền'),
            'settled_time': _clean_str(item.get('settled_time'), MAX_DATE_LEN, 'Thời gian đánh dấu'),
        })
    return cleaned


def _clean_rates(raw):
    if raw is None:
        return {}
    if not isinstance(raw, dict) or len(raw) > MAX_RATES:
        raise ValidationError('Danh sách tỷ giá không hợp lệ')
    cleaned = {}
    for code, entry in raw.items():
        code = _clean_str(code, MAX_CURRENCY_LEN, 'Mã tiền tệ', allow_empty=False)
        if not isinstance(entry, dict):
            raise ValidationError('Tỷ giá không hợp lệ')
        rate = entry.get('rate')
        if rate is not None:
            rate = _clean_amount(rate, 'Tỷ giá')
        cleaned[code] = {
            'rate': rate,
            'source': _clean_str(entry.get('source'), 40, 'Nguồn tỷ giá'),
            'rateDate': _clean_str(entry.get('rateDate'), MAX_DATE_LEN, 'Ngày tỷ giá') or None,
            'rateType': _clean_str(entry.get('rateType'), 20, 'Loại tỷ giá') or None,
            'currencyName': _clean_str(entry.get('currencyName'), MAX_NAME_LEN, 'Tên tiền tệ'),
        }
    return cleaned


def validate_event_payload(data):
    """Trả về dict đã chuẩn hoá, hoặc raise ValidationError với message an toàn."""
    if not isinstance(data, dict):
        raise ValidationError('Dữ liệu gửi lên phải là JSON object')
    title = _clean_str(data.get('title'), MAX_TITLE_LEN, 'Tên sự kiện') or DEFAULT_TITLE
    return {
        'title': title,
        'members': _clean_members(data.get('members', [])),
        'expenses': _clean_expenses(data.get('expenses', [])),
        'bankInfo': _clean_bank_info(data.get('bankInfo', {})),
        'couples': _clean_couples(data.get('couples', [])),
        'rates': _clean_rates(data.get('rates', {})),
        'settlements': _clean_settlements(data.get('settlements', [])),
    }
