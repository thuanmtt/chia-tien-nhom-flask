#!/usr/bin/env python3
"""Dọn dữ liệu một lần: chuyển mọi khoản chi benefit_type != 'selected' ('all' cũ)
thành 'selected' với danh sách người hưởng đích danh.

- Khoản đã có snapshot trong expense_beneficiaries: giữ nguyên snapshot, chỉ đổi type.
- Khoản chưa có snapshot: chèn theo danh sách thành viên HIỆN TẠI của event.
- KHÔNG bump events.updated_at (tránh 409 cho tab đang mở), KHÔNG ghi event_revisions
  (dọn dữ liệu, không phải hành động người dùng). Idempotent — chạy lại vô hại.

Chạy SAU khi deploy client mới (thứ tự bắt buộc — xem spec
docs/superpowers/specs/2026-08-13-per-member-beneficiaries-design.md):
    python3 migrate_beneficiaries.py --dry-run   # xem trước, rollback
    python3 migrate_beneficiaries.py             # chạy thật
"""
import os
import sys

import psycopg2
from dotenv import load_dotenv


def main():
    load_dotenv()
    dry_run = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        cur = conn.cursor()

        # Khoản 'all' CHƯA có snapshot → chèn theo danh sách thành viên hiện tại
        cur.execute(
            '''INSERT INTO expense_beneficiaries (expense_id, member_name, position)
               SELECT e.id, m.name, m.position
               FROM expenses e
               JOIN members m ON m.event_id = e.event_id
               WHERE e.benefit_type <> 'selected'
                 AND NOT EXISTS (
                     SELECT 1 FROM expense_beneficiaries b WHERE b.expense_id = e.id
                 )'''
        )
        inserted = cur.rowcount

        cur.execute("UPDATE expenses SET benefit_type = 'selected' WHERE benefit_type <> 'selected'")
        updated = cur.rowcount

        print(f'Chèn {inserted} dòng người hưởng; chuyển {updated} khoản chi sang selected.')
        if dry_run:
            conn.rollback()
            print('Dry-run: đã rollback, DB không đổi.')
        else:
            conn.commit()
            print('Đã commit.')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
