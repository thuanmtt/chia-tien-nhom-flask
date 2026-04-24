from flask import Flask, render_template, request, jsonify, send_from_directory
import psycopg2
import psycopg2.extras
import os
import json
import secrets
import string
from datetime import datetime
import uuid
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),
    static_folder=os.path.join(BASE_DIR, 'static'),
)


def _database_url():
    url = (
        os.environ.get('DATABASE_URL')
        or os.environ.get('POSTGRES_URL')
        or os.environ.get('POSTGRES_PRISMA_URL')
    )
    if not url:
        raise RuntimeError('DATABASE_URL (or POSTGRES_URL) is not set')
    return url


def get_db_connection():
    conn = psycopg2.connect(_database_url())
    return conn


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
def create_event():
    try:
        data = request.get_json()
        event_code = generate_event_code()
        event_id = str(uuid.uuid4())

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            '''
            INSERT INTO events (id, event_code, title, members, expenses, bank_info, couples, rates)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ''',
            (
                event_id,
                event_code,
                data.get('title', 'Sự Kiện Mới'),
                json.dumps(data.get('members', [])),
                json.dumps(data.get('expenses', [])),
                json.dumps(data.get('bankInfo', {})),
                json.dumps(data.get('couples', [])),
                json.dumps(data.get('rates', {})),
            ),
        )
        conn.commit()
        conn.close()

        return jsonify({'success': True, 'event_id': event_id, 'event_code': event_code})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/events/<event_code>', methods=['GET'])
def get_event(event_code):
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute('SELECT * FROM events WHERE event_code = %s', (event_code,))
        event = cursor.fetchone()
        conn.close()

        if event:
            couples_raw = event.get('couples') if isinstance(event, dict) else None
            rates_raw = event.get('rates') if isinstance(event, dict) else None
            return jsonify({
                'success': True,
                'event': {
                    'id': event['id'],
                    'event_code': event['event_code'],
                    'title': event['title'],
                    'members': json.loads(event['members']),
                    'expenses': json.loads(event['expenses']),
                    'bankInfo': json.loads(event['bank_info']) if event['bank_info'] else {},
                    'couples': json.loads(couples_raw) if couples_raw else [],
                    'rates': json.loads(rates_raw) if rates_raw else {},
                    'created_at': event['created_at'].isoformat() if event['created_at'] else None,
                    'updated_at': event['updated_at'].isoformat() if event['updated_at'] else None,
                },
            })
        return jsonify({'success': False, 'error': 'Event not found'}), 404
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/events/<event_code>', methods=['PUT'])
def update_event(event_code):
    try:
        data = request.get_json()
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            '''
            UPDATE events
            SET title = %s, members = %s, expenses = %s, bank_info = %s, couples = %s, rates = %s, updated_at = CURRENT_TIMESTAMP
            WHERE event_code = %s
            ''',
            (
                data.get('title', 'Sự Kiện Mới'),
                json.dumps(data.get('members', [])),
                json.dumps(data.get('expenses', [])),
                json.dumps(data.get('bankInfo', {})),
                json.dumps(data.get('couples', [])),
                json.dumps(data.get('rates', {})),
                event_code,
            ),
        )
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'success': False, 'error': 'Event not found'}), 404
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


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
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/banks')
def get_banks():
    try:
        banks_path = os.path.join(BASE_DIR, 'static', 'banks.json')
        with open(banks_path, 'r', encoding='utf-8') as f:
            banks_data = json.load(f)
        return jsonify(banks_data)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/events', methods=['GET'])
def get_all_events():
    try:
        conn = get_db_connection()
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute(
            '''
            SELECT id, event_code, title, members, expenses, created_at, updated_at
            FROM events
            ORDER BY updated_at DESC
            '''
        )
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
                'created_at': event['created_at'].isoformat() if event['created_at'] else None,
                'updated_at': event['updated_at'].isoformat() if event['updated_at'] else None,
            })
        return jsonify({'success': True, 'events': events_list})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/events/<event_code>', methods=['DELETE'])
def delete_event(event_code):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM events WHERE event_code = %s', (event_code,))
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
    return render_template('index.html', event_code=event_code)


@app.route('/share/<event_code>')
def share_event(event_code):
    return render_template('index.html', event_code=event_code, allow_edit=False)


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5002)
