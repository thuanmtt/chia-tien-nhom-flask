from flask import Flask, render_template, request, jsonify, redirect, url_for, send_from_directory
from flask_limiter import Limiter
import hmac
import sqlite3
import os
import json
import secrets
import string
from datetime import datetime
import uuid
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from werkzeug.exceptions import HTTPException

from validation import ValidationError, validate_event_payload

app = Flask(__name__)
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
    # memory:// chỉ đúng khi chạy 1 process; production nên trỏ tới Redis
    # (ví dụ RATELIMIT_STORAGE_URI=redis://... của Upstash) để limit có tác dụng thật.
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

    Trả về 'not_found' | 'forbidden' | 'ok'.
    Event cũ chưa có edit_key: chấp nhận request và "nhận" key client gửi lên
    (nếu có) làm key chính thức, để dữ liệu cũ không bị khóa ngoài ý muốn.
    """
    cursor.execute('SELECT edit_key FROM events WHERE event_code = ?', (event_code,))
    row = cursor.fetchone()
    if row is None:
        return 'not_found'
    stored = row['edit_key'] if isinstance(row, sqlite3.Row) else row[0]
    provided = _provided_edit_key()
    if stored:
        if not provided or not hmac.compare_digest(stored, provided):
            return 'forbidden'
        return 'ok'
    if provided:
        cursor.execute('UPDATE events SET edit_key = ? WHERE event_code = ?', (provided, event_code))
    return 'ok'


# Cấu hình database
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, 'events.db')

def init_db():
    """Khởi tạo database và tạo bảng"""
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    # Tạo bảng events
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            event_code TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            members TEXT NOT NULL,
            expenses TEXT NOT NULL,
            bank_info TEXT,
            couples TEXT NOT NULL DEFAULT '[]',
            rates TEXT NOT NULL DEFAULT '{}',
            edit_key TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Thêm các cột mới cho DB cũ (SQLite không hỗ trợ ADD COLUMN IF NOT EXISTS)
    for ddl in (
        "ALTER TABLE events ADD COLUMN couples TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE events ADD COLUMN rates TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE events ADD COLUMN edit_key TEXT",
    ):
        try:
            cursor.execute(ddl)
        except sqlite3.OperationalError:
            pass

    conn.commit()
    conn.close()

def generate_event_code():
    """Tạo event_code theo format YYMMDD + 8 ký tự ngẫu nhiên"""
    now = datetime.now()
    date_part = now.strftime('%y%m%d')
    random_part = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    return f"{date_part}{random_part}"

def get_db_connection():
    """Tạo kết nối database"""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

@app.route('/')
def index():
    """Trang chủ"""
    return render_template('index.html')

@app.route('/sw.js')
def service_worker():
    """Phục vụ service worker với scope toàn site"""
    response = send_from_directory(app.static_folder, 'sw.js', mimetype='application/javascript')
    response.headers['Service-Worker-Allowed'] = '/'
    response.headers['Cache-Control'] = 'no-cache'
    return response

@app.route('/manifest.json')
def manifest():
    """Phục vụ PWA manifest ở root"""
    return send_from_directory(app.static_folder, 'manifest.json', mimetype='application/manifest+json')

@app.route('/api/events', methods=['POST'])
@limiter.limit('10 per minute; 100 per day')
def create_event():
    """Tạo sự kiện mới"""
    try:
        try:
            data = validate_event_payload(request.get_json(silent=True))
        except ValidationError as e:
            return jsonify({'success': False, 'error': str(e)}), 400

        # Tạo event_code
        event_code = generate_event_code()

        # Tạo event_id và khóa chỉnh sửa (chỉ trả về 1 lần khi tạo)
        event_id = str(uuid.uuid4())
        edit_key = secrets.token_urlsafe(24)

        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute('''
            INSERT INTO events (id, event_code, title, members, expenses, bank_info, couples, rates, edit_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            event_id,
            event_code,
            data['title'],
            json.dumps(data['members']),
            json.dumps(data['expenses']),
            json.dumps(data['bankInfo']),
            json.dumps(data['couples']),
            json.dumps(data['rates']),
            edit_key
        ))

        conn.commit()
        conn.close()

        return jsonify({
            'success': True,
            'event_id': event_id,
            'event_code': event_code,
            'edit_key': edit_key
        })

    except HTTPException:
        # Để Flask xử lý (ví dụ 413 khi payload quá lớn)
        raise
    except Exception as e:
        return _server_error(e)

@app.route('/api/events/<event_code>', methods=['GET'])
@limiter.limit('120 per minute')
def get_event(event_code):
    """Lấy thông tin sự kiện theo event_code"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM events WHERE event_code = ?', (event_code,))
        event = cursor.fetchone()
        
        conn.close()
        
        if event:
            keys = event.keys()
            couples_raw = event['couples'] if 'couples' in keys else '[]'
            rates_raw = event['rates'] if 'rates' in keys else '{}'
            return jsonify({
                'success': True,
                'event': {
                    'id': event['id'],
                    'event_code': event['event_code'],
                    'title': event['title'],
                    'members': json.loads(event['members']),
                    'expenses': json.loads(event['expenses']),
                    'bankInfo': json.loads(event['bank_info']),
                    'couples': json.loads(couples_raw) if couples_raw else [],
                    'rates': json.loads(rates_raw) if rates_raw else {},
                    # Lưu ý: tuyệt đối không trả edit_key ở đây — link chỉ-xem
                    # cũng gọi API này.
                    'created_at': event['created_at'],
                    'updated_at': event['updated_at']
                }
            })
        else:
            return jsonify({'success': False, 'error': 'Event not found'}), 404

    except Exception as e:
        return _server_error(e)

