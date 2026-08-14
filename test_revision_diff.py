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


def test_max_actions_param():
    # Preview phiên bản dùng cap cao hơn — max_actions phải tôn trọng tham số
    old = {'title': 'X', 'members': [], 'expenses': [], 'bankInfo': {},
           'couples': [], 'rates': {}}
    new = dict(old, members=[f'TV{i}' for i in range(15)])
    actions = diff_documents(old, new, max_actions=50)
    assert len(actions) == 15 and all(a['a'] == 'add' for a in actions)
    print('✅ max_actions tùy chỉnh (preview) không bị cap 10')


def test_settlements_diff():
    old = copy.deepcopy(BASE)
    old['settlements'] = [{'from': 'Bình', 'to': 'An', 'amount': 750000, 'settled_time': 't1'}]
    new = copy.deepcopy(BASE)
    new['settlements'] = [{'from': 'Bình', 'to': 'Chi', 'amount': 200000, 'settled_time': 't2'}]
    texts = _texts(diff_documents(old, new))
    assert "Đánh dấu đã chuyển: 'Bình' → 'Chi' (200.000 đ)" in texts
    assert "Bỏ đánh dấu đã chuyển: 'Bình' → 'An' (750.000 đ)" in texts
    assert len(texts) == 2
    # settled_time đổi nhưng cùng (from, to, amount) → không phải thay đổi
    same = copy.deepcopy(old)
    same['settlements'] = [dict(old['settlements'][0], settled_time='t9')]
    assert diff_documents(old, same) == []
    print('✅ diff settlements: đánh dấu / bỏ đánh dấu / đổi mỗi settled_time → bỏ qua')


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
    test_max_actions_param()
    test_settlements_diff()
    print('\n🎉 test_revision_diff: tất cả pass')
    sys.exit(0)
