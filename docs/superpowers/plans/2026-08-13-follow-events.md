# Theo dõi / Bỏ theo dõi sự kiện + icon owner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng chủ động bấm "Theo dõi" để đưa event không phải của mình vào "Sự Kiện Của Tôi" (bỏ hẳn auto-lưu khi mở event); event do mình tạo có icon vương miện trong danh sách.

**Architecture:** Tái dùng toàn bộ hạ tầng `saved_events` sẵn có (`POST /api/my-events/save` = Theo dõi, `DELETE /api/my-events/<code>` = Bỏ theo dõi). Backend chỉ thêm cờ `is_saved` vào `GET /api/events/<code>`. Frontend thêm nút `#followEventBtn` trên header event, xóa cơ chế auto-lưu `rememberEvent`, và render icon `fa-crown` cho event `owned` trong `displaySavedEvents`.

**Tech Stack:** Flask + psycopg2 (Supabase Postgres), jQuery/Bootstrap SPA (`static/app.js`), FontAwesome icons. Không có pytest/bundler — integration test là script `test_api.py` (cần server local + .env), frontend chỉ có `node --check`.

**Spec:** `docs/superpowers/specs/2026-08-13-follow-events-design.md`

## Global Constraints

- Toàn bộ UI text, comment, thông báo lỗi bằng **tiếng Việt**.
- **XSS**: mọi dữ liệu user-controlled render qua `escapeHtml()` hoặc `.text()`. (Nút Theo dõi và icon crown là HTML tĩnh — không chứa dữ liệu user.)
- **CSP**: KHÔNG script inline trong `index.html`.
- Đọc `data-event-code` bằng `.attr()`, không dùng `.data()` (jQuery ép kiểu mã toàn chữ số).
- Không thêm dependency mới; không đụng `requirements.txt`.
- Lỗi server trả qua `_server_error()`; `except Exception` quanh request-body phải re-raise `HTTPException` trước (route sửa ở đây đã có sẵn pattern này — giữ nguyên).
- Chạy test integration: cần server local (`python3 vercel_app.py` → :5002) + `.env` đầy đủ (DATABASE_URL, SUPABASE_*). Test tạo/xóa user + event thật trên Supabase và tự dọn.

---

### Task 1: Backend — cờ `is_saved` trong `GET /api/events/<code>`

**Files:**
- Modify: `vercel_app.py` (hàm `get_event`, ~dòng 720–768)
- Modify: `vercel_app.py` (docstring `save_my_events`, ~dòng 518–520)
- Test: `test_api.py` (hàm `test_saved_events`, ~dòng 483–561)

**Interfaces:**
- Consumes: bảng `saved_events (user_id uuid, event_id)` sẵn có; `_event_access` trả `acc.event_id`; `request_user_id(request)` trả `user_id` hoặc `None`.
- Produces: response `GET /api/events/<code>` có thêm key `event.is_saved` (bool) — `true` chỉ khi có JWT hợp lệ VÀ user đã lưu event này. Task 2 (frontend) đọc cờ này.

- [ ] **Step 1: Viết assertion FAIL trong `test_api.py`**

Trong `test_saved_events`, chèn 3 khối sau:

(a) Làm 3 dòng ĐẦU TIÊN bên trong khối `try:` (ngay trước comment `# Chưa đăng nhập → 401`, indent 8 spaces — đặt trong `try` để event được dọn ở `finally` nếu assert fail):

```python
        # is_saved ban đầu: chưa ai lưu
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is False, 'chưa lưu → is_saved phải False'
```

(b) Sau khối "Lưu lần 2 phải idempotent" (~dòng 515, trước comment `# Batch trộn mã đã lưu…`):

```python
        # Cờ is_saved trong GET event phản ánh trạng thái theo dõi của từng user
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is True, 'user2 đã lưu → is_saved=True'
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth1)
        assert r.json()['event']['is_saved'] is False, 'owner chưa lưu → is_saved=False'
        r = requests.get(f"{BASE_URL}/api/events/{code}")
        assert r.json()['event']['is_saved'] is False, 'ẩn danh → is_saved=False'
        print("  ✅ GET event trả is_saved đúng theo user")
```

