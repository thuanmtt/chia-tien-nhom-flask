# Lưu người hưởng đích danh cho mọi khoản chi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bỏ ngữ nghĩa `'all'` động — mọi khoản chi luôn tính theo danh sách người hưởng đích danh đã lưu; kèm migration một lần dọn dữ liệu cũ.

**Architecture:** Đổi luật tính trong `static/split.js` (danh sách đã lưu thắng `benefitType`), chuẩn hóa lười khi tải event ở `static/app.js`, đảo hộp thoại thêm thành viên, luật xóa thành viên mới, và script `migrate_beneficiaries.py` chạy một lần trên DB. Backend Flask KHÔNG đổi.

**Tech Stack:** Vanilla JS (jQuery/Bootstrap, không bundler), Node test script thuần (`test_split.js`), Python + psycopg2 cho migration.

**Spec:** `docs/superpowers/specs/2026-08-13-per-member-beneficiaries-design.md` (đã duyệt).

## Global Constraints

- UI text, comment, commit message: tiếng Việt.
- XSS: mọi dữ liệu người dùng render qua `escapeHtml()` / jQuery `.text()`/`.val()`; message của `showConfirm`/`showToast` đã dùng `.text()` nội bộ — truyền chuỗi thô, KHÔNG tự nối HTML.
- Autosave: mỗi hành động thay đổi dữ liệu gọi `saveEvent(false)` đúng MỘT lần; không thêm save vào đường render/tải.
- `#confirmModal` phải là modal CUỐI trong DOM — không đụng vị trí.
- KHÔNG sửa backend (`vercel_app.py`, `validation.py`, `event_store.py`); script migration là file độc lập.
- `static/split.js` là UMD thuần không DOM — test bằng `node test_split.js`.
- Sau mỗi task: `node --check static/app.js && node --check static/split.js` phải sạch.
- Làm việc trên nhánh `per-member-beneficiaries` (đã có, chứa spec).

## File Structure

- Modify: `static/split.js` — luật tính + 3 helper mới, xóa `freezeAllExpenses`.
- Modify: `test_split.js` — đảo/thêm/xóa test tương ứng.
- Modify: `static/app.js` — tải event, form chi phí, hiển thị, thêm/xóa thành viên.
- Create: `migrate_beneficiaries.py` — script dọn DB một lần (repo root).
- Modify: `CLAUDE.md`, `CHANGELOG.md` — tài liệu.

---

### Task 1: split.js — luật tính snapshot-first

**Files:**
- Modify: `static/split.js:30-42` (`getExpenseBeneficiaries`)
- Test: `test_split.js`

**Interfaces:**
- Produces: `getExpenseBeneficiaries(expense, members)` — trả mảng người hưởng: danh sách `expense.beneficiaries` đã lưu (lọc theo `members` còn tồn tại) nếu còn ≥1 tên, bất kể `benefitType`; ngược lại trả `members` (fallback). Các task sau và `computeSplit` dựa vào đúng ngữ nghĩa này.

- [ ] **Step 1: Đảo test ngữ nghĩa 'all' trong `test_split.js`**

Thay NGUYÊN VĂN test ở `test_split.js:75-85`:

```js
test("benefitType 'all' dùng danh sách thành viên HIỆN TẠI, không dùng snapshot", () => {
    // Chi phí tạo lúc chỉ có A, B (beneficiaries snapshot cũ) — sau đó thêm C
    const r = S.computeSplit({
        members: ['A', 'B', 'C'],
        expenses: [{ title: 'ăn', amount: 90000, payer: 'A', benefitType: 'all', beneficiaries: ['A', 'B'] }],
    });
    // C cũng phải chia: mỗi người 30000 → B và C mỗi người chuyển A 30000
    assert.strictEqual(r.roundedBalances['C'], -30000);
    assert.strictEqual(r.transfers.length, 2);
    assertTransfersSettle(r);
});
```

bằng:

