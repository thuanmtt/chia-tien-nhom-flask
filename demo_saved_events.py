#!/usr/bin/env python3
"""
Demo script để test tính năng xem sự kiện đã lưu
"""

import requests
import json

BASE_URL = "http://localhost:5001"

def create_multiple_events():
    """Tạo nhiều sự kiện demo"""
    print("🎯 Tạo nhiều sự kiện demo...")
    
    events_data = [
        {
            "title": "Tiệc Sinh Nhật Anh A",
            "members": ["Anh A", "Chị B", "Em C", "Anh D", "Chị E"],
            "expenses": [
                {
                    "title": "Tiền ăn nhà hàng",
                    "amount": 500000,
                    "payer": "Anh A",
                    "benefitType": "all",
                    "beneficiaries": ["Anh A", "Chị B", "Em C", "Anh D", "Chị E"]
                },
                {
                    "title": "Tiền bánh kem",
                    "amount": 200000,
                    "payer": "Chị B",
                    "benefitType": "all",
                    "beneficiaries": ["Anh A", "Chị B", "Em C", "Anh D", "Chị E"]
                }
            ],
            "bankInfo": {
                "Anh A": {"bank": "VCB", "account": "1234567890"},
                "Chị B": {"bank": "MB", "account": "0987654321"}
            }
        },
        {
            "title": "Du lịch Đà Nẵng",
            "members": ["Anh X", "Chị Y", "Em Z"],
            "expenses": [
                {
                    "title": "Tiền khách sạn",
                    "amount": 1200000,
                    "payer": "Anh X",
                    "benefitType": "all",
                    "beneficiaries": ["Anh X", "Chị Y", "Em Z"]
                },
                {
                    "title": "Tiền ăn",
                    "amount": 800000,
                    "payer": "Chị Y",
                    "benefitType": "all",
                    "beneficiaries": ["Anh X", "Chị Y", "Em Z"]
                },
                {
                    "title": "Tiền vé máy bay",
                    "amount": 2400000,
                    "payer": "Em Z",
                    "benefitType": "all",
                    "beneficiaries": ["Anh X", "Chị Y", "Em Z"]
                }
            ],
            "bankInfo": {
                "Anh X": {"bank": "ACB", "account": "1122334455"},
                "Chị Y": {"bank": "TPB", "account": "5566778899"},
                "Em Z": {"bank": "VPB", "account": "4433221100"}
            }
        },
        {
            "title": "Tiệc BBQ cuối tuần",
            "members": ["Anh M", "Chị N", "Anh P", "Chị Q"],
            "expenses": [
                {
                    "title": "Tiền thịt",
                    "amount": 400000,
                    "payer": "Anh M",
                    "benefitType": "all",
                    "beneficiaries": ["Anh M", "Chị N", "Anh P", "Chị Q"]
                },
                {
                    "title": "Tiền rau củ",
                    "amount": 150000,
                    "payer": "Chị N",
                    "benefitType": "all",
                    "beneficiaries": ["Anh M", "Chị N", "Anh P", "Chị Q"]
                },
                {
                    "title": "Tiền bia rượu",
                    "amount": 300000,
                    "payer": "Anh P",
                    "benefitType": "all",
                    "beneficiaries": ["Anh M", "Chị N", "Anh P", "Chị Q"]
                }
            ],
            "bankInfo": {
                "Anh M": {"bank": "VCB", "account": "1111111111"},
                "Chị N": {"bank": "MB", "account": "2222222222"},
                "Anh P": {"bank": "ACB", "account": "3333333333"},
                "Chị Q": {"bank": "TPB", "account": "4444444444"}
            }
        }
    ]
    
    created_events = []
    
    for i, event_data in enumerate(events_data, 1):
        print(f"   Tạo sự kiện {i}: {event_data['title']}")
        
        response = requests.post(
            f"{BASE_URL}/api/events",
            json=event_data,
            headers={'Content-Type': 'application/json'}
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get('success'):
                event_code = data.get('event_code')
                created_events.append({
                    'title': event_data['title'],
                    'event_code': event_code
                })
                print(f"   ✅ Thành công - Event code: {event_code}")
            else:
                print(f"   ❌ Lỗi: {data.get('error')}")
        else:
            print(f"   ❌ Lỗi HTTP: {response.status_code}")
    
    return created_events

def test_get_all_events():
    """Test lấy danh sách tất cả sự kiện"""
    print(f"\n📋 Lấy danh sách tất cả sự kiện...")
    
    response = requests.get(f"{BASE_URL}/api/events")
    
    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            events = data.get('events', [])
            print(f"✅ Tìm thấy {len(events)} sự kiện:")
            
            for i, event in enumerate(events, 1):
                print(f"   {i}. {event['title']}")
                print(f"      👥 {event['members_count']} thành viên")
                print(f"      💰 {event['expenses_count']} chi phí - Tổng: {event['total_expense']:,} VND")
                print(f"      📅 {event['updated_at']}")
                print(f"      🔑 Mã: {event['event_code']}")
                print()
            
            return events
        else:
            print(f"❌ Lỗi: {data.get('error')}")
            return []
    else:
        print(f"❌ Lỗi HTTP: {response.status_code}")
        return []

def test_delete_event(event_code):
    """Test xóa một sự kiện"""
    print(f"🗑️  Xóa sự kiện {event_code}...")
    
    response = requests.delete(f"{BASE_URL}/api/events/{event_code}")
    
    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            print(f"✅ Đã xóa sự kiện thành công!")
            return True
        else:
            print(f"❌ Lỗi: {data.get('error')}")
            return False
    else:
        print(f"❌ Lỗi HTTP: {response.status_code}")
        return False

def main():
    """Chạy demo"""
    print("🎉 Demo tính năng xem sự kiện đã lưu\n")
    
    # Tạo nhiều sự kiện demo
    created_events = create_multiple_events()
    if not created_events:
        print("❌ Không thể tạo sự kiện demo!")
        return
    
    print(f"\n✅ Đã tạo {len(created_events)} sự kiện demo!")
    
    # Test lấy danh sách sự kiện
    events = test_get_all_events()
    if not events:
        print("❌ Không thể lấy danh sách sự kiện!")
        return
    
    # Test xóa một sự kiện
    if events:
        first_event = events[0]
        if test_delete_event(first_event['event_code']):
            print(f"✅ Đã xóa sự kiện: {first_event['title']}")
            
            # Kiểm tra lại danh sách sau khi xóa
            print(f"\n📋 Kiểm tra danh sách sau khi xóa...")
            remaining_events = test_get_all_events()
            print(f"✅ Còn lại {len(remaining_events)} sự kiện")
    
    print(f"\n🎯 Demo hoàn thành!")
    print(f"📱 Bạn có thể mở ứng dụng để xem danh sách sự kiện:")
    print(f"   {BASE_URL}")

if __name__ == "__main__":
    main() 