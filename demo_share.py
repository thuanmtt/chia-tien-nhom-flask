#!/usr/bin/env python3
"""
Demo script để test tính năng chia sẻ với event_code
"""

import requests
import json

BASE_URL = "http://localhost:5001"

def create_demo_event():
    """Tạo sự kiện demo"""
    print("🎯 Tạo sự kiện demo...")
    
    event_data = {
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
            },
            {
                "title": "Tiền taxi",
                "amount": 150000,
                "payer": "Em C",
                "benefitType": "selected",
                "beneficiaries": ["Anh A", "Chị B", "Em C"]
            }
        ],
        "bankInfo": {
            "Anh A": {"bank": "VCB", "account": "1234567890"},
            "Chị B": {"bank": "MB", "account": "0987654321"},
            "Em C": {"bank": "ACB", "account": "1122334455"},
            "Anh D": {"bank": "TPB", "account": "5566778899"},
            "Chị E": {"bank": "VPB", "account": "4433221100"}
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
            print(f"✅ Tạo sự kiện thành công!")
            print(f"📋 Event Code: {event_code}")
            print(f"🌐 Link chia sẻ: {BASE_URL}/?event_code={event_code}")
            return event_code
        else:
            print(f"❌ Lỗi: {data.get('error')}")
            return None
    else:
        print(f"❌ Lỗi HTTP: {response.status_code}")
        return None

def test_share_link(event_code):
    """Test link chia sẻ"""
    print(f"\n🔗 Testing link chia sẻ...")
    
    # Test lấy thông tin sự kiện
    response = requests.get(f"{BASE_URL}/api/events/{event_code}")
    
    if response.status_code == 200:
        data = response.json()
        if data.get('success'):
            event = data.get('event')
            print(f"✅ Lấy thông tin sự kiện thành công!")
            print(f"📝 Tiêu đề: {event.get('title')}")
            print(f"👥 Số thành viên: {len(event.get('members', []))}")
            print(f"💰 Số chi phí: {len(event.get('expenses', []))}")
            
            # Tính tổng chi phí
            total = sum(expense.get('amount', 0) for expense in event.get('expenses', []))
            print(f"💵 Tổng chi phí: {total:,} VND")
            
            return True
        else:
            print(f"❌ Lỗi: {data.get('error')}")
            return False
    else:
        print(f"❌ Lỗi HTTP: {response.status_code}")
        return False

def main():
    """Chạy demo"""
    print("🎉 Demo tính năng chia sẻ với event_code\n")
    
    # Tạo sự kiện demo
    event_code = create_demo_event()
    if not event_code:
        return
    
    # Test link chia sẻ
    if test_share_link(event_code):
        print(f"\n🎯 Demo hoàn thành!")
        print(f"📱 Bạn có thể mở link sau trong trình duyệt:")
        print(f"   {BASE_URL}/?event_code={event_code}")
        print(f"\n💡 Link này sẽ tự động tải dữ liệu sự kiện khi mở!")

if __name__ == "__main__":
    main() 