```js
test("khoản chi có snapshot beneficiaries: dùng snapshot, bất kể benefitType 'all'", () => {
    // Chi phí tạo lúc chỉ có A, B (snapshot đã lưu) — C vào nhóm sau
    const r = S.computeSplit({
        members: ['A', 'B', 'C'],
        expenses: [{ title: 'ăn', amount: 90000, payer: 'A', benefitType: 'all', beneficiaries: ['A', 'B'] }],
    });
    // C KHÔNG bị chia: chỉ B nợ A 45000
    assert.strictEqual(r.roundedBalances['C'], 0);
    assert.deepStrictEqual(r.transfers, [{ from: 'B', to: 'A', amount: 45000 }]);
    assertTransfersSettle(r);
});

test('khoản chi KHÔNG có snapshot (thiếu/rỗng): fallback danh sách hiện tại', () => {
    const r = S.computeSplit({
        members: ['A', 'B', 'C'],
        expenses: [
            { title: 'x', amount: 30000, payer: 'A', benefitType: 'all' },
            { title: 'y', amount: 30000, payer: 'A', benefitType: 'all', beneficiaries: [] },
        ],
    });
    // Cả 2 khoản chia đều 3 người: B và C mỗi người nợ A 20000
    assert.strictEqual(r.roundedBalances['B'], -20000);
    assert.strictEqual(r.roundedBalances['C'], -20000);
    assertTransfersSettle(r);
});

test('snapshot toàn tên đã xóa: fallback danh sách hiện tại', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [{ title: 'cũ', amount: 60000, payer: 'A', benefitType: 'all', beneficiaries: ['X', 'Y'] }],
    });
    assert.deepStrictEqual(r.transfers, [{ from: 'B', to: 'A', amount: 30000 }]);
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL đúng lý do**

Run: `node test_split.js`
Expected: test "dùng snapshot" FAIL (`roundedBalances['C']` là -30000 thay vì 0) vì code hiện tại bỏ qua snapshot khi `benefitType !== 'selected'`. 2 test fallback PASS sẵn (hành vi fallback không đổi) — chấp nhận, chúng khóa hành vi khỏi hồi quy.

- [ ] **Step 3: Sửa `getExpenseBeneficiaries` trong `static/split.js`**

Thay NGUYÊN VĂN khối (dòng 30-42):

```js
    // Người hưởng của một chi phí:
    // - 'all' (hoặc thiếu benefitType): LUÔN là danh sách thành viên HIỆN TẠI,
    //   không dùng snapshot lúc tạo — để thành viên thêm sau vẫn được chia
    //   vào các khoản "cho tất cả" đúng như UI hiển thị
    // - 'selected': danh sách đã chọn, lọc theo thành viên còn tồn tại
    function getExpenseBeneficiaries(expense, members) {
        if (expense && expense.benefitType === 'selected'
            && Array.isArray(expense.beneficiaries) && expense.beneficiaries.length > 0) {
            const valid = expense.beneficiaries.filter(m => members.includes(m));
            if (valid.length > 0) return valid;
        }
        return members;
    }
```

bằng:

```js
    // Người hưởng của một chi phí: LUÔN là danh sách beneficiaries đã lưu
    // (lọc theo thành viên còn tồn tại), bất kể benefitType — khoản 'all'
    // legacy được hiểu theo snapshot lúc tạo. Chỉ fallback về danh sách
    // thành viên hiện tại khi thiếu/rỗng/toàn tên đã xóa (dữ liệu tay/cũ).
    function getExpenseBeneficiaries(expense, members) {
        if (expense && Array.isArray(expense.beneficiaries) && expense.beneficiaries.length > 0) {
            const valid = expense.beneficiaries.filter(m => members.includes(m));
            if (valid.length > 0) return valid;
        }
        return members;
    }
```

- [ ] **Step 4: Chạy test, xác nhận PASS toàn bộ**

Run: `node test_split.js`
Expected: tất cả PASS (các test cũ dùng 'all' KHÔNG kèm `beneficiaries` vẫn fallback như trước; 2 test `freezeAllExpenses` chưa bị đụng vẫn pass).

- [ ] **Step 5: Commit**

```bash
git add static/split.js test_split.js
git commit -m "feat: khoản chi có snapshot người hưởng thì luôn dùng snapshot, bỏ 'all' động

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: split.js — helper `normalizeExpenses`

**Files:**
- Modify: `static/split.js` (thêm hàm ngay TRƯỚC `getValidCouplesForMembers`, thêm export)
- Test: `test_split.js`

**Interfaces:**
- Consumes: ngữ nghĩa `getExpenseBeneficiaries` từ Task 1.
- Produces: `normalizeExpenses(expenses, members)` — sửa tại chỗ: mọi khoản `benefitType !== 'selected'` → `benefitType = 'selected'`, `beneficiaries` = snapshot đã lưu lọc theo `members` (rỗng thì copy `members`). Trả về SỐ khoản đã chuyển. Task 4 (app.js) gọi hàm này khi tải event.

- [ ] **Step 1: Viết test FAIL trong `test_split.js`** (thêm trước dòng `console.log` cuối file)

```js
test('normalizeExpenses: chuyển khoản không-selected thành selected theo snapshot, lọc tên chết', () => {
    const expenses = [
        { title: 'a', amount: 1, payer: 'A', benefitType: 'all', beneficiaries: ['A', 'B', 'Đã Xóa'] },
        { title: 'b', amount: 1, payer: 'B' }, // thiếu benefitType, không snapshot
        { title: 'c', amount: 1, payer: 'C', benefitType: 'selected', beneficiaries: ['C'] },
    ];
    const members = ['A', 'B', 'C'];
    const count = S.normalizeExpenses(expenses, members);
    assert.strictEqual(count, 2);
    assert.strictEqual(expenses[0].benefitType, 'selected');
    assert.deepStrictEqual(expenses[0].beneficiaries, ['A', 'B']); // lọc 'Đã Xóa'
    assert.strictEqual(expenses[1].benefitType, 'selected');
    assert.deepStrictEqual(expenses[1].beneficiaries, ['A', 'B', 'C']); // fallback
    // Copy, không giữ tham chiếu mảng members
    members.push('D');
    assert.deepStrictEqual(expenses[1].beneficiaries, ['A', 'B', 'C']);
    // Khoản 'selected' sẵn có: không đụng
    assert.deepStrictEqual(expenses[2].beneficiaries, ['C']);
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node test_split.js`
Expected: FAIL `S.normalizeExpenses is not a function`.

