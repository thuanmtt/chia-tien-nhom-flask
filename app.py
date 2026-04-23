from flask import Flask, render_template, request, jsonify, redirect, url_for, send_from_directory
import sqlite3
import os
import json
import secrets
import string
from datetime import datetime
import uuid
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

app = Flask(__name__)

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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Thêm các cột mới cho DB cũ (SQLite không hỗ trợ ADD COLUMN IF NOT EXISTS)
    for ddl in (
        "ALTER TABLE events ADD COLUMN couples TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE events ADD COLUMN rates TEXT NOT NULL DEFAULT '{}'",
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
def create_event():
    """Tạo sự kiện mới"""
    try:
        data = request.get_json()
        
        # Tạo event_code
        event_code = generate_event_code()
        
        # Tạo event_id
        event_id = str(uuid.uuid4())
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO events (id, event_code, title, members, expenses, bank_info, couples, rates)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            event_id,
            event_code,
            data.get('title', 'Sự Kiện Mới'),
            json.dumps(data.get('members', [])),
            json.dumps(data.get('expenses', [])),
            json.dumps(data.get('bankInfo', {})),
            json.dumps(data.get('couples', [])),
            json.dumps(data.get('rates', {}))
        ))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'event_id': event_id,
            'event_code': event_code
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/events/<event_code>', methods=['GET'])
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
                    'created_at': event['created_at'],
                    'updated_at': event['updated_at']
                }
            })
        else:
            return jsonify({'success': False, 'error': 'Event not found'}), 404
            
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/events/<event_code>', methods=['PUT'])
def update_event(event_code):
    """Cập nhật sự kiện"""
    try:
        data = request.get_json()
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE events
            SET title = ?, members = ?, expenses = ?, bank_info = ?, couples = ?, rates = ?, updated_at = CURRENT_TIMESTAMP
            WHERE event_code = ?
        ''', (
            data.get('title', 'Sự Kiện Mới'),
            json.dumps(data.get('members', [])),
            json.dumps(data.get('expenses', [])),
            json.dumps(data.get('bankInfo', {})),
            json.dumps(data.get('couples', [])),
            json.dumps(data.get('rates', {})),
            event_code
        ))
        
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

def _fetch_vietcombank_rates(date_str):
    """Gọi API tỷ giá Vietcombank. Trả về dict: {currencyCode: {cash, transfer, sell, currencyName}}"""
    url = f'https://vietcombank.com.vn/api/exchangerates?date={date_str}'
    req = Request(url, headers={
        'accept': '*/*',
        'referer': 'https://vietcombank.com.vn/vi-VN/KHCN/Cong-cu-Tien-ich/Ty-gia',
        'user-agent': 'Mozilla/5.0',
    })
    with urlopen(req, timeout=10) as resp:
        raw = resp.read().decode('utf-8')
    payload = json.loads(raw)
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
        'date': payload.get('Date'),
        'updatedDate': payload.get('UpdatedDate'),
        'rates': rates,
    }


@app.route('/api/exchange-rates')
def get_exchange_rates():
    """Lấy tỷ giá từ Vietcombank cho 1 ngày cụ thể (hoặc hôm nay)"""
    date_str = request.args.get('date') or datetime.now().strftime('%Y-%m-%d')
    try:
        data = _fetch_vietcombank_rates(date_str)
        return jsonify({'success': True, **data})
    except (HTTPError, URLError) as e:
        return jsonify({'success': False, 'error': f'Không kết nối được Vietcombank: {e}'}), 502
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/banks')
def get_banks():
    """Lấy danh sách ngân hàng"""
    try:
        banks_path = os.path.join(BASE_DIR, 'static', 'banks.json')
        with open(banks_path, 'r', encoding='utf-8') as f:
            banks_data = json.load(f)
        return jsonify(banks_data)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/events', methods=['GET'])
def get_all_events():
    """Lấy danh sách tất cả sự kiện"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, event_code, title, members, expenses, created_at, updated_at
            FROM events 
            ORDER BY updated_at DESC
        ''')
        
        events = cursor.fetchall()
        conn.close()
        
        events_list = []
        for event in events:
            members = json.loads(event['members'])
            expenses = json.loads(event['expenses'])
            total_expense = sum(expense.get('amount', 0) for expense in expenses)
            
            events_list.append({
                'id': event['id'],
                'event_code': event['event_code'],
                'title': event['title'],
                'members_count': len(members),
                'expenses_count': len(expenses),
                'total_expense': total_expense,
                'created_at': event['created_at'],
                'updated_at': event['updated_at']
            })
        
        return jsonify({
            'success': True,
            'events': events_list
        })
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/events/<event_code>', methods=['DELETE'])
def delete_event(event_code):
    """Xóa sự kiện"""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM events WHERE event_code = ?', (event_code,))
        
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True})
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

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