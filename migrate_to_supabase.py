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
