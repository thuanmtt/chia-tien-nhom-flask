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