- [ ] **Step 3: Implement trong `static/split.js`** (đặt ngay trước comment `// Trả về map: memberName -> couple object`)

```js
    // Chuẩn hóa khi tải event: mọi khoản không-'selected' (dữ liệu 'all' cũ)
    // → 'selected' với snapshot đã lưu (lọc tên còn tồn tại; rỗng thì lấy
    // danh sách hiện tại). Sửa tại chỗ, trả về số khoản đã chuyển.
    function normalizeExpenses(expenses, members) {
        let count = 0;
        (expenses || []).forEach(e => {
            if (!e || e.benefitType === 'selected') return;
            const stored = Array.isArray(e.beneficiaries)
                ? e.beneficiaries.filter(m => (members || []).includes(m))
                : [];
            e.benefitType = 'selected';
            e.beneficiaries = stored.length > 0 ? stored : (members || []).slice();
            count++;
        });
        return count;
    }
```

và thêm vào khối `return` cuối file, sau dòng `getExpenseBeneficiaries: getExpenseBeneficiaries,`:

```js
        normalizeExpenses: normalizeExpenses,
```

- [ ] **Step 4: Chạy test, xác nhận PASS toàn bộ**

Run: `node test_split.js`

- [ ] **Step 5: Commit**

```bash
git add static/split.js test_split.js
git commit -m "feat: thêm normalizeExpenses — chuẩn hóa khoản 'all' cũ thành selected đích danh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: split.js — helper `countFullCoverage` + `addBeneficiaryToFullCoverage`

**Files:**
- Modify: `static/split.js` (thêm 2 hàm ngay sau `normalizeExpenses`, thêm exports)
- Test: `test_split.js`

**Interfaces:**
- Produces:
  - `countFullCoverage(expenses, prevMembers)` — số khoản chi mà danh sách người hưởng chứa ĐỦ mọi tên trong `prevMembers` (mảng không rỗng; rỗng → 0).
  - `addBeneficiaryToFullCoverage(expenses, prevMembers, newMember)` — thêm `newMember` vào cuối `beneficiaries` của đúng các khoản đó (bỏ qua nếu đã có tên); trả số khoản đã thêm.
  - Task 6 (app.js) dùng cả hai cho hộp thoại thêm thành viên.

- [ ] **Step 1: Viết test FAIL trong `test_split.js`** (thêm trước `console.log` cuối file)

```js
test('countFullCoverage/addBeneficiaryToFullCoverage: chỉ khoản phủ đủ thành viên cũ', () => {
    const expenses = [
        { title: 'chung', amount: 1, payer: 'A', benefitType: 'selected', beneficiaries: ['A', 'B'] },
        { title: 'riêng', amount: 1, payer: 'A', benefitType: 'selected', beneficiaries: ['A'] },
        { title: 'đã có', amount: 1, payer: 'B', benefitType: 'selected', beneficiaries: ['A', 'B', 'C'] },
    ];
    const prev = ['A', 'B'];
    assert.strictEqual(S.countFullCoverage(expenses, prev), 2); // 'chung' và 'đã có'
    const added = S.addBeneficiaryToFullCoverage(expenses, prev, 'C');
    assert.strictEqual(added, 1); // 'đã có' đã chứa C nên không thêm lại
    assert.deepStrictEqual(expenses[0].beneficiaries, ['A', 'B', 'C']);
    assert.deepStrictEqual(expenses[1].beneficiaries, ['A']); // khoản riêng không đụng
    assert.deepStrictEqual(expenses[2].beneficiaries, ['A', 'B', 'C']); // không trùng
    assert.strictEqual(S.countFullCoverage(expenses, []), 0); // prevMembers rỗng → 0
});
```

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `node test_split.js`
Expected: FAIL `S.countFullCoverage is not a function`.

- [ ] **Step 3: Implement trong `static/split.js`** (ngay sau `normalizeExpenses`)

```js
    // Khoản chi "phủ đủ" prevMembers = danh sách người hưởng chứa mọi tên
    // trong prevMembers (các khoản đang chia cho đủ mọi người cũ)
    function _coversAll(expense, prevMembers) {
        if (!prevMembers || prevMembers.length === 0) return false;
        const bens = (expense && Array.isArray(expense.beneficiaries)) ? expense.beneficiaries : [];
        return prevMembers.every(m => bens.includes(m));
    }

    function countFullCoverage(expenses, prevMembers) {
        return (expenses || []).filter(e => _coversAll(e, prevMembers)).length;
    }

    // Thêm newMember vào các khoản phủ đủ prevMembers (dùng khi người dùng
    // đồng ý chia các khoản "cho đủ mọi người" cho thành viên mới)
    function addBeneficiaryToFullCoverage(expenses, prevMembers, newMember) {
        let count = 0;
        (expenses || []).forEach(e => {
            if (!_coversAll(e, prevMembers)) return;
            if (!e.beneficiaries.includes(newMember)) {
                e.beneficiaries.push(newMember);
                count++;
            }
        });
        return count;
    }
