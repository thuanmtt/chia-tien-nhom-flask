from flask import Flask, render_template, request, jsonify, redirect, send_from_directory
from flask_limiter import Limiter
import hmac
import psycopg2
import psycopg2.extras
import os
import json
import secrets
import string
from datetime import datetime
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from werkzeug.exceptions import HTTPException

from validation import ValidationError, validate_event_payload
from event_store import replace_event_children, load_event_children, load_events_summary
from supabase_auth import request_user_id

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


def _check_edit_permission(cursor, event_code):
    """Kiểm tra quyền sửa/xóa event.

    Trả về (status, event_id, updated_at) với status: 'not_found' | 'forbidden' | 'ok'.
    Quyền hợp lệ khi: là owner (JWT Supabase) HOẶC X-Edit-Key khớp.
    Event cũ chưa có edit_key: chấp nhận request và "nhận" key client gửi lên
    (nếu có) làm key chính thức, để dữ liệu cũ không bị khóa ngoài ý muốn.
    """
    cursor.execute(
        'SELECT id, edit_key, owner_id, updated_at FROM events WHERE event_code = %s',
        (event_code,),
    )
    row = cursor.fetchone()
    if row is None:
        return 'not_found', None, None
    event_id, stored, owner_id, updated_at = row[0], row[1], row[2], row[3]

    # Owner đăng nhập có toàn quyền — kể cả khi client gửi kèm key sai/tự sinh
    user_id = request_user_id(request)
    if owner_id and user_id and str(owner_id) == user_id:
        return 'ok', event_id, updated_at

    provided = _provided_edit_key()
    if stored:
        if not provided or not hmac.compare_digest(stored, provided):
            return 'forbidden', event_id, updated_at
        return 'ok', event_id, updated_at
    if provided:
        cursor.execute('UPDATE events SET edit_key = %s WHERE id = %s', (provided, event_id))
    return 'ok', event_id, updated_at


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
        user_id = request_user_id(request)
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
        events = load_events_summary(cursor, codes)
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


@app.route('/api/events/<event_code>', methods=['GET'])
@limiter.limit('120 per minute')
def get_event(event_code):
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''SELECT id, event_code, title, edit_key, owner_id, created_at, updated_at
               FROM events WHERE event_code = %s''',
            (event_code,),
        )
        event = cursor.fetchone()
        if not event:
            cursor.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404

        doc = load_event_children(cursor, event['id'])
        cursor.close()

        # Quyền sửa: sự kiện chưa có khóa (legacy) → ai cũng sửa được;
        # có khóa → chỉ khi header X-Edit-Key khớp. UI dựa vào cờ này.
        stored_key = event['edit_key']
        provided = _provided_edit_key()
        user_id = request_user_id(request)
        is_owner = bool(event['owner_id'] and user_id and str(event['owner_id']) == user_id)
        can_edit = is_owner or (not stored_key) or bool(
            provided and hmac.compare_digest(stored_key, provided))
        return jsonify({
            'success': True,
            'event': {
                'id': str(event['id']),
                'event_code': event['event_code'],
                'title': event['title'],
                'can_edit': can_edit,
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
            cursor.execute(
                'UPDATE events SET title = %s, updated_at = now() WHERE id = %s RETURNING updated_at',
                (data['title'], event_id),
            )
            new_row = cursor.fetchone()
            replace_event_children(cursor, event_id, data)
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


@app.route('/api/events/<event_code>', methods=['DELETE'])
@limiter.limit('10 per minute; 50 per day')
def delete_event(event_code):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        permission, _event_id, _unused = _check_edit_permission(cursor, event_code)
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
