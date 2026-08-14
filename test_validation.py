"""Unit test cho validation.validate_event_payload — thuần logic, không cần DB.

Chạy: python3 test_validation.py
"""

from validation import (
    ValidationError, validate_event_payload,
    MAX_TITLE_LEN, MAX_NAME_LEN, MAX_MEMBERS, MAX_EXPENSES, MAX_AMOUNT,
    MAX_BANK_CODE_LEN, MAX_BANK_ACCOUNT_LEN, DEFAULT_TITLE,
)


def expect_error(payload, chua=None):
    """Payload phải bị từ chối; message (an toàn cho client) phải chứa `chua`."""
    try:
        validate_event_payload(payload)
    except ValidationError as e:
        if chua:
            assert chua in str(e), f'message "{e}" không chứa "{chua}"'
        return
    raise AssertionError(f'payload lẽ ra phải bị từ chối: {payload!r}')


def test_happy_path():
    doc = validate_event_payload({
        'title': '  Đi Đà Lạt  ',
        'members': ['An', ' Bình '],
        'expenses': [{
            'title': 'Ăn tối', 'amount': 500000, 'payer': 'An',
            'benefitType': 'selected', 'beneficiaries': ['An', 'Bình'],
            'expense_date': '2026-08-13', 'created_time': 't1', 'updated_time': 't2',
        }],
        'bankInfo': {'An': {'bank': 'VCB', 'account': '007'}},
        'couples': [{'id': 'c1', 'label': 'Vợ chồng', 'members': ['An', 'Bình'], 'primary': 'An'}],
        'rates': {'USD': {'rate': 25000, 'source': 'vcb', 'rateDate': '2026-08-13',
                          'rateType': 'mid', 'currencyName': 'US Dollar'}},
    })
    assert doc['title'] == 'Đi Đà Lạt', 'title phải được strip'
    assert doc['members'] == ['An', 'Bình'], 'tên thành viên phải được strip'
    exp = doc['expenses'][0]
    assert exp['currency'] == 'VND', 'currency mặc định VND'
    assert exp['benefitType'] == 'selected'
    assert doc['bankInfo']['An'] == {'bank': 'VCB', 'account': '007'}
    assert doc['rates']['USD']['rate'] == 25000
    print('✅ happy path: chuẩn hoá đúng')


def test_shape_khop_document_store():
    """Shape output phải khớp document compose từ DB (update_event so sánh
    old_doc == data để nhận no-op — lệch key là no-op detection chết)."""
    doc = validate_event_payload({'members': [], 'expenses': []})
    assert set(doc.keys()) == {'title', 'members', 'expenses', 'bankInfo', 'couples',
                               'rates', 'settlements'}
    doc2 = validate_event_payload({
        'expenses': [{'title': 'x', 'amount': 1, 'beneficiaries': []}], 'members': []})
    assert set(doc2['expenses'][0].keys()) == {
        'title', 'amount', 'currency', 'payer', 'benefitType', 'beneficiaries',
        'expense_date', 'created_time', 'updated_time'}
    print('✅ shape khớp event_store (no-op detection dựa vào đây)')


def test_title():
    assert validate_event_payload({'members': [], 'expenses': []})['title'] == DEFAULT_TITLE
    assert validate_event_payload({'title': '   ', 'members': [], 'expenses': []})['title'] == DEFAULT_TITLE
    expect_error({'title': 'a' * (MAX_TITLE_LEN + 1), 'members': [], 'expenses': []}, 'quá dài')
    expect_error({'title': 123, 'members': [], 'expenses': []}, 'chuỗi')
    print('✅ title: mặc định / quá dài / sai kiểu')


def test_khong_phai_object():
    for bad in (None, [], 'x', 42):
        expect_error(bad, 'JSON object')
    print('✅ payload không phải object bị chặn')


def test_members():
    expect_error({'members': 'x', 'expenses': []}, 'thành viên')
    expect_error({'members': ['ok', ''], 'expenses': []}, 'trống')
    expect_error({'members': ['ok', '   '], 'expenses': []}, 'trống')
    expect_error({'members': [123], 'expenses': []}, 'chuỗi')
    expect_error({'members': ['a' * (MAX_NAME_LEN + 1)], 'expenses': []}, 'quá dài')
    expect_error({'members': ['m'] * (MAX_MEMBERS + 1), 'expenses': []}, f'{MAX_MEMBERS}')
    print('✅ members: kiểu / rỗng / quá dài / quá nhiều')