```

và thêm exports sau `normalizeExpenses: normalizeExpenses,`:

```js
        countFullCoverage: countFullCoverage,
        addBeneficiaryToFullCoverage: addBeneficiaryToFullCoverage,
```

- [ ] **Step 4: Chạy test, xác nhận PASS toàn bộ**

Run: `node test_split.js`

- [ ] **Step 5: Commit**

```bash
git add static/split.js test_split.js
git commit -m "feat: helper đếm/thêm người hưởng cho các khoản chia đủ mọi người

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: app.js — chuẩn hóa khi tải + form luôn gửi 'selected'

**Files:**
- Modify: `static/app.js:793` (loadEventFromServer) và `static/app.js:2050-2060` (expenseData)

**Interfaces:**
- Consumes: `SplitLogic.normalizeExpenses(expenses, members)` (Task 2).
- Produces: sau khi tải, mảng `expenses` trong bộ nhớ chỉ còn `benefitType 'selected'` — các task hiển thị/xóa thành viên dựa vào bất biến này (vẫn giữ nhánh phòng thủ).

- [ ] **Step 1: Chuẩn hóa trong `loadEventFromServer`**

Trong `static/app.js`, thay:

```js
                        // Cập nhật chi phí
                        expenses = eventData.expenses || [];
```

bằng:

```js
                        // Cập nhật chi phí — chuẩn hóa dữ liệu 'all' cũ thành
                        // danh sách đích danh (ghi xuống DB ở lần lưu kế tiếp)
                        expenses = eventData.expenses || [];
                        SplitLogic.normalizeExpenses(expenses, members);
```

- [ ] **Step 2: Form chi phí luôn lưu 'selected'**

Trong `static/app.js` (khối `expenseData`, ~dòng 2050), thay:

```js
                benefitType: benefitType,
                beneficiaries: beneficiaries,
```

bằng:

```js
                // Luôn lưu đích danh; chọn "Tất cả" trên form chỉ là shortcut
                // chốt đủ thành viên tại thời điểm lưu
                benefitType: 'selected',
                beneficiaries: beneficiaries,
```

(Biến `benefitType` phía trên vẫn dùng cho nhánh `if (benefitType === 'all')` build danh sách — giữ nguyên.)

- [ ] **Step 3: Kiểm tra syntax**

Run: `node --check static/app.js`
Expected: sạch.

- [ ] **Step 4: Commit**

```bash
git add static/app.js
git commit -m "feat: chuẩn hóa khoản chi khi tải event; form luôn lưu người hưởng đích danh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: app.js — hiển thị tên đích danh, bỏ nhãn "Tất cả"

**Files:**
- Modify: `static/app.js:906-923` (filterExpenses), `1113-1120` (buildExpenseExportRows), `1458-1471` (benefitInfo trong renderExpenses), `3125` + `3149-3157` (điền form sửa)

**Interfaces:**
- Consumes: `getExpenseBeneficiaries(expense)` — wrapper cục bộ đã có ở `static/app.js:112-114` (gọi `SplitLogic.getExpenseBeneficiaries(expense, members)`), trả danh sách hưởng THỰC TẾ (đã lọc + fallback).

- [ ] **Step 1: Bộ lọc "Người hưởng" dùng danh sách thực tế**

Thay (dòng 909-914):

```js
                if (benef) {
                    // Đồng bộ với getExpenseBeneficiaries: không phải 'selected' = cho tất cả
                    const isAll = exp.benefitType !== 'selected';
                    const inList = (exp.beneficiaries || []).includes(benef);
                    if (!isAll && !inList) return false;
                }
```

bằng:

```js
                if (benef && !getExpenseBeneficiaries(exp).includes(benef)) return false;
```

- [ ] **Step 2: Xuất Excel/in luôn ghi tên đích danh**

Thay (dòng 1113-1120):

```js
                let beneficiaries;
                if (e.benefitType === 'all') {
                    beneficiaries = 'Tất cả';
                } else if (e.beneficiaries && e.beneficiaries.length) {
                    beneficiaries = e.beneficiaries.join(', ');
                } else {
                    beneficiaries = '';
                }
```

bằng:

```js
                // Luôn ghi tên đích danh (danh sách thực tế sau lọc/fallback)
                const beneficiaries = getExpenseBeneficiaries(e).join(', ');
