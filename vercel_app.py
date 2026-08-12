from flask import Flask, render_template, request, jsonify, redirect, send_from_directory
from flask_limiter import Limiter
import hmac
import psycopg2
import psycopg2.extras
import os
import json
import re
import secrets
import string
import uuid
from datetime import datetime, timedelta
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from werkzeug.exceptions import HTTPException

from validation import ValidationError, validate_event_payload
from event_store import replace_event_children, load_event_children, load_events_summary
from revision_diff import diff_documents
from revision_store import record_revision, list_revisions, get_revision
from supabase_auth import request_user_id, request_user_claims

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Nạp biến môi trường từ .env cho local dev (trên Vercel dùng env của project,
# không có file .env nên đây là no-op). Phải chạy TRƯỚC khi tạo limiter vì
# limiter đọc RATELIMIT_STORAGE_URI ngay lúc khởi tạo. Không ghi đè biến đã
# được export sẵn trong môi trường.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(BASE_DIR, '.env'))
except ImportError:
    pass

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
)
# Chặn payload quá lớn (event bình thường chỉ vài chục KB)
app.config['MAX_CONTENT_LENGTH'] = 512 * 1024


def _client_ip():
    fwd = request.headers.get('x-forwarded-for', '')
    if fwd:
        return fwd.split(',')[0].strip()
    return request.remote_addr or '127.0.0.1'


limiter = Limiter(
    key_func=_client_ip,
    app=app,
    default_limits=['200 per minute', '2000 per day'],
    # Trên Vercel serverless, memory:// gần như vô hiệu (mỗi instance một bộ nhớ).
    # Đặt RATELIMIT_STORAGE_URI=redis://... (ví dụ Upstash) để limit có tác dụng thật.
    storage_uri=os.environ.get('RATELIMIT_STORAGE_URI', 'memory://'),
    headers_enabled=True,
)


@app.errorhandler(429)
def _ratelimit_handler(e):
    return jsonify({
        'success': False,
        'error': 'Quá nhiều yêu cầu, vui lòng thử lại sau.',
        'detail': str(e.description),
    }), 429


@app.errorhandler(413)
def _too_large_handler(e):
    return jsonify({'success': False, 'error': 'Dữ liệu gửi lên quá lớn.'}), 413


def _server_error(exc):
    """Log chi tiết ở server, trả lỗi chung chung cho client."""
    app.logger.exception(exc)
    return jsonify({'success': False, 'error': 'Đã xảy ra lỗi máy chủ.'}), 500


def _provided_edit_key():
    return request.headers.get('X-Edit-Key', '').strip()


def _check_edit_permission(cursor, event_code, allow_link_editor=True, adopt_key=True):
    """Kiểm tra quyền sửa/xóa event.

    Trả về (status, event_id, updated_at) với status: 'not_found' | 'forbidden' | 'ok'.
    Quyền hợp lệ khi: là owner (JWT Supabase) HOẶC event chia sẻ ở chế độ
    "ai có link đều chỉnh sửa" (share_access='link' + share_role='editor',
    trừ DELETE — allow_link_editor=False) HOẶC X-Edit-Key khớp.
    Event cũ chưa có edit_key: chấp nhận request và "nhận" key client gửi lên
    (nếu có) làm key chính thức, để dữ liệu cũ không bị khóa ngoài ý muốn.
    adopt_key=False: dùng cho route chỉ-đọc (GET) — vẫn cho qua ('ok') nếu
    event chưa có edit_key, nhưng KHÔNG ghi key vào DB (tránh GET có side-effect
    chiếm quyền chỉnh sửa của event legacy chỉ vì client tự sinh key để gửi lên).
    """
    cursor.execute(
        '''SELECT id, edit_key, owner_id, updated_at, share_access, share_role
           FROM events WHERE event_code = %s''',
        (event_code,),
    )
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, stored, owner_id, updated_at, share_access, share_role = row

    # Owner đăng nhập có toàn quyền — kể cả khi client gửi kèm key sai/tự sinh
    user_id = request_user_id(request)
    if owner_id and user_id and str(owner_id) == user_id:
        return 'ok', event_id, updated_at

    # Chia sẻ kiểu Google Docs: "Bất kỳ ai có đường liên kết — Người chỉnh sửa"
    # → không cần key (nhưng không được xóa event; xem caller DELETE)
    if allow_link_editor and share_access == 'link' and share_role == 'editor':
        return 'ok', event_id, updated_at

    provided = _provided_edit_key()
    if stored:
        if not provided or not hmac.compare_digest(stored, provided):
            return 'forbidden', event_id, updated_at
        return 'ok', event_id, updated_at
    if provided and adopt_key:
        cursor.execute('UPDATE events SET edit_key = %s WHERE id = %s', (provided, event_id))
    return 'ok', event_id, updated_at