(c) Sau khối "Gỡ lần nữa vẫn 200 (idempotent)" (~dòng 560, trước comment `# Bookmark không mang quyền…`):

```python
        r = requests.get(f"{BASE_URL}/api/events/{code}", headers=auth2)
        assert r.json()['event']['is_saved'] is False, 'đã gỡ → is_saved phải False'
```

- [ ] **Step 2: Chạy test xác nhận FAIL**

```bash
# Terminal 1 (hoặc chạy nền): server local đọc .env
python3 vercel_app.py &
sleep 3
python3 test_api.py; echo "exit=$?"
```

Expected: FAIL tại `test_saved_events` với `KeyError: 'is_saved'` (exit ≠ 0). Các test trước đó (banks, create, get…) vẫn pass.

- [ ] **Step 3: Implement trong `vercel_app.py`**

Trong `get_event`, ngay SAU dòng `doc = load_event_children(cursor, acc.event_id)` (vẫn bên trong khối `with conn.cursor(...)`):

```python
            # Trạng thái "theo dõi" của user hiện tại (nút Theo dõi trên UI).
            # Chỉ tra khi có đăng nhập — ẩn danh luôn False.
            is_saved = False
            if user_id:
                cursor.execute(
                    '''SELECT EXISTS(SELECT 1 FROM saved_events
                                     WHERE user_id = %s::uuid AND event_id = %s) AS saved''',
                    (user_id, acc.event_id),
                )
                is_saved = bool(cursor.fetchone()['saved'])
```

Trong dict `event` của `jsonify`, thêm sau dòng `'is_owner': acc.is_owner,`:

```python
                'is_saved': is_saved,
```

Cập nhật docstring `save_my_events` (~dòng 518–520): thay câu `dùng cho cả lưu 1 mã khi mở event lẫn migration danh sách localStorage` bằng `dùng cho nút Theo dõi (1 mã) lẫn migration danh sách localStorage khi đăng nhập`.

- [ ] **Step 4: Chạy test xác nhận PASS**

```bash
python3 test_api.py; echo "exit=$?"
```

Expected: tất cả test pass, exit=0 (server ở Step 2 vẫn đang chạy; xong thì `kill %1`).

- [ ] **Step 5: Commit**

```bash
git add vercel_app.py test_api.py
git commit -m "feat(api): cờ is_saved trong GET event cho nút Theo dõi"
```

---

### Task 2: Frontend — nút Theo dõi / Bỏ theo dõi, bỏ auto-lưu

**Files:**
- Modify: `templates/index.html` (khối `.group-actions`, ~dòng 97–113)
- Modify: `static/app.js`:
  - khai báo state (~dòng 39)
  - `createNewEvent` (~dòng 594–620)
  - success của `POST /api/events` trong `saveEvent` (~dòng 784–796 — xóa `rememberEvent`)
  - `loadEventFromServer` success (~dòng 833–893)
  - hàm `rememberEvent` (~dòng 1687–1702 — xóa)
  - handler `.unsave-event-btn` (~dòng 2764–2787)
  - thêm hàm `updateFollowButton` + click handler mới
- Test: `node --check static/app.js` (không có test tự động cho UI)

**Interfaces:**
- Consumes: `eventData.is_saved` từ Task 1; các hàm sẵn có `readSavedEventCodes()`, `saveEventCodeToLocalStorage(code)`, `removeEventCodeFromLocalStorage(code)`, `AppAuth.isLoggedIn()`, `AppAuth.authHeaders()`, `showToast(msg, type)`; biến state sẵn có `currentEventCode`, `isOwner`.
- Produces: biến `isSavedEvent` (bool) + hàm `updateFollowButton()` — Task 3 không phụ thuộc; không ai khác đọc.

- [ ] **Step 1: Thêm nút vào `templates/index.html`**

Ngay SAU nút `#shareEventBtn` (đóng thẻ `</button>` ~dòng 112), thêm:

```html
                            <button class="btn btn-sm btn-header-action d-none" id="followEventBtn"></button>
```

(Nội dung icon+chữ do JS đặt theo trạng thái; nút ẩn mặc định bằng `d-none` — điều khiển bằng `toggleClass('d-none')`, KHÔNG dùng `.show()/.hide()` để không đụng cơ chế ẩn/hiện của `updateUIForEditMode`.)