```

- [ ] **Step 3: Dòng mô tả trong danh sách chi phí**

Thay (dòng 1458-1471):

```js
                let benefitInfo = '';
                if (expense.benefitType === 'all') {
                    benefitInfo = 'cho tất cả mọi người';
                } else if (expense.beneficiaries && expense.beneficiaries.length > 0) {
                    if (expense.beneficiaries.length === 1) {
                        benefitInfo = `chỉ cho ${expense.beneficiaries[0]}`;
                    } else if (expense.beneficiaries.length === 2) {
                        benefitInfo = `cho ${expense.beneficiaries.join(' và ')}`;
                    } else if (expense.beneficiaries.length < members.length) {
                        benefitInfo = `cho ${expense.beneficiaries.length} người: (${expense.beneficiaries.join(', ')})`;
                    } else {
                        benefitInfo = 'cho tất cả mọi người';
                    }
                }
```

bằng:

```js
                // Luôn nêu tên đích danh — không còn nhãn "tất cả" ẩn danh
                let benefitInfo = '';
                const bens = getExpenseBeneficiaries(expense);
                if (bens.length === 1) {
                    benefitInfo = `chỉ cho ${bens[0]}`;
                } else if (bens.length === 2) {
                    benefitInfo = `cho ${bens.join(' và ')}`;
                } else if (bens.length > 2) {
                    benefitInfo = `cho ${bens.length} người: (${bens.join(', ')})`;
                }
```

(`benefitInfo` đi qua `escapeHtml(benefitInfo)` sẵn có ở dòng 1509 — giữ nguyên.)

- [ ] **Step 4: Form sửa chi phí hiện danh sách thực tế**

Thay (dòng 3125):

```js
            $('#benefitType').val(expense.benefitType || 'all').trigger('change');
```

bằng:

```js
            // Dữ liệu đã chuẩn hóa — form sửa luôn ở chế độ chọn đích danh
            $('#benefitType').val('selected').trigger('change');
```

Thay (dòng 3149-3157):

```js
            // Nếu là chi tiêu cho một số người, chọn lại các checkbox
            if (expense.benefitType === 'selected' && Array.isArray(expense.beneficiaries)) {
                // Bỏ trạng thái cũ trước, rồi tick theo value (an toàn với tên có dấu/khoảng trắng)
                $('#beneficiariesList .beneficiary-checkbox').prop('checked', false);
                const wanted = new Set(expense.beneficiaries);
                $('#beneficiariesList .beneficiary-checkbox').each(function () {
                    if (wanted.has(this.value)) this.checked = true;
                });
            }
```

bằng:

```js
            // Tick theo danh sách hưởng thực tế (đã lọc + fallback)
            // — an toàn với tên có dấu/khoảng trắng nhờ so theo value
            $('#beneficiariesList .beneficiary-checkbox').prop('checked', false);
            const wanted = new Set(getExpenseBeneficiaries(expense));
            $('#beneficiariesList .beneficiary-checkbox').each(function () {
                if (wanted.has(this.value)) this.checked = true;
            });
```

- [ ] **Step 5: Kiểm tra syntax + test**

Run: `node --check static/app.js && node test_split.js`
Expected: sạch, tất cả test pass.

- [ ] **Step 6: Commit**

```bash
git add static/app.js
git commit -m "feat: hiển thị người hưởng đích danh mọi nơi, bỏ nhãn 'Tất cả'

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: app.js — đảo hộp thoại thêm thành viên, gỡ `freezeAllExpenses`

**Files:**
- Modify: `static/app.js:1902-1950` (`#memberForm` submit), `static/split.js` (xóa `freezeAllExpenses` + export)
- Test: `test_split.js` (xóa 2 test `freezeAllExpenses`)

**Interfaces:**
- Consumes: `SplitLogic.countFullCoverage(expenses, prevMembers)`, `SplitLogic.addBeneficiaryToFullCoverage(expenses, prevMembers, newMember)` (Task 3); `showConfirm(message, onConfirm, {okLabel, okClass, cancelLabel})` sẵn có.

- [ ] **Step 1: Thay handler `#memberForm`**

Thay NGUYÊN VĂN khối `else` (dòng 1912-1946, từ `} else {` chứa `const prevMembers` đến hết `}` trước `} else {` của nhánh thiếu tên):