def _actor_info(cursor, claims):
    """(user_id, tên hiển thị) của người thực hiện — cho lịch sử chỉnh sửa.
    Ưu tiên username (user_profiles), không có thì email từ JWT. Denormalize
    vào từng revision để đọc lịch sử không phải join auth.users."""
    user_id = claims.get('sub')
    cursor.execute('SELECT username FROM user_profiles WHERE user_id = %s::uuid', (user_id,))
    row = cursor.fetchone()
    name = (row[0] if row and row[0] else None) or claims.get('email') or ''
    return user_id, name


def _load_full_document(conn, cursor, event_id):
    """Document đầy đủ (title + children) của event — cho diff/snapshot lịch sử.
    Mở RealDictCursor riêng vì load_event_children yêu cầu dict cursor; cùng
    connection nên vẫn nằm trong transaction đang mở của caller."""
    cursor.execute('SELECT title FROM events WHERE id = %s', (event_id,))
    title = cursor.fetchone()[0]
    dict_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        doc = load_event_children(dict_cur, event_id)
    finally:
        dict_cur.close()
    return dict(doc, title=title)


# Nhãn tiếng Việt cho revision 'share' (khớp các giá trị validate ở update_sharing)
_SHARE_LABEL = {
    ('restricted', 'viewer'): 'Hạn chế',
    ('restricted', 'editor'): 'Hạn chế',
    ('link', 'viewer'): 'Bất kỳ ai có liên kết — người xem',
    ('link', 'editor'): 'Bất kỳ ai có liên kết — người chỉnh sửa',
}


def _database_url():
    url = (
        os.environ.get('DATABASE_URL')
        or os.environ.get('POSTGRES_URL')
        or os.environ.get('POSTGRES_PRISMA_URL')
    )
    if not url:
        raise RuntimeError('DATABASE_URL (or POSTGRES_URL) is not set')
    return url


_conn = None


def get_db_connection():
    global _conn
    if _conn is not None and not _conn.closed:
        try:
            with _conn.cursor() as c:
                c.execute('SELECT 1')
            return _conn
        except psycopg2.Error:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = psycopg2.connect(_database_url(), connect_timeout=5)
    _conn.autocommit = True
    return _conn


def generate_event_code():
    now = datetime.now()
    date_part = now.strftime('%y%m%d')
    random_part = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    return f"{date_part}{random_part}"


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/sw.js')
def service_worker():
    response = send_from_directory(app.static_folder, 'sw.js', mimetype='application/javascript')
    response.headers['Service-Worker-Allowed'] = '/'
    response.headers['Cache-Control'] = 'no-cache'
    return response


@app.route('/manifest.json')
def manifest():
    return send_from_directory(app.static_folder, 'manifest.json', mimetype='application/manifest+json')


