from flask import Flask, render_template, request, jsonify, send_from_directory
import psycopg2
import psycopg2.extras
import os
import json
import secrets
import string
from datetime import datetime
import uuid

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
            INSERT INTO events (id, event_code, title, members, expenses, bank_info)
            VALUES (%s, %s, %s, %s, %s, %s)
            ''',
            (
                event_id,
                event_code,
                data.get('title', 'Sự Kiện Mới'),
                json.dumps(data.get('members', [])),
                json.dumps(data.get('expenses', [])),
                json.dumps(data.get('bankInfo', {})),
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
            return jsonify({
                'success': True,
                'event': {
                    'id': event['id'],
                    'event_code': event['event_code'],
                    'title': event['title'],
                    'members': json.loads(event['members']),
                    'expenses': json.loads(event['expenses']),
                    'bankInfo': json.loads(event['bank_info']) if event['bank_info'] else {},
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
            SET title = %s, members = %s, expenses = %s, bank_info = %s, updated_at = CURRENT_TIMESTAMP
            WHERE event_code = %s
            ''',
            (
                data.get('title', 'Sự Kiện Mới'),
                json.dumps(data.get('members', [])),
                json.dumps(data.get('expenses', [])),
                json.dumps(data.get('bankInfo', {})),
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