@app.route('/api/events/<event_code>', methods=['PUT'])
@limiter.limit('60 per minute; 1000 per day')
def update_event(event_code):
    """Cập nhật sự kiện (yêu cầu X-Edit-Key khớp với khóa của sự kiện)"""
    try:
        try:
            data = validate_event_payload(request.get_json(silent=True))
        except ValidationError as e:
            return jsonify({'success': False, 'error': str(e)}), 400

        conn = get_db_connection()
        cursor = conn.cursor()

        permission = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            conn.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            conn.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền chỉnh sửa sự kiện này.'}), 403

        cursor.execute('''
            UPDATE events
            SET title = ?, members = ?, expenses = ?, bank_info = ?, couples = ?, rates = ?, updated_at = CURRENT_TIMESTAMP
            WHERE event_code = ?
        ''', (
            data['title'],
            json.dumps(data['members']),
            json.dumps(data['expenses']),
            json.dumps(data['bankInfo']),
            json.dumps(data['couples']),
            json.dumps(data['rates']),
            event_code
        ))

        conn.commit()
        conn.close()

        return jsonify({'success': True})

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
    """API tỷ giá Vietcombank — trả về cash/transfer/sell theo từng mã."""
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
    """Gán trường `rate` cho từng currency dựa vào rate_type (mid = (transfer+sell)/2)."""
    out = {}
    for code, v in (vcb_data.get('rates') or {}).items():
        transfer = v.get('transfer')
        sell = v.get('sell')
        cash = v.get('cash')
        if rate_type == 'mid':
            if transfer and sell:
                rate = (transfer + sell) / 2.0
            else:
                rate = transfer or sell or cash
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
    """Fawazahmed0 Currency API — mid-market, hỗ trợ ngày lịch sử."""
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
        rate = vnd_per_usd / usd_to_code
        rates[code] = {
            'currencyName': CURRENCY_NAME_VI.get(code, ''),
            'rate': rate,
        }
    return {'date': payload.get('date') or date_str, 'rates': rates}


def _fetch_erapi_rates(_date_str):
    """open.er-api.com — free, mid-market, chỉ có latest."""
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
        rate = vnd_per_usd / usd_to_code
        rates[code] = {
            'currencyName': CURRENCY_NAME_VI.get(code, ''),
            'rate': rate,
        }
    updated = payload.get('time_last_update_utc') or ''
    date_out = datetime.utcnow().strftime('%Y-%m-%d')
    return {'date': date_out, 'updatedDate': updated, 'rates': rates}


@app.route('/api/exchange-rates')
@limiter.limit('30 per minute; 500 per day')
def get_exchange_rates():
    """Lấy tỷ giá. type=mid dùng fallback chain fawaz→erapi→vcb-mid; còn lại dùng Vietcombank."""
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
    """Lấy danh sách ngân hàng"""
    try:
        banks_path = os.path.join(BASE_DIR, 'static', 'banks.json')
        with open(banks_path, 'r', encoding='utf-8') as f:
            banks_data = json.load(f)
        return jsonify(banks_data)
    except Exception as e:
        return _server_error(e)

@app.route('/api/events/<event_code>', methods=['DELETE'])
@limiter.limit('10 per minute; 50 per day')
def delete_event(event_code):
    """Xóa sự kiện (yêu cầu X-Edit-Key khớp với khóa của sự kiện)"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        permission = _check_edit_permission(cursor, event_code)
        if permission == 'not_found':
            conn.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        if permission == 'forbidden':
            conn.close()
            return jsonify({'success': False, 'error': 'Bạn không có quyền xóa sự kiện này.'}), 403

        cursor.execute('DELETE FROM events WHERE event_code = ?', (event_code,))

        conn.commit()
        conn.close()

        return jsonify({'success': True})

    except Exception as e:
        return _server_error(e)

@app.route('/event/<event_code>')
def view_event(event_code):
    """Trang xem sự kiện với event_code"""
    return render_template('index.html', event_code=event_code)

@app.route('/share/<event_code>')
def share_event(event_code):
    """Trang chia sẻ sự kiện (chỉ xem)"""
    return render_template('index.html', event_code=event_code, allow_edit=False)

if __name__ == '__main__':
    init_db()
    app.run(debug=True, host='0.0.0.0', port=5001) 