@app.route('/api/events', methods=['POST'])
@limiter.limit('10 per minute; 100 per day')
def create_event():
    try:
        # Tạo sự kiện yêu cầu đăng nhập (401 ≠ 403: chưa đăng nhập vs không có quyền)
        claims = request_user_claims(request)
        user_id = (claims or {}).get('sub')
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để tạo sự kiện.'}), 401

        try:
            data = validate_event_payload(request.get_json(silent=True))
        except ValidationError as e:
            return jsonify({'success': False, 'error': str(e)}), 400

        event_code = generate_event_code()
        # Khóa chỉnh sửa — chỉ trả về 1 lần khi tạo
        edit_key = secrets.token_urlsafe(24)

        conn = get_db_connection()
        cursor = conn.cursor()
        # Ghi nhiều bảng phải nằm trong 1 transaction (connection đang autocommit
        # nên mở transaction thủ công bằng BEGIN/COMMIT)
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                '''INSERT INTO events (event_code, title, edit_key, owner_id)
                   VALUES (%s, %s, %s, %s) RETURNING id, updated_at''',
                (event_code, data['title'], edit_key, user_id),
            )
            event_id, created_updated_at = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'create',
                            [{'a': 'add', 'o': 'event', 't': 'Tạo sự kiện'}], data)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()

        return jsonify({
            'success': True,
            'event_id': str(event_id),
            'event_code': event_code,
            'edit_key': edit_key,
            'updated_at': created_updated_at.isoformat() if created_updated_at else None,
        })
    except HTTPException:
        # Để Flask xử lý (ví dụ 413 khi payload quá lớn)
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/lookup', methods=['POST'])
@limiter.limit('30 per minute; 500 per day')
def lookup_events():
    """Tải nhiều sự kiện trong 1 request cho danh sách "Sự Kiện Của Tôi"
    (thay cho N request GET riêng lẻ). Chỉ trả các trường cần cho danh sách —
    không có bank_info và tuyệt đối không có edit_key."""
    try:
        body = request.get_json(silent=True)
        codes = body.get('codes') if isinstance(body, dict) else None
        if (not isinstance(codes, list) or len(codes) > 50
                or not all(isinstance(c, str) and 0 < len(c) <= 64 for c in codes)):
            return jsonify({'success': False, 'error': 'Danh sách mã sự kiện không hợp lệ.'}), 400
        if not codes:
            return jsonify({'success': True, 'events': []})

        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # Event ở chế độ "Hạn chế" chỉ hiện với chính owner (đăng nhập)
        events = load_events_summary(cursor, codes, viewer_user_id=request_user_id(request))
        cursor.close()
        return jsonify({'success': True, 'events': events})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/my-events')
@limiter.limit('30 per minute; 500 per day')
def my_events():
    """Danh sách event thuộc tài khoản đang đăng nhập — đồng bộ "Sự Kiện Của Tôi"
    giữa các thiết bị. Chỉ trả metadata, không có edit_key (owner sửa bằng JWT)."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT event_code, title, updated_at FROM events
               WHERE owner_id = %s::uuid ORDER BY updated_at DESC''',
            (user_id,),
        )
        rows = cursor.fetchall()
        cursor.close()
        return jsonify({'success': True, 'events': [
            {
                'event_code': r['event_code'],
                'title': r['title'],
                'updated_at': r['updated_at'].isoformat() if r['updated_at'] else None,
            } for r in rows
        ]})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


# Username: 3-30 ký tự a-z 0-9 . _ - ; bắt đầu/kết thúc bằng chữ hoặc số
_USERNAME_RE = re.compile(r'^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])?$')
_USERNAME_ERROR = ('Username 3-30 ký tự, chỉ gồm a-z, 0-9, dấu chấm, gạch dưới, '
                   'gạch ngang; bắt đầu và kết thúc bằng chữ hoặc số.')


@app.route('/api/profile', methods=['GET'])
@limiter.limit('60 per minute')
def get_profile():
    """Hồ sơ của tài khoản đang đăng nhập (hiện chỉ có username)."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT username FROM user_profiles WHERE user_id = %s::uuid', (user_id,))
        row = cursor.fetchone()
        cursor.close()
        return jsonify({'success': True, 'username': row[0] if row else None})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/profile', methods=['PUT'])
@limiter.limit('10 per minute; 100 per day')
def update_profile():
    """Đặt/đổi/xóa username. Username duy nhất toàn hệ thống, lưu lowercase."""
    try:
        user_id = request_user_id(request)
        if not user_id:
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập.'}), 401
        body = request.get_json(silent=True)
        raw = (body or {}).get('username')
        if raw is None:
            raw = ''
        if not isinstance(raw, str) or len(raw) > 100:
            return jsonify({'success': False, 'error': _USERNAME_ERROR}), 400
        username = raw.strip().lower()

        conn = get_db_connection()
        cursor = conn.cursor()
        if not username:
            # Để trống = xóa username
            cursor.execute('DELETE FROM user_profiles WHERE user_id = %s::uuid', (user_id,))
            cursor.close()
            return jsonify({'success': True, 'username': None})
        if '@' in username or not _USERNAME_RE.match(username):
            cursor.close()
            return jsonify({'success': False, 'error': _USERNAME_ERROR}), 400
        try:
            cursor.execute(
                '''INSERT INTO user_profiles (user_id, username, updated_at)
                   VALUES (%s::uuid, %s, now())
                   ON CONFLICT (user_id) DO UPDATE
                   SET username = EXCLUDED.username, updated_at = now()''',
                (user_id, username),
            )
        except psycopg2.errors.UniqueViolation:
            cursor.close()
            return jsonify({'success': False, 'error': 'Username này đã có người dùng, vui lòng chọn tên khác.'}), 409
        cursor.close()
        return jsonify({'success': True, 'username': username})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


