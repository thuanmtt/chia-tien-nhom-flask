import os

from flask import Flask, render_template, request, jsonify, redirect, url_for, session
from flask_mongoengine import MongoEngine
from mongoengine import Document, StringField, FloatField, ListField, ReferenceField, DateTimeField, BooleanField
from datetime import datetime
import uuid
import bcrypt
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
app.config['MONGODB_SETTINGS'] = {
    'host': os.getenv('MONGODB_HOST'),
}

db = MongoEngine(app)


# Models
class Event(Document):
    name = StringField(required=True, max_length=200)
    description = StringField(max_length=500)
    event_id = StringField(required=True, unique=True)
    password_hash = StringField()
    has_password = BooleanField(default=False)
    created_at = DateTimeField(default=datetime.utcnow)

    meta = {'collection': 'events'}


class Member(Document):
    name = StringField(required=True, max_length=100)
    event = ReferenceField(Event, required=True)
    bank_name = StringField(max_length=100)
    bank_account = StringField(max_length=50)
    created_at = DateTimeField(default=datetime.utcnow)

    meta = {'collection': 'members'}


class Expense(Document):
    description = StringField(required=True, max_length=200)
    amount = FloatField(required=True)
    payer = ReferenceField(Member, required=True)
    participants = ListField(ReferenceField(Member))
    event = ReferenceField(Event, required=True)
    created_at = DateTimeField(default=datetime.utcnow)

    meta = {'collection': 'expenses'}


def hash_password(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())


def check_password(password, hashed):
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/create_event', methods=['POST'])
def create_event():
    data = request.get_json()
    event_id = str(uuid.uuid4())[:8]

    event = Event(
        name=data['name'],
        description=data.get('description', ''),
        event_id=event_id
    )

    if data.get('password'):
        event.password_hash = str(hash_password(data['password']).decode('utf-8'))
        event.has_password = True

    event.save()

    return jsonify({
        'success': True,
        'event_id': event_id,
        'redirect_url': url_for('event_detail', event_id=event_id)
    })


@app.route('/join_event', methods=['POST'])
def join_event():
    data = request.get_json()
    event_id = data['event_id']
    password = data.get('password')

    try:
        event = Event.objects.get(event_id=event_id)

        if event.has_password:
            if not password or not check_password(password, event.password_hash):
                return jsonify({'success': False, 'message': 'Mật khẩu không đúng'})

        return jsonify({
            'success': True,
            'redirect_url': url_for('event_detail', event_id=event_id)
        })

    except Event.DoesNotExist:
        return jsonify({'success': False, 'message': 'Sự kiện không tồn tại'})


@app.route('/event/<event_id>')
def event_detail(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        return render_template('event_detail.html', event=event)
    except Event.DoesNotExist:
        return redirect(url_for('index'))


@app.route('/api/event/<event_id>/members', methods=['GET'])
def get_members(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        members = Member.objects(event=event)

        members_data = []
        for member in members:
            members_data.append({
                'id': str(member.id),
                'name': member.name,
                'bank_name': member.bank_name or '',
                'bank_account': member.bank_account or ''
            })

        return jsonify({'members': members_data})
    except Event.DoesNotExist:
        return jsonify({'error': 'Event not found'}), 404


@app.route('/api/event/<event_id>/members', methods=['POST'])
def add_member(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        data = request.get_json()

        member = Member(
            name=data['name'],
            event=event,
            bank_name=data.get('bank_name', ''),
            bank_account=data.get('bank_account', '')
        )
        member.save()

        return jsonify({
            'success': True,
            'member': {
                'id': str(member.id),
                'name': member.name,
                'bank_name': member.bank_name,
                'bank_account': member.bank_account
            }
        })
    except Event.DoesNotExist:
        return jsonify({'error': 'Event not found'}), 404


@app.route('/api/event/<event_id>/expenses', methods=['GET'])
def get_expenses(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        expenses = Expense.objects(event=event)

        expenses_data = []
        for expense in expenses:
            participants_names = [p.name for p in expense.participants]
            expenses_data.append({
                'id': str(expense.id),
                'description': expense.description,
                'amount': expense.amount,
                'payer': expense.payer.name,
                'participants': participants_names,
                'participants_count': len(expense.participants)
            })

        return jsonify({'expenses': expenses_data})
    except Event.DoesNotExist:
        return jsonify({'error': 'Event not found'}), 404


@app.route('/api/event/<event_id>/expenses', methods=['POST'])
def add_expense(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        data = request.get_json()

        payer = Member.objects.get(id=data['payer_id'])
        participants = Member.objects(id__in=data['participant_ids'])

        expense = Expense(
            description=data['description'],
            amount=float(data['amount']),
            payer=payer,
            participants=participants,
            event=event
        )
        expense.save()

        return jsonify({'success': True})
    except (Event.DoesNotExist, Member.DoesNotExist):
        return jsonify({'error': 'Event or member not found'}), 404


@app.route('/api/event/<event_id>/calculate', methods=['GET'])
def calculate_expenses(event_id):
    try:
        event = Event.objects.get(event_id=event_id)
        members = Member.objects(event=event)
        expenses = Expense.objects(event=event)

        # Tính toán chi phí cho mỗi thành viên
        member_balances = {}
        for member in members:
            member_balances[str(member.id)] = {
                'name': member.name,
                'paid': 0.0,
                'owes': 0.0,
                'balance': 0.0
            }

        # Tính số tiền mỗi người đã trả
        for expense in expenses:
            payer_id = str(expense.payer.id)
            member_balances[payer_id]['paid'] += expense.amount

            # Tính số tiền mỗi người nợ
            per_person = expense.amount / len(expense.participants)
            for participant in expense.participants:
                participant_id = str(participant.id)
                member_balances[participant_id]['owes'] += per_person

        # Tính số dư
        for member_id in member_balances:
            paid = member_balances[member_id]['paid']
            owes = member_balances[member_id]['owes']
            member_balances[member_id]['balance'] = paid - owes

        # Tính toán giao dịch cần thiết
        settlements = []
        debtors = []
        creditors = []

        for member_id, data in member_balances.items():
            if data['balance'] < -0.01:  # Nợ
                debtors.append({'id': member_id, 'name': data['name'], 'amount': abs(data['balance'])})
            elif data['balance'] > 0.01:  # Được trả
                creditors.append({'id': member_id, 'name': data['name'], 'amount': data['balance']})

        # Tạo giao dịch
        for debtor in debtors:
            remaining_debt = debtor['amount']
            for creditor in creditors:
                if remaining_debt <= 0.01:
                    break
                if creditor['amount'] <= 0.01:
                    continue

                settlement_amount = min(remaining_debt, creditor['amount'])
                settlements.append({
                    'from': debtor['name'],
                    'to': creditor['name'],
                    'amount': settlement_amount
                })

                remaining_debt -= settlement_amount
                creditor['amount'] -= settlement_amount

        return jsonify({
            'member_balances': member_balances,
            'settlements': settlements
        })

    except Event.DoesNotExist:
        return jsonify({'error': 'Event not found'}), 404


@app.route('/api/event/<event_id>/update_member_bank', methods=['POST'])
def update_member_bank(event_id):
    try:
        data = request.get_json()
        member = Member.objects.get(id=data['member_id'])

        member.bank_name = data.get('bank_name', '')
        member.bank_account = data.get('bank_account', '')
        member.save()

        return jsonify({'success': True})
    except Member.DoesNotExist:
        return jsonify({'error': 'Member not found'}), 404


if __name__ == '__main__':
    app.run(debug=True)