```js
                } else {
                    // Danh sách CŨ trước khi thêm — để nhận diện các khoản
                    // đang chia cho đủ mọi người
                    const prevMembers = members.slice();
                    members.push(memberName);
                    renderMembers();
                    $('#memberName').val('');

                    // Tự động lưu sau khi thêm thành viên
                    saveEvent(false);
                    showToast(`Đã thêm thành viên "${memberName}"!`, 'success');
                    // Không cần gọi autoCalculate() vì đã được gọi trong renderMembers()

                    // Mọi khoản chi lưu người hưởng đích danh — người mới KHÔNG
                    // tự được chia vào khoản cũ. Nếu có khoản đang chia cho đủ
                    // thành viên cũ thì hỏi có chia thêm không; đóng hộp thoại
                    // (Hủy/ESC) = không đụng gì.
                    const fullCount = SplitLogic.countFullCoverage(expenses, prevMembers);
                    if (fullCount > 0) {
                        showConfirm(
                            `Có ${fullCount} khoản chi đang chia cho đủ mọi người. Chia thêm cho "${memberName}" không?`,
                            function () {
                                const added = SplitLogic.addBeneficiaryToFullCoverage(expenses, prevMembers, memberName);
                                renderExpenses(); // đã gọi autoCalculate() bên trong
                                saveEvent(false);
                                showToast(`Đã chia thêm ${added} khoản chi cho "${memberName}".`, 'success');
                            },
                            {
                                okLabel: `Có, chia cho "${memberName}"`,
                                okClass: 'btn-primary',
                                cancelLabel: 'Không',
                            }
                        );
                    }
                }
```

- [ ] **Step 2: Xóa `freezeAllExpenses` khỏi `static/split.js`**

Xóa nguyên khối hàm (comment 4 dòng bắt đầu `// "Chốt" các khoản đang chia cho tất cả` + hàm `freezeAllExpenses`) và dòng export `freezeAllExpenses: freezeAllExpenses,`.

- [ ] **Step 3: Xóa 2 test `freezeAllExpenses` khỏi `test_split.js`**

Xóa nguyên văn 2 khối `test("freezeAllExpenses: chốt các khoản 'tất cả' ...")` và `test('freezeAllExpenses: thêm thành viên mới sau khi chốt ...')`.

- [ ] **Step 4: Xác nhận không còn tham chiếu**

Run: `grep -rn freezeAllExpenses static/ test_split.js || echo "sạch"`
Expected: `sạch`.

- [ ] **Step 5: Kiểm tra syntax + test**

Run: `node --check static/app.js && node --check static/split.js && node test_split.js`
Expected: sạch, tất cả test pass.

- [ ] **Step 6: Commit**

```bash
git add static/app.js static/split.js test_split.js
git commit -m "feat: thêm thành viên hỏi chia thêm vào khoản chung, gỡ freezeAllExpenses

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: app.js — luật xóa thành viên mới

**Files:**
- Modify: `static/app.js:1952-1987` (handler `.member-close`)

**Interfaces:**
- Consumes: `getExpenseBeneficiaries(expense)` wrapper cục bộ; `showConfirm`.
- Luật: payer → chặn; người hưởng DUY NHẤT của khoản nào đó → chặn; có mặt trong khoản chi → xác nhận rồi gỡ tên khỏi mọi danh sách; không dính khoản nào → xóa thẳng.

- [ ] **Step 1: Thay NGUYÊN VĂN handler `.member-close`** (dòng 1952-1987)

```js
        // Xử lý xóa thành viên
        $(document).on('click', '.member-close', function () {
            if (!allowEdit) return; // Không cho phép xóa nếu ở chế độ chỉ xem

            const index = $(this).data('index');
            const memberToRemove = members[index];

            // Người thanh toán của khoản nào đó → phải xử lý khoản chi trước
            if (expenses.some(expense => expense.payer === memberToRemove)) {
                showToast('Không thể xóa thành viên này vì họ là người thanh toán của chi phí trong danh sách. Vui lòng xóa/sửa chi phí trước!', 'error');
                return;
            }

            // Người hưởng DUY NHẤT của khoản nào đó → xóa làm khoản chi mất nghĩa
            const soleTitles = expenses
                .filter(expense => {
                    const bens = getExpenseBeneficiaries(expense);
                    return bens.length === 1 && bens[0] === memberToRemove;
                })
                .map(expense => expense.title || '(không tên)');
            if (soleTitles.length > 0) {
                showToast(`Không thể xóa "${memberToRemove}" — là người hưởng duy nhất của: ${soleTitles.join(', ')}. Vui lòng sửa/xóa các khoản đó trước!`, 'error');
                return;
            }

            const benefitCount = expenses.filter(expense =>
                Array.isArray(expense.beneficiaries) && expense.beneficiaries.includes(memberToRemove)).length;

            const doRemove = function () {
                // Gỡ tên khỏi danh sách người hưởng của mọi khoản chi
                expenses.forEach(expense => {
                    if (Array.isArray(expense.beneficiaries)) {
                        expense.beneficiaries = expense.beneficiaries.filter(m => m !== memberToRemove);
                    }
                });

                members.splice(index, 1);

                // Dọn khỏi các nhóm chung quỹ
                couples = (couples || []).map(c => {
                    const remaining = (c.members || []).filter(m => m !== memberToRemove);
                    const primary = remaining.includes(c.primary) ? c.primary : (remaining[0] || '');
                    return { ...c, members: remaining, primary };
                }).filter(c => c.members.length >= 2);

                renderMembers();
                renderExpenses(); // cập nhật cột người hưởng + autoCalculate

                // Tự động lưu sau khi xóa thành viên
                saveEvent(false);
                showToast(`Đã xoá thành viên "${memberToRemove}"!`, 'success');
            };

            if (benefitCount > 0) {
                showConfirm(`Gỡ "${memberToRemove}" khỏi ${benefitCount} khoản chi và xóa khỏi nhóm?`, doRemove, { okLabel: 'Gỡ và xóa' });
            } else {
                doRemove();
            }
        });