def _gotrue_password_grant(email, password):
    """Đổi email + mật khẩu lấy session qua GoTrue (server-side, dùng anon key).
    Trả về (status_code, dict)."""
    url = f"{os.environ.get('SUPABASE_URL', '').rstrip('/')}/auth/v1/token?grant_type=password"
    req = Request(
        url, method='POST',
        data=json.dumps({'email': email, 'password': password}).encode(),
        headers={'Content-Type': 'application/json',
                 'apikey': os.environ.get('SUPABASE_ANON_KEY', '')},
    )
    try:
        with urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


@app.route('/api/auth/login', methods=['POST'])
@limiter.limit('10 per minute; 100 per day')
def login_alias():
    """Đăng nhập bằng username HOẶC email + mật khẩu.

    Backend tra email từ username (bảng user_profiles JOIN auth.users) rồi đổi
    lấy session — mọi thất bại đều trả cùng một message để không lộ username
    nào tồn tại / email của người khác."""
    try:
        body = request.get_json(silent=True)
        identifier = (body or {}).get('identifier')
        password = (body or {}).get('password')
        if (not isinstance(identifier, str) or not isinstance(password, str)
                or not identifier.strip() or not password
                or len(identifier) > 254 or len(password) > 200):
            return jsonify({'success': False, 'error': 'Vui lòng nhập tên đăng nhập và mật khẩu.'}), 400
        identifier = identifier.strip()

        email = identifier
        if '@' not in identifier:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                '''SELECT u.email FROM user_profiles p
                   JOIN auth.users u ON u.id = p.user_id
                   WHERE p.username = %s''',
                (identifier.lower(),),
            )
            row = cursor.fetchone()
            cursor.close()
            if not row or not row[0]:
                return jsonify({'success': False, 'error': 'Sai tên đăng nhập hoặc mật khẩu.'}), 401
            email = row[0]

        status, data = _gotrue_password_grant(email, password)
        if status != 200 or not data.get('access_token'):
            return jsonify({'success': False, 'error': 'Sai tên đăng nhập hoặc mật khẩu.'}), 401
        return jsonify({'success': True, 'session': data})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/<event_code>', methods=['GET'])