- [ ] **Step 2: State + hàm `updateFollowButton` trong `app.js`**

Sau dòng `let isOwner = false; ...` (~dòng 39), thêm:

```javascript
        let isSavedEvent = false; // user đang "theo dõi" (đã lưu) event hiện tại
```

Thay THÂN hàm `rememberEvent` (~dòng 1687–1702) — xóa cả comment phía trên nó — bằng hàm mới tại đúng vị trí đó:

```javascript
        // Nút Theo dõi / Bỏ theo dõi trên header: chỉ hiện với event đã có trên
        // server và KHÔNG phải của mình — event mình tạo luôn nằm sẵn trong
        // "Sự Kiện Của Tôi" theo owner_id, không cần theo dõi. Nội dung nút là
        // HTML tĩnh (không có dữ liệu user) nên .html() an toàn.
        function updateFollowButton() {
            const $btn = $('#followEventBtn');
            if (!currentEventCode || isOwner) {
                $btn.addClass('d-none');
                return;
            }
            $btn.removeClass('d-none');
            $btn.html(isSavedEvent
                ? '<i class="fas fa-bell-slash me-1"></i>Bỏ theo dõi'
                : '<i class="fas fa-bell me-1"></i>Theo dõi');
        }
```

- [ ] **Step 3: Bỏ auto-lưu, set trạng thái khi tải event**

(a) Trong success của `POST /api/events` (~dòng 789): XÓA dòng
`rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"`.

(b) Trong `loadEventFromServer` success, thay khối (~dòng 881–886):

```javascript
                    // Chỉ lưu event_code vào localStorage khi ở chế độ cho phép chỉnh sửa,
                    // để tránh trường hợp mở link chỉ-xem rồi quay lại "/" vẫn vào được chế độ sửa
                    if (allowEdit) {
                        localStorage.setItem('currentEventCode', currentEventCode);
                        rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"
                    }
```

bằng:

```javascript
                    // Chỉ lưu event_code vào localStorage khi ở chế độ cho phép chỉnh sửa,
                    // để tránh trường hợp mở link chỉ-xem rồi quay lại "/" vẫn vào được chế độ sửa.
                    // KHÔNG auto-lưu vào "Sự Kiện Của Tôi" — người dùng chủ động bấm Theo dõi.
                    if (allowEdit) {
                        localStorage.setItem('currentEventCode', currentEventCode);
                    }

                    // Trạng thái nút Theo dõi: đăng nhập → cờ is_saved từ server;
                    // khách → danh sách localStorage của máy này.
                    isSavedEvent = AppAuth.isLoggedIn()
                        ? !!eventData.is_saved
                        : readSavedEventCodes().includes(currentEventCode);
                    updateFollowButton();
```

(c) Trong `createNewEvent` (~dòng 602, sau `isOwner = true;`), thêm:

```javascript
            isSavedEvent = false;
            updateFollowButton(); // currentEventCode=null → ẩn nút
```

- [ ] **Step 4: Click handler Theo dõi / Bỏ theo dõi**

Thêm ngay TRƯỚC handler `$(document).on('click', '.unsave-event-btn', ...)` (~dòng 2763):

```javascript
        // Theo dõi / Bỏ theo dõi event đang mở (chỉ hiện khi không phải owner).
        // Đăng nhập → saved_events trên tài khoản; khách → localStorage máy này
        // (đăng nhập sẽ được migrateLocalSavedEvents đẩy lên tài khoản).
        $('#followEventBtn').click(function () {
            if (!currentEventCode) return;
            const code = currentEventCode;
            const follow = !isSavedEvent;
            function done() {
                isSavedEvent = follow;
                updateFollowButton();
                showToast(follow
                    ? 'Đã theo dõi sự kiện — xem lại trong "Sự Kiện Của Tôi".'
                    : 'Đã bỏ theo dõi sự kiện.', 'success');
            }
            if (AppAuth.isLoggedIn()) {
                $.ajax(follow ? {
                    url: '/api/my-events/save',
                    method: 'POST',
                    contentType: 'application/json',
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify({ codes: [code] })
                } : {
                    url: `/api/my-events/${encodeURIComponent(code)}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders()
                }).done(done).fail(function () {
                    showToast('Không cập nhật được trạng thái theo dõi, vui lòng thử lại.', 'error');
                });
            } else {
                if (follow) saveEventCodeToLocalStorage(code);
                else removeEventCodeFromLocalStorage(code);
                done();
            }
        });