```

- [ ] **Step 2: Kiểm tra syntax**

Run: `node --check static/app.js`
Expected: sạch.

- [ ] **Step 3: Commit**

```bash
git add static/app.js
git commit -m "feat: xóa thành viên gỡ tên khỏi các khoản chi kèm xác nhận

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `migrate_beneficiaries.py` — script dọn DB một lần

**Files:**
- Create: `migrate_beneficiaries.py` (repo root)

**Interfaces:**
- Consumes: `DATABASE_URL` từ `.env` (python-dotenv), bảng `expenses(id, event_id, benefit_type)`, `expense_beneficiaries(expense_id, member_name, position)`, `members(event_id, name, position)` — xem `schema.sql:27-54`.
- KHÔNG bump `events.updated_at`, KHÔNG ghi `event_revisions`. Idempotent. `--dry-run` in số liệu rồi rollback.

- [ ] **Step 1: Viết script**

```python
#!/usr/bin/env python3
"""Dọn dữ liệu một lần: chuyển mọi khoản chi benefit_type != 'selected' ('all' cũ)
thành 'selected' với danh sách người hưởng đích danh.

- Khoản đã có snapshot trong expense_beneficiaries: giữ nguyên snapshot, chỉ đổi type.
- Khoản chưa có snapshot: chèn theo danh sách thành viên HIỆN TẠI của event.
- KHÔNG bump events.updated_at (tránh 409 cho tab đang mở), KHÔNG ghi event_revisions
  (dọn dữ liệu, không phải hành động người dùng). Idempotent — chạy lại vô hại.

Chạy SAU khi deploy client mới (thứ tự bắt buộc — xem spec
docs/superpowers/specs/2026-08-13-per-member-beneficiaries-design.md):
    python3 migrate_beneficiaries.py --dry-run   # xem trước, rollback
    python3 migrate_beneficiaries.py             # chạy thật
"""
import os
import sys

import psycopg2
from dotenv import load_dotenv


def main():
    load_dotenv()
    dry_run = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        cur = conn.cursor()

        # Khoản 'all' CHƯA có snapshot → chèn theo danh sách thành viên hiện tại
        cur.execute(
            '''INSERT INTO expense_beneficiaries (expense_id, member_name, position)
               SELECT e.id, m.name, m.position
               FROM expenses e
               JOIN members m ON m.event_id = e.event_id
               WHERE e.benefit_type <> 'selected'
                 AND NOT EXISTS (
                     SELECT 1 FROM expense_beneficiaries b WHERE b.expense_id = e.id
                 )'''
        )
        inserted = cur.rowcount

        cur.execute("UPDATE expenses SET benefit_type = 'selected' WHERE benefit_type <> 'selected'")
        updated = cur.rowcount

        print(f'Chèn {inserted} dòng người hưởng; chuyển {updated} khoản chi sang selected.')
        if dry_run:
            conn.rollback()
            print('Dry-run: đã rollback, DB không đổi.')
        else:
            conn.commit()
            print('Đã commit.')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Chạy dry-run xác minh trên DB thật**

Run: `python3 migrate_beneficiaries.py --dry-run`
Expected: in 2 số đếm (>0 nếu DB còn khoản 'all') + `Dry-run: đã rollback, DB không đổi.` — KHÔNG chạy bản thật ở bước này (thứ tự deploy: chỉ chạy thật sau khi client mới lên prod).

- [ ] **Step 3: Chạy lại dry-run lần nữa để xác nhận idempotent**

Run: `python3 migrate_beneficiaries.py --dry-run`
Expected: số liệu giống hệt lần trước (rollback nên không đổi).

- [ ] **Step 4: Commit**

```bash
git add migrate_beneficiaries.py
git commit -m "feat: script dọn một lần — chuyển khoản 'all' cũ sang selected đích danh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Cập nhật CLAUDE.md + CHANGELOG.md

**Files:**
- Modify: `CLAUDE.md` (đoạn "Beneficiaries semantics" cuối mục **Money model**)
- Modify: `CHANGELOG.md` (entry mới trên cùng)

- [ ] **Step 1: CLAUDE.md** — thay NGUYÊN VĂN đoạn (cuối mục Money model):

