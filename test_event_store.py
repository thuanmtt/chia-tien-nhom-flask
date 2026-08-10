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