def test_expenses():
    expect_error({'members': [], 'expenses': 'x'}, 'chi phí')
    expect_error({'members': [], 'expenses': [None]}, 'Chi phí')
    expect_error({'members': [], 'expenses': [{}] * (MAX_EXPENSES + 1)}, f'{MAX_EXPENSES}')
    # amount phải là số hữu hạn, không âm, không phải bool
    for bad_amount in ('1000', True, float('nan'), float('inf'), -1, MAX_AMOUNT * 10):
        expect_error({'members': [], 'expenses': [{'amount': bad_amount}]}, 'Số tiền')
    # benefitType lạ được ép về 'all' (không phải lỗi)
    doc = validate_event_payload({'members': [], 'expenses': [{'amount': 1, 'benefitType': 'hax'}]})
    assert doc['expenses'][0]['benefitType'] == 'all'
    expect_error({'members': [], 'expenses': [{'amount': 1, 'beneficiaries': 'x'}]}, 'người hưởng')
    expect_error({'members': [], 'expenses': [{'amount': 1, 'beneficiaries': ['']}]}, 'trống')
    print('✅ expenses: amount / benefitType / beneficiaries')


def test_bank_info():
    expect_error({'members': [], 'expenses': [], 'bankInfo': []}, 'ngân hàng')
    expect_error({'members': [], 'expenses': [], 'bankInfo': {'An': 'x'}}, 'ngân hàng')
    expect_error({'members': [], 'expenses': [],
                  'bankInfo': {'An': {'bank': 'B' * (MAX_BANK_CODE_LEN + 1)}}}, 'quá dài')
    expect_error({'members': [], 'expenses': [],
                  'bankInfo': {'An': {'account': '1' * (MAX_BANK_ACCOUNT_LEN + 1)}}}, 'quá dài')
    assert validate_event_payload({'members': [], 'expenses': [], 'bankInfo': None})['bankInfo'] == {}
    print('✅ bankInfo: kiểu / độ dài / None')


def test_couples_va_rates():
    expect_error({'members': [], 'expenses': [], 'couples': 'x'}, 'chung quỹ')
    expect_error({'members': [], 'expenses': [], 'couples': [{'members': 'x'}]}, 'chung quỹ')
    expect_error({'members': [], 'expenses': [], 'rates': []}, 'tỷ giá')
    expect_error({'members': [], 'expenses': [], 'rates': {'USD': {'rate': -5}}}, 'Tỷ giá')
    expect_error({'members': [], 'expenses': [], 'rates': {'': {'rate': 1}}}, 'trống')
    doc = validate_event_payload({'members': [], 'expenses': [],
                                  'rates': {'USD': {'rate': None, 'rateDate': ''}}})
    assert doc['rates']['USD']['rate'] is None, 'rate None (thiếu tỷ giá) phải được giữ'
    assert doc['rates']['USD']['rateDate'] is None, "rateDate rỗng chuẩn hoá về None"
    print('✅ couples + rates')


def test_settlements():
    from validation import MAX_SETTLEMENTS
    doc = validate_event_payload({'members': [], 'expenses': [], 'settlements': [
        {'from': ' An ', 'to': 'Bình', 'amount': 500000, 'settled_time': '2026-08-14T10:00:00Z'},
    ]})
    assert doc['settlements'] == [{'from': 'An', 'to': 'Bình', 'amount': 500000,
                                   'settled_time': '2026-08-14T10:00:00Z'}]
    # Event cũ không có key → mặc định []
    assert validate_event_payload({'members': [], 'expenses': []})['settlements'] == []
    assert validate_event_payload({'members': [], 'expenses': [],
                                   'settlements': None})['settlements'] == []
    expect_error({'members': [], 'expenses': [], 'settlements': 'x'}, 'đã chuyển')
    expect_error({'members': [], 'expenses': [], 'settlements': [None]}, 'đã chuyển')
    expect_error({'members': [], 'expenses': [],
                  'settlements': [{'from': '', 'to': 'B', 'amount': 1}]}, 'trống')
    expect_error({'members': [], 'expenses': [],
                  'settlements': [{'from': 'A', 'to': 'B', 'amount': '1'}]}, 'Số tiền')
    expect_error({'members': [], 'expenses': [],
                  'settlements': [{'from': 'A', 'to': 'B', 'amount': 1}] * (MAX_SETTLEMENTS + 1)},
                 'đã chuyển')
    print('✅ settlements: chuẩn hoá / mặc định / kiểu / cap')


if __name__ == '__main__':
    test_happy_path()
    test_shape_khop_document_store()
    test_title()
    test_khong_phai_object()
    test_members()
    test_expenses()
    test_bank_info()
    test_couples_va_rates()
    test_settlements()
    print('\n🎉 test_validation: tất cả pass')