```

Đồng bộ nút khi gỡ từ danh sách: trong handler `.unsave-event-btn`, thay hàm `done()` hiện có:

```javascript
            function done() {
                showToast('Đã gỡ sự kiện khỏi danh sách.', 'success');
                renderSavedEvents();
            }
```

bằng:

```javascript
            function done() {
                showToast('Đã gỡ sự kiện khỏi danh sách.', 'success');
                if (eventCode === currentEventCode) {
                    isSavedEvent = false;
                    updateFollowButton();
                }
                renderSavedEvents();
            }
```

- [ ] **Step 5: Verify**

```bash
node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js
grep -n "rememberEvent" static/app.js; echo "grep exit=$? (phải =1: không còn call site)"
```

Expected: node --check sạch; grep không còn kết quả (exit 1).

Smoke test tay (nếu server + browser sẵn): mở event của user khác → thấy nút "Theo dõi"; bấm → toast + nút đổi "Bỏ theo dõi" + event xuất hiện trong "Sự Kiện Của Tôi"; bấm lại → gỡ. Mở event mình tạo → KHÔNG thấy nút.

- [ ] **Step 6: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat(ui): nút Theo dõi / Bỏ theo dõi thay cho auto-lưu vào Sự Kiện Của Tôi"
```

---

### Task 3: Icon owner trong danh sách + cập nhật docs

**Files:**
- Modify: `static/app.js` (hàm `displaySavedEvents`, ~dòng 1845–1897)
- Modify: `CLAUDE.md` (đoạn "Sự Kiện Của Tôi" trong **Auth model** và đoạn frontend nói về danh sách)
- Test: `node --check static/app.js`

**Interfaces:**
- Consumes: cờ `owned` đã có trong `ownedByCode` (từ `GET /api/my-events`); khách → `ownedByCode` rỗng, không icon.
- Produces: không có — thay đổi render thuần.

- [ ] **Step 1: Render icon vương miện**

Trong `displaySavedEvents`, ngay SAU dòng `const owned = !!(ownedByCode && ownedByCode[event.event_code]);`, thêm:

```javascript
                // Icon nhận biết event do mình tạo (HTML tĩnh, không dữ liệu user)
                const ownerBadge = owned
                    ? '<i class="fas fa-crown text-warning me-1" title="Sự kiện của bạn"></i>'
                    : '';
```

Và đổi dòng tiêu đề trong template string:

```javascript
                            <h5 class="mb-1">${escapeHtml(event.title)}</h5>
```

thành:

```javascript
                            <h5 class="mb-1">${ownerBadge}${escapeHtml(event.title)}</h5>
```

- [ ] **Step 2: Verify**

```bash
node --check static/app.js
```

Expected: sạch. Smoke test tay (nếu có browser): mở "Sự Kiện Của Tôi" khi đăng nhập — event mình tạo có vương miện vàng trước tên.

- [ ] **Step 3: Cập nhật `CLAUDE.md`**

(a) Trong bullet **"Sự Kiện Của Tôi"** (Auth model), sau câu về `POST /api/my-events/save`, thêm câu:

```
`GET /api/events/<code>` trả thêm cờ `is_saved` (đã đăng nhập và đã lưu) — nút "Theo dõi / Bỏ theo dõi" (`#followEventBtn`, chỉ hiện khi không phải owner) dựa vào cờ này; KHÔNG còn auto-lưu khi mở event.
```

(b) Trong đoạn **Frontend**, câu nói về danh sách khi đăng nhập (bắt đầu "Logged in: the list comes from `GET /api/my-events`..."), thêm vào cuối câu mô tả nút action:

```
event `owned` có icon vương miện (`fa-crown text-warning`) trước tên; vào danh sách bằng nút Theo dõi trên header event (không còn auto-lưu `rememberEvent`).
```

- [ ] **Step 4: Commit**

```bash
git add static/app.js CLAUDE.md
git commit -m "feat(ui): icon vương miện cho event mình tạo + cập nhật docs"
```
