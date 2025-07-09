# Ứng Dụng Chia Tiền Nhóm

Ứng dụng web giúp quản lý và chia tiền chi phí nhóm một cách dễ dàng và minh bạch.

## Tính năng chính

- ✅ **Tạo sự kiện**: Tạo sự kiện mới với tùy chọn bảo vệ bằng mật khẩu
- ✅ **Quản lý thành viên**: Thêm/xóa thành viên trong nhóm
- ✅ **Thêm chi phí**: Ghi lại các khoản chi phí với người thanh toán và người tham gia
- ✅ **Tính toán tự động**: Tự động tính toán ai nợ ai bao nhiều tiền
- ✅ **Cấu hình ngân hàng**: Lưu thông tin ngân hàng của từng thành viên
- ✅ **Chia sẻ sự kiện**: Chia sẻ link sự kiện cho thành viên khác
- ✅ **Giao diện responsive**: Tương thích với mobile và desktop
- ✅ **One-page layout**: Tất cả chức năng trong một trang

## Cài đặt

### Yêu cầu hệ thống
- Python 3.8+
- MongoDB 4.0+

### Cài đặt dependencies
```bash
pip install -r requirements.txt
```

### Cấu hình MongoDB
1. Cài đặt MongoDB trên máy local hoặc sử dụng MongoDB Atlas
2. Cập nhật thông tin kết nối trong `app.py`:
```python
app.config['MONGODB_SETTINGS'] = {
    'db': 'group_expense_app',
    'host': 'localhost',  # hoặc connection string của MongoDB Atlas
    'port': 27017
}
```

### Chạy ứng dụng
```bash
python app.py
```

Ứng dụng sẽ chạy tại `http://localhost:5000`

## Cấu trúc dự án

```
project/
├── app.py                 # Flask application chính
├── requirements.txt       # Dependencies
├── README.md             # Tài liệu hướng dẫn
└── templates/
    ├── base.html         # Template cơ sở
    ├── index.html        # Trang chủ
    └── event_detail.html # Trang chi tiết sự kiện
```

## Cách sử dụng

### 1. Tạo sự kiện mới
- Truy cập trang chủ
- Điền thông tin sự kiện (tên, mô tả, mật khẩu tùy chọn)
- Nhấn "Tạo sự kiện"

### 2. Thêm thành viên
- Trong trang sự kiện, nhấn nút "+" ở phần Thành viên
- Nhập tên thành viên và nhấn "Thêm"

### 3. Cấu hình ngân hàng
- Nhấn "Cấu hình ngân hàng" trong phần Thành viên
- Điền thông tin ngân hàng cho từng thành viên
- Nhấn "Lưu"

### 4. Thêm chi phí
- Nhấn nút "+" ở phần Chi phí
- Điền thông tin chi phí, chọn người thanh toán và người tham gia
- Nhấn "Thêm"

### 5. Tính toán kết quả
- Nhấn "Tính toán" trong phần Kết quả chia tiền
- Xem bảng tổng quan và các giao dịch cần thực hiện

### 6. Chia sẻ sự kiện
- Nhấn nút "Chia sẻ" để copy link hoặc chia sẻ qua các ứng dụng khác
- Thành viên khác có thể truy cập bằng mã sự kiện

## API Endpoints

### Events
- `POST /create_event` - Tạo sự kiện mới
- `POST /join_event` - Tham gia sự kiện
- `GET /event/<event_id>` - Xem chi tiết sự kiện

### Members
- `GET /api/event/<event_id>/members` - Lấy danh sách thành viên
- `POST /api/event/<event_id>/members` - Thêm thành viên mới
- `POST /api/event/<event_id>/update_member_bank` - Cập nhật thông tin ngân hàng

### Expenses
- `GET /api/event/<event_id>/expenses` - Lấy danh sách chi phí
- `POST /api/event/<event_id>/expenses` - Thêm chi phí mới

### Calculations
- `GET /api/event/<event_id>/calculate` - Tính toán kết quả chia tiền

## Công nghệ sử dụng

- **Backend**: Python Flask
- **Database**: MongoDB với MongoEngine ODM
- **Frontend**: HTML5, Bootstrap 5, jQuery
- **Icons**: Font Awesome
- **Authentication**: bcrypt cho mã hóa mật khẩu

## Tính năng nâng cao

- **Bảo mật**: Mã hóa mật khẩu bằng bcrypt
- **Responsive**: Giao diện tương thích với mọi thiết bị
- **Real-time**: Cập nhật dữ liệu ngay lập tức
- **Intuitive UX**: Giao diện trực quan, dễ sử dụng

## Đóng góp

Mọi đóng góp đều được hoan nghênh! Vui lòng:
1. Fork repository
2. Tạo feature branch
3. Commit thay đổi
4. Push lên branch
5. Tạo Pull Request

## Giấy phép

MIT License - Xem file LICENSE để biết thêm chi tiết.