```
Beneficiaries semantics: `benefitType === 'all'` means the CURRENT member list at calculation time (the stored `beneficiaries` snapshot is ignored — see `getExpenseBeneficiaries()`); only `'selected'` uses the stored list. Vì vậy khi THÊM thành viên mà đang có khoản "Tất cả", `#memberForm` hỏi qua `showConfirm` có chia cho người mới không — chọn "Không chia" thì `SplitLogic.freezeAllExpenses(expenses, prevMembers)` chốt các khoản đó thành `'selected'` theo danh sách TRƯỚC khi thêm (đóng hộp thoại = giữ hành vi chia động).
```

bằng:

```
Beneficiaries semantics: mọi khoản chi lưu danh sách người hưởng ĐÍCH DANH — `getExpenseBeneficiaries()` luôn dùng `beneficiaries` đã lưu (lọc theo thành viên còn tồn tại), bất kể `benefitType`; chỉ fallback về danh sách hiện tại khi thiếu/rỗng. Form luôn lưu `benefitType: 'selected'` ("Tất cả" trên form chỉ là shortcut chốt đủ người lúc lưu); dữ liệu `'all'` cũ được `normalizeExpenses()` chuẩn hóa khi tải event và `migrate_beneficiaries.py` dọn một lần trên DB (đã chạy sau deploy). Thêm thành viên: hỏi có chia thêm vào các khoản đang phủ đủ thành viên cũ không (`countFullCoverage`/`addBeneficiaryToFullCoverage`, mặc định KHÔNG). Xóa thành viên: gỡ tên khỏi các khoản chi kèm xác nhận; chặn nếu là người thanh toán hoặc người hưởng duy nhất của khoản nào đó.
```

- [ ] **Step 2: CHANGELOG.md** — thêm entry mới ngay sau dòng `# Changelog`:

```markdown
## 2026-08-13 — Người hưởng đích danh cho mọi khoản chi

- Mọi khoản chi giờ lưu rõ chia cho AI — không còn kiểu "Tất cả" tự động chia
  lại khi nhóm thay đổi. Chọn "Tất cả" khi nhập chỉ là cách tick nhanh đủ mọi
  người tại thời điểm đó.
- Thêm thành viên mới: app hỏi có chia thêm người đó vào các khoản đang chia
  cho đủ mọi người không (mặc định KHÔNG — đóng hộp thoại là không đụng gì).
- Xóa thành viên: tự gỡ tên khỏi các khoản chi kèm xác nhận; chặn nếu là người
  thanh toán hoặc người hưởng duy nhất của một khoản.
- Dữ liệu cũ kiểu "Tất cả" được chuyển theo danh sách lúc tạo khoản chi
  (script dọn một lần trên DB).
- Danh sách chi phí + xuất Excel luôn hiện tên người hưởng cụ thể.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: cập nhật CLAUDE.md/CHANGELOG — người hưởng đích danh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Verify tổng thể

**Files:** không sửa file (chỉ chạy kiểm tra; sửa nếu fail).

- [ ] **Step 1: Toàn bộ kiểm tra thuần**

Run:
```bash
node --check static/app.js && node --check static/split.js && node --check static/sw.js && node --check static/auth.js \
  && node test_split.js \
  && python3 test_event_store.py && python3 test_revision_diff.py && python3 test_supabase_auth.py
```
Expected: tất cả pass; `node test_split.js` không còn test freezeAllExpenses, có các test mới.

- [ ] **Step 2: Xác nhận không còn nhánh ĐỌC ngữ nghĩa cũ từ dữ liệu expense**

Run: `grep -n "\.benefitType" static/app.js`
Expected: KHÔNG còn dòng nào đọc `expense.benefitType`/`exp.benefitType`/`e.benefitType` để rẽ nhánh hiển thị/lọc. Cho phép còn lại DUY NHẤT các tham chiếu thuộc form nhập: `$('#benefitType')` (jQuery select — không khớp pattern này) và biến cục bộ `benefitType` trong submit handler (`const benefitType = ...`, `if (benefitType === 'all')` — cũng không khớp pattern `\.benefitType`). Nếu grep ra kết quả nào → còn sót nhánh cũ, phải xử lý trước khi qua bước sau.

- [ ] **Step 3: Integration test với server thật (tùy chọn nhưng khuyến khích)**

Run:
```bash
python3 vercel_app.py &
sleep 3
python3 test_api.py; kill %1
```
Expected: test_api.py pass (tạo + xóa event thật trên Supabase; cần `.env` đầy đủ). Nếu môi trường không cho chạy server nền thì ghi rõ đã bỏ qua bước này khi báo cáo.

- [ ] **Step 4: Commit nếu có sửa gì từ các bước trên** (message mô tả đúng nội dung sửa).

---

## Deploy (sau khi merge — làm theo thứ tự, KHÔNG đảo)

1. Merge `per-member-beneficiaries` vào `master`, push → Vercel tự deploy.
2. Xác minh prod: `curl -s https://chia-tien-nhom.vercel.app/static/split.js | grep -c normalizeExpenses` → ≥1.
3. Chạy thật: `python3 migrate_beneficiaries.py` (một lần).
4. Spot-check: sự kiện từng bị bug hiển thị 2 khoản cũ chia đúng 3 người ban đầu.
