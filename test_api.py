#!/usr/bin/env python3
"""
Test script cho Flask app
"""

import requests
import json

BASE_URL = "http://localhost:5001"

def test_banks_api():
    """Test API lấy danh sách ngân hàng"""
    print("Testing banks API...")
    response = requests.get(f"{BASE_URL}/api/banks")
    if response.status_code == 200:
        data = response.json()
        print(f"✅ Banks API OK - Found {len(data.get('data', []))} banks")
        return True
    else:
        print(f"❌ Banks API failed - Status: {response.status_code}")
        return False

def test_create_event():
    """Test tạo sự kiện mới"""
    print("Testing create event API...")
    event_data = {
        "title": "Test Event",
        "members": ["Anh A", "Chị B", "Em C"],
        "expenses": [
            {
                "title": "Tiền ăn",
                "amount": 300000,
                "payer": "Anh A",
                "benefitType": "all",
                "beneficiaries": ["Anh A", "Chị B", "Em C"]
            }
        ],
        "bankInfo": {
            "Anh A": {"bank": "VCB", "account": "1234567890"},
            "Chị B": {"bank": "MB", "account": "0987654321"}
        }
    }
    
    response = requests.post(
        f"{BASE_URL}/api/events",
        json=event_data,
        headers={'Content-Type': 'application/json'}
    )

    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            event_code = data.get('event_code')
            edit_key = data.get('edit_key')
            if not edit_key:
                print("❌ Create event failed - missing edit_key in response")
                return None, None
            print(f"✅ Create event OK - Event code: {event_code}")
            return event_code, edit_key
        else:
            print(f"❌ Create event failed - {data.get('error')}")
            return None, None
    else:
        print(f"❌ Create event failed - Status: {response.status_code}")
        return None, None

def test_get_event(event_code):
    """Test lấy thông tin sự kiện"""
    print(f"Testing get event API for {event_code}...")
    response = requests.get(f"{BASE_URL}/api/events/{event_code}")
    
    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            event = data.get('event')
            if 'edit_key' in event:
                print("❌ Get event leaked edit_key!")
                return False
            print(f"✅ Get event OK - Title: {event.get('title')}")
            return True
        else:
            print(f"❌ Get event failed - {data.get('error')}")
            return False
    else:
        print(f"❌ Get event failed - Status: {response.status_code}")
        return False

def test_update_event(event_code, edit_key):
    """Test cập nhật sự kiện"""
    print(f"Testing update event API for {event_code}...")
    event_data = {
        "title": "Updated Test Event",
        "members": ["Anh A", "Chị B", "Em C", "Anh D"],
        "expenses": [
            {
                "title": "Tiền ăn",
                "amount": 400000,
                "payer": "Anh A",
                "benefitType": "all",
                "beneficiaries": ["Anh A", "Chị B", "Em C", "Anh D"]
            }
        ],
        "bankInfo": {
            "Anh A": {"bank": "VCB", "account": "1234567890"},
            "Chị B": {"bank": "MB", "account": "0987654321"},
            "Em C": {"bank": "ACB", "account": "1122334455"}
        }
    }
    
    # Không có / sai edit_key phải bị chặn 403
    for bad_headers in (
        {'Content-Type': 'application/json'},
        {'Content-Type': 'application/json', 'X-Edit-Key': 'sai-key'},
    ):
        response = requests.put(
            f"{BASE_URL}/api/events/{event_code}",
            json=event_data,
            headers=bad_headers
        )
        if response.status_code != 403:
            print(f"❌ Update without valid edit_key should be 403, got {response.status_code}")
            return False
    print("✅ Update without valid edit_key correctly rejected (403)")

    response = requests.put(
        f"{BASE_URL}/api/events/{event_code}",
        json=event_data,
        headers={'Content-Type': 'application/json', 'X-Edit-Key': edit_key}
    )

    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            print(f"✅ Update event OK")
            return True
        else:
            print(f"❌ Update event failed - {data.get('error')}")
            return False
    else:
        print(f"❌ Update event failed - Status: {response.status_code}")
        return False

def test_delete_event(event_code, edit_key):
    """Test xóa sự kiện"""
    print(f"Testing delete event API for {event_code}...")

    response = requests.delete(f"{BASE_URL}/api/events/{event_code}")
    if response.status_code != 403:
        print(f"❌ Delete without edit_key should be 403, got {response.status_code}")
        return False
    print("✅ Delete without edit_key correctly rejected (403)")

    response = requests.delete(
        f"{BASE_URL}/api/events/{event_code}",
        headers={'X-Edit-Key': edit_key}
    )

    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            print(f"✅ Delete event OK")
            return True
        else:
            print(f"❌ Delete event failed - {data.get('error')}")
            return False
    else:
        print(f"❌ Delete event failed - Status: {response.status_code}")
        return False

def main():
    """Chạy tất cả tests"""
    print("🚀 Starting API tests...\n")
    
    # Test banks API
    if not test_banks_api():
        return
    
    # Test create event
    event_code, edit_key = test_create_event()
    if not event_code:
        return

    # Test get event
    if not test_get_event(event_code):
        return

    # Test update event
    if not test_update_event(event_code, edit_key):
        return

    # Test delete event
    if not test_delete_event(event_code, edit_key):
        return
    
    print("\n🎉 All tests passed!")

if __name__ == "__main__":
    main() 