@limiter.limit('120 per minute')
def get_event(event_code):
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT id, event_code, title, edit_key, owner_id, share_access, share_role,
                      created_at, updated_at
               FROM events WHERE event_code = %s''',
            (event_code,),
        )
        event = cursor.fetchone()
        if not event:
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404

        stored_key = event['edit_key']
        provided = _provided_edit_key()
        user_id = request_user_id(request)
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        key_ok = bool(stored_key and provided and hmac.compare_digest(stored_key, provided))

        # Chế độ "Hạn chế": chỉ owner hoặc người cầm edit_key xem được
        if event['share_access'] == 'restricted' and not (is_owner or key_ok):
            cursor.close()
            return jsonify({
                'success': False,
                'error': 'Sự kiện đang ở chế độ hạn chế — chỉ chủ sở hữu mới truy cập được.',
            }), 403

        doc = load_event_children(cursor, event['id'])
        cursor.close()

        # Quyền sửa: owner / key đúng / sự kiện chưa có khóa (legacy) /
        # chia sẻ "ai có link đều chỉnh sửa". Nhưng mọi thao tác ghi giờ yêu cầu
        # đăng nhập → can_edit ("PUT của bạn sẽ thành công") chỉ true khi CÓ
        # QUYỀN và ĐÃ đăng nhập; có quyền mà chưa đăng nhập → cờ riêng để UI
        # hiện "Đăng nhập để chỉnh sửa".
        link_editor = event['share_access'] == 'link' and event['share_role'] == 'editor'
        has_permission = is_owner or key_ok or (not stored_key) or link_editor
        can_edit = has_permission and bool(user_id)
        login_required_to_edit = has_permission and not user_id
        return jsonify({
            'success': True,
            'event': {
                'id': str(event['id']),
                'event_code': event['event_code'],
                'title': event['title'],
                'can_edit': can_edit,
                'login_required_to_edit': login_required_to_edit,
                'share_access': event['share_access'],
                'share_role': event['share_role'],
                'members': doc['members'],
                'expenses': doc['expenses'],
                'bankInfo': doc['bankInfo'],
                'couples': doc['couples'],
                'rates': doc['rates'],
                # Lưu ý: tuyệt đối không trả edit_key — link chỉ-xem cũng gọi API này.
                'created_at': event['created_at'].isoformat() if event['created_at'] else None,
                'updated_at': event['updated_at'].isoformat() if event['updated_at'] else None,
            },
        })
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/<event_code>', methods=['PUT'])
@limiter.limit('60 per minute; 1000 per day')
def update_event(event_code):
    try:
        # Mọi thao tác ghi yêu cầu đăng nhập — để hành động gắn được danh tính
        # vào lịch sử. Quyền sửa (owner/edit_key/link-editor) kiểm tra sau, như cũ.
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401

        raw = request.get_json(silent=True)
        try:
            data = validate_event_payload(raw)
        except ValidationError as e:
            return jsonify({'success': False, 'error': str(e)}), 400
        # Optimistic locking: client gửi updated_at nó biết; nếu server đã có
        # bản mới hơn (người khác vừa lưu) thì từ chối để không ghi đè âm thầm.
        expected_updated_at = raw.get('expectedUpdatedAt') if isinstance(raw, dict) else None

        conn = get_db_connection()
        cursor = conn.cursor()

        permission, event_id, current_updated_at = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền chỉnh sửa sự kiện này.'}), 403

        if (expected_updated_at and current_updated_at
                and current_updated_at.isoformat() != expected_updated_at):
            cursor.close()
            return jsonify({
                'success': False,
                'conflict': True,
                'error': 'Sự kiện đã được cập nhật ở nơi khác.',
            }), 409

        try:
            cursor.execute('BEGIN')
            # Bản cũ phải đọc TRONG transaction, trước khi ghi đè — để diff cho lịch sử
            old_doc = _load_full_document(conn, cursor, event_id)
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            summary = diff_documents(old_doc, data)
            if summary:  # lưu không đổi gì (no-op) → không ghi dòng lịch sử
                actor_id, actor_name = _actor_info(cursor, claims)
                record_revision(cursor, event_id, actor_id, actor_name, 'edit', summary, data)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        new_updated_at = new_row[0].isoformat() if new_row and new_row[0] else None
        return jsonify({'success': True, 'updated_at': new_updated_at})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


CURRENCY_NAME_VI = {
    'USD': 'US Dollar', 'EUR': 'Euro', 'JPY': 'Japanese Yen', 'GBP': 'UK Pound',
    'KRW': 'Korean Won', 'THB': 'Thai Baht', 'SGD': 'Singapore Dollar',
    'CNY': 'Chinese Yuan', 'AUD': 'Australian Dollar', 'CAD': 'Canadian Dollar',
    'HKD': 'Hong Kong Dollar', 'TWD': 'Taiwan Dollar', 'MYR': 'Malaysian Ringgit',
    'CHF': 'Swiss Franc', 'NZD': 'New Zealand Dollar', 'RUB': 'Russian Ruble',
    'INR': 'Indian Rupee', 'IDR': 'Indonesian Rupiah', 'PHP': 'Philippine Peso',
    'LAK': 'Lao Kip', 'KHR': 'Cambodian Riel', 'MOP': 'Macanese Pataca',
}


def _http_get_json(url, timeout=10):
    req = Request(url, headers={'accept': 'application/json', 'user-agent': 'Mozilla/5.0'})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _fetch_vietcombank_rates(date_str):
    url = f'https://vietcombank.com.vn/api/exchangerates?date={date_str}'
    req = Request(url, headers={
        'accept': '*/*',
        'referer': 'https://vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia',
        'user-agent': 'Mozilla/5.0',
    })
    with urlopen(req, timeout=10) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    rates = {}
    for item in payload.get('Data', []) or []:
        code = item.get('currencyCode')
        if not code:
            continue
        rates[code] = {
            'currencyName': item.get('currencyName', ''),
            'cash': float(item.get('cash') or 0) or None,
            'transfer': float(item.get('transfer') or 0) or None,
            'sell': float(item.get('sell') or 0) or None,
        }
    return {
        'date': (payload.get('Date') or date_str)[:10],
        'updatedDate': payload.get('UpdatedDate'),
        'rates': rates,
    }


def _vcb_with_rate(vcb_data, rate_type):
    out = {}
    for code, v in (vcb_data.get('rates') or {}).items():
        transfer = v.get('transfer')
        sell = v.get('sell')
        cash = v.get('cash')
        if rate_type == 'mid':
            rate = (transfer + sell) / 2.0 if (transfer and sell) else (transfer or sell or cash)
        elif rate_type == 'cash':
            rate = cash
        elif rate_type == 'sell':
            rate = sell
        else:
            rate = transfer
        if not rate:
            continue
        out[code] = {
            'currencyName': v.get('currencyName', ''),
            'rate': rate,
            'cash': cash,
            'transfer': transfer,
            'sell': sell,
        }
    return {'date': vcb_data.get('date'), 'rates': out}


def _fetch_fawaz_rates(date_str):
    tag = date_str if date_str and date_str != datetime.now().strftime('%Y-%m-%d') else 'latest'
    url = f'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{tag}/v1/currencies/usd.json'
    payload = _http_get_json(url)
    usd = payload.get('usd') or {}
    vnd_per_usd = usd.get('vnd')
    if not vnd_per_usd:
        raise ValueError('Fawazahmed0: thiếu tỷ giá VND')
    rates = {}
    for code_lower, usd_to_code in usd.items():
        code = code_lower.upper()
        if code == 'VND' or not usd_to_code:
            continue
        rates[code] = {
            'currencyName': CURRENCY_NAME_VI.get(code, ''),
            'rate': vnd_per_usd / usd_to_code,
        }
    return {'date': payload.get('date') or date_str, 'rates': rates}


def _fetch_erapi_rates(_date_str):
    payload = _http_get_json('https://open.er-api.com/v6/latest/USD')
    if payload.get('result') != 'success':
        raise ValueError('exchangerate-api: response không hợp lệ')
    r = payload.get('rates') or {}
    vnd_per_usd = r.get('VND')
    if not vnd_per_usd:
        raise ValueError('exchangerate-api: thiếu tỷ giá VND')
    rates = {}
    for code, usd_to_code in r.items():
        if code == 'VND' or not usd_to_code:
            continue
        rates[code] = {
            'currencyName': CURRENCY_NAME_VI.get(code, ''),
            'rate': vnd_per_usd / usd_to_code,
        }
    return {
        'date': datetime.utcnow().strftime('%Y-%m-%d'),
        'updatedDate': payload.get('time_last_update_utc') or '',
        'rates': rates,
    }


@app.route('/api/exchange-rates')
@limiter.limit('30 per minute; 500 per day')
def get_exchange_rates():
    date_str = request.args.get('date') or datetime.now().strftime('%Y-%m-%d')
    rate_type = (request.args.get('type') or 'mid').lower()

    if rate_type == 'mid':
        errors = []
        for fetch, name in (
            (_fetch_fawaz_rates, 'fawazahmed0'),
            (_fetch_erapi_rates, 'exchangerate-api'),
        ):
            try:
                data = fetch(date_str)
                return jsonify({'success': True, 'source': name, 'rateType': 'mid', **data})
            except Exception as e:
                errors.append(f'{name}: {e}')
        try:
            vcb = _fetch_vietcombank_rates(date_str)
            data = _vcb_with_rate(vcb, 'mid')
            return jsonify({'success': True, 'source': 'vietcombank-mid', 'rateType': 'mid', **data})
        except Exception as e:
            errors.append(f'vietcombank: {e}')
        return jsonify({'success': False, 'error': 'Tất cả nguồn đều lỗi — ' + ' | '.join(errors)}), 502

    if rate_type not in ('transfer', 'cash', 'sell'):
        rate_type = 'transfer'
    try:
        vcb = _fetch_vietcombank_rates(date_str)
        data = _vcb_with_rate(vcb, rate_type)
        return jsonify({'success': True, 'source': 'vietcombank', 'rateType': rate_type, **data})
    except (HTTPError, URLError) as e:
        return jsonify({'success': False, 'error': f'Không kết nối được Vietcombank: {e}'}), 502
    except Exception as e:
        return _server_error(e)


@app.route('/api/banks')
@limiter.exempt
def get_banks():
    try:
        banks_path = os.path.join(BASE_DIR, 'static', 'banks.json')
        with open(banks_path, 'r', encoding='utf-8') as f:
            banks_data = json.load(f)
        return jsonify(banks_data)
    except Exception as e:
        return _server_error(e)


@app.route('/api/config')
@limiter.exempt
def get_config():
    """Cấu hình public cho frontend (anon key của Supabase vốn là public;
    index.html không dùng Jinja nên client lấy qua API này)."""
    return jsonify({
        'supabaseUrl': os.environ.get('SUPABASE_URL', ''),
        'supabaseAnonKey': os.environ.get('SUPABASE_ANON_KEY', ''),
    })


@app.route('/api/events/<event_code>/sharing', methods=['PUT'])
@limiter.limit('30 per minute; 300 per day')
def update_sharing(event_code):
    """Đổi quyền truy cập chung kiểu Google Docs.

    Body: {access: 'restricted'|'link', role: 'viewer'|'editor'}.
    Ai có quyền chỉnh sửa (owner / edit_key / link-editor) đều đổi được —
    giống mặc định "người chỉnh sửa có thể chia sẻ" của Google Docs.
    Không bump updated_at: đổi chia sẻ không phải sửa nội dung, tránh 409
    vô cớ cho người đang lưu document."""
    try:
        # Mọi thao tác ghi yêu cầu đăng nhập — để hành động gắn được danh tính
        # vào lịch sử. Quyền sửa (owner/edit_key/link-editor) kiểm tra sau, như cũ.
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401

        body = request.get_json(silent=True) or {}
        access = body.get('access')
        role = body.get('role')
        if access not in ('restricted', 'link') or role not in ('viewer', 'editor'):
            return jsonify({'success': False, 'error': 'Cài đặt chia sẻ không hợp lệ.'}), 400

        conn = get_db_connection()
        cursor = conn.cursor()
        permission, event_id, _unused = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền thay đổi chia sẻ của sự kiện này.'}), 403

        try:
            cursor.execute('BEGIN')
            cursor.execute(
                'UPDATE events SET share_access = %s, share_role = %s WHERE id = %s',
                (access, role, event_id),
            )
            # Đổi chia sẻ cũng là hành động cần trace — snapshot là document
            # hiện tại (nội dung không đổi, restore về dòng này vẫn đúng nghĩa)
            snapshot = _load_full_document(conn, cursor, event_id)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'share',
                            [{'a': 'update', 'o': 'sharing',
                              't': f'Đổi quyền truy cập: {_SHARE_LABEL[(access, role)]}'}],
                            snapshot)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        return jsonify({'success': True, 'share_access': access, 'share_role': role})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/<event_code>/revisions')
@limiter.limit('60 per minute')
def list_event_revisions(event_code):
    """Lịch sử chỉnh sửa — chỉ người có quyền sửa (và đã đăng nhập) xem được.
    Trả tối đa 200 dòng mới nhất trước, KHÔNG kèm snapshot (nặng)."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để xem lịch sử.'}), 401

        conn = get_db_connection()
        cursor = conn.cursor()
        permission, event_id, _unused = _check_edit_permission(cursor, event_code, adopt_key=False)
        cursor.close()
        if permission == 'not_found':
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            return jsonify({'success': False, 'error': 'Bạn không có quyền xem lịch sử sự kiện này.'}), 403

        dict_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        revisions = list_revisions(dict_cur, event_id)
        dict_cur.close()
        return jsonify({'success': True, 'revisions': revisions})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/<event_code>/restore', methods=['POST'])
@limiter.limit('10 per minute; 100 per day')
def restore_event(event_code):
    """Khôi phục event về snapshot của một revision (kiểu lịch sử Google Docs).

    Ghi snapshot cũ đè lên document hiện tại và log thêm dòng 'restore' —
    lịch sử không bao giờ bị xóa lùi, khôi phục nhầm thì khôi phục ngược lại."""
    try:
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401

        body = request.get_json(silent=True) or {}
        revision_id = body.get('revision_id')
        try:
            uuid.UUID(str(revision_id))
        except (ValueError, TypeError):
            return jsonify({'success': False, 'error': 'Không tìm thấy phiên bản.'}), 404
        expected_updated_at = body.get('expectedUpdatedAt')

        conn = get_db_connection()
        cursor = conn.cursor()
        permission, event_id, current_updated_at = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền chỉnh sửa sự kiện này.'}), 403

        # Optimistic locking như PUT — không ghi đè âm thầm bản ai đó vừa lưu
        # trong lúc người này mở lịch sử
        if (expected_updated_at and current_updated_at
                and current_updated_at.isoformat() != expected_updated_at):
            cursor.close()
            return jsonify({
                'success': False,
                'conflict': True,
                'error': 'Sự kiện đã được cập nhật ở nơi khác.',
            }), 409

        snapshot, rev_created_at = get_revision(cursor, event_id, str(revision_id))
        if snapshot is None:
            cursor.close()
            return jsonify({'success': False, 'error': 'Không tìm thấy phiên bản.'}), 404
        try:
            # Snapshot cũ phải qua validation hiện hành — dữ liệu từng hợp lệ
            # có thể không còn (đổi rule) → chặn thay vì ghi bừa
            data = validate_event_payload(snapshot)
        except ValidationError:
            cursor.close()
            return jsonify({'success': False, 'error': 'Phiên bản này không còn khôi phục được.'}), 400

        # Giờ VN (UTC+7, không DST) cho text lịch sử
        vn_time = (rev_created_at + timedelta(hours=7)).strftime('%H:%M %d/%m/%Y')
        try:
            cursor.execute('BEGIN')
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
            actor_id, actor_name = _actor_info(cursor, claims)
            record_revision(cursor, event_id, actor_id, actor_name, 'restore',
                            [{'a': 'update', 'o': 'restore',
                              't': f'Khôi phục về phiên bản lúc {vn_time}'}], data)
            cursor.execute('COMMIT')
        except Exception:
            try:
                cursor.execute('ROLLBACK')
            except Exception:
                # ROLLBACK có thể fail nếu connection đã chết — không che lỗi gốc
                pass
            raise
        finally:
            cursor.close()
        new_updated_at = new_row[0].isoformat() if new_row and new_row[0] else None
        return jsonify({'success': True, 'updated_at': new_updated_at})
    except HTTPException:
        raise
    except Exception as e:
        return _server_error(e)


@app.route('/api/events/<event_code>', methods=['DELETE'])
@limiter.limit('10 per minute; 50 per day')
def delete_event(event_code):
    try:
        # Mọi thao tác ghi yêu cầu đăng nhập — để hành động gắn được danh tính
        # vào lịch sử. Quyền sửa (owner/edit_key/link-editor) kiểm tra sau, như cũ.
        claims = request_user_claims(request)
        if not (claims or {}).get('sub'):
            return jsonify({'success': False, 'error': 'Vui lòng đăng nhập để chỉnh sửa.'}), 401

        conn = get_db_connection()
        cursor = conn.cursor()

        # Xóa event: chỉ owner hoặc người cầm edit_key — vai trò "Người chỉnh
        # sửa" qua link không được xóa (giống Google Docs).
        permission, _event_id, _unused = _check_edit_permission(
            cursor, event_code, allow_link_editor=False)
        if permission == 'not_found':
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            cursor.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền xóa sự kiện này.'}), 403

        cursor.execute('DELETE FROM events WHERE event_code = %s', (event_code,))
        cursor.close()
        return jsonify({'success': True})
    except Exception as e:
        return _server_error(e)


# Hai route cũ chỉ redirect về URL chuẩn /?event_code=X — template không dùng
# Jinja nên render với params là vô nghĩa; quyền sửa/xem do can_edit quyết định.
@app.route('/event/<event_code>')
def view_event(event_code):
    return redirect(f'/?event_code={quote(event_code)}')


@app.route('/share/<event_code>')
def share_event(event_code):
    return redirect(f'/?event_code={quote(event_code)}')


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5002)
