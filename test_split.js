#!/usr/bin/env node
// Unit test cho logic chia tiền (static/split.js) — chạy: node test_split.js
'use strict';

const assert = require('assert');
const S = require('./static/split.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        console.error(`❌ ${name}`);
        console.error(err.message);
        process.exitCode = 1;
    }
}

// Với mỗi kết quả: kiểm tra các giao dịch tất toán CHÍNH XÁC số dư đã làm tròn
// (người dư dương nhận đủ, người dư âm trả đủ — không lệch đồng nào)
function assertTransfersSettle(result) {
    const net = {};
    Object.keys(result.roundedBalances).forEach(m => { net[m] = 0; });
    result.transfers.forEach(t => {
        assert.ok(Number.isInteger(t.amount) && t.amount > 0, `số tiền giao dịch phải là số nguyên dương: ${t.amount}`);
        net[t.from] -= t.amount;
        net[t.to] += t.amount;
    });
    // Người dư dương (+) nhận đúng bằng số dư; người dư âm (−) trả đúng bằng số nợ
    Object.keys(result.roundedBalances).forEach(m => {
        assert.strictEqual(net[m], result.roundedBalances[m],
            `giao dịch không tất toán đúng cho ${m}: net=${net[m]}, balance=${result.roundedBalances[m]}`);
    });
}

test('chia đều 2 người: B nợ A một nửa', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [{ title: 'ăn', amount: 100000, payer: 'A', benefitType: 'all' }],
    });
    assert.deepStrictEqual(r.missingRates, []);
    assert.deepStrictEqual(r.transfers, [{ from: 'B', to: 'A', amount: 50000 }]);
    assert.strictEqual(r.totalExpense, 100000);
});

test('làm tròn 100000/3: tổng giao dịch khớp chính xác số dư, không lệch 1 đồng', () => {
    const r = S.computeSplit({
        members: ['A', 'B', 'C'],
        expenses: [{ title: 'ăn', amount: 100000, payer: 'A', benefitType: 'all' }],
    });
    // Tổng số dư nguyên phải bằng 0 sau khi khử drift
    const sum = Object.values(r.roundedBalances).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 0, `tổng số dư phải = 0, được ${sum}`);
    assertTransfersSettle(r);
});

test('nhiều khoản chia lẻ: mọi giao dịch vẫn tất toán chính xác', () => {
    const r = S.computeSplit({
        members: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        expenses: [
            { title: 'x1', amount: 100000, payer: 'A', benefitType: 'all' },
            { title: 'x2', amount: 70001, payer: 'B', benefitType: 'selected', beneficiaries: ['B', 'C', 'D'] },
            { title: 'x3', amount: 33333, payer: 'C', benefitType: 'selected', beneficiaries: ['A', 'E'] },
            { title: 'x4', amount: 999999, payer: 'D', benefitType: 'all' },
            { title: 'x5', amount: 12347, payer: 'E', benefitType: 'selected', beneficiaries: ['F', 'G', 'A', 'B', 'E'] },
        ],
    });
    const sum = Object.values(r.roundedBalances).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 0);
    assertTransfersSettle(r);
});

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

test("benefitType 'selected' chỉ chia cho người được chọn còn tồn tại", () => {
    const r = S.computeSplit({
        members: ['A', 'B', 'C'],
        expenses: [{
            title: 'taxi', amount: 60000, payer: 'A',
            benefitType: 'selected', beneficiaries: ['A', 'B', 'Đã Xóa'],
        }],
    });
    // 'Đã Xóa' không còn → chia cho A, B mỗi người 30000; C không liên quan
    assert.strictEqual(r.roundedBalances['C'], 0);
    assert.deepStrictEqual(r.transfers, [{ from: 'B', to: 'A', amount: 30000 }]);
});

test('nhóm chung quỹ: gộp về người đại diện, chỉ đại diện xuất hiện trong giao dịch', () => {
    const r = S.computeSplit({
        members: ['Chồng', 'Vợ', 'Bạn'],
        couples: [{ id: 'c1', members: ['Chồng', 'Vợ'], primary: 'Chồng' }],
        expenses: [{ title: 'ăn', amount: 90000, payer: 'Chồng', benefitType: 'all' }],
    });
    // Mỗi người 30000; vợ chồng gộp: +90000 - 60000 = +30000 cho Chồng
    assert.strictEqual(r.roundedBalances['Chồng'], 30000);
    assert.strictEqual(r.roundedBalances['Vợ'], 0);
    assert.deepStrictEqual(r.transfers, [{ from: 'Bạn', to: 'Chồng', amount: 30000 }]);
});

test('ngoại tệ có tỷ giá: quy đổi đúng về VND', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        rates: { USD: { rate: 25000 } },
        expenses: [{ title: 'vé', amount: 10, currency: 'USD', payer: 'A', benefitType: 'all' }],
    });
    assert.strictEqual(r.totalExpense, 250000);
    assert.deepStrictEqual(r.transfers, [{ from: 'B', to: 'A', amount: 125000 }]);
});

test('thiếu tỷ giá: trả về missingRates, không tính toán', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [
            { title: 'vé', amount: 10, currency: 'USD', payer: 'A', benefitType: 'all' },
            { title: 'ăn', amount: 100, currency: 'THB', payer: 'B', benefitType: 'all' },
        ],
    });
    assert.deepStrictEqual(r.missingRates, ['USD', 'THB']);
    assert.strictEqual(r.transfers, undefined);
});

test('payer không còn trong danh sách: bỏ qua, không sinh NaN', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [{ title: 'cũ', amount: 50000, payer: 'Người Đã Xóa', benefitType: 'all' }],
    });
    Object.values(r.roundedBalances).forEach(v => assert.ok(Number.isFinite(v)));
    // Dữ liệu mất cân bằng (tiền trả bị mất) → không "sửa hộ" drift
    assert.strictEqual(r.roundedBalances['A'], -25000);
    assert.strictEqual(r.roundedBalances['B'], -25000);
});

test('không có chi phí chênh lệch: không cần chuyển tiền', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [
            { title: 'x', amount: 50000, payer: 'A', benefitType: 'all' },
            { title: 'y', amount: 50000, payer: 'B', benefitType: 'all' },
        ],
    });
    assert.deepStrictEqual(r.transfers, []);
});

test('memberInfo: paid/needToPay đúng cho bảng tổng quan', () => {
    const r = S.computeSplit({
        members: ['A', 'B'],
        expenses: [{ title: 'ăn', amount: 100000, payer: 'A', benefitType: 'all' }],
    });
    assert.strictEqual(r.memberInfo['A'].paid, 100000);
    assert.strictEqual(r.memberInfo['A'].needToPay, 50000);
    assert.strictEqual(r.memberInfo['B'].paid, 0);
    assert.strictEqual(r.memberInfo['B'].needToPay, 50000);
});

test('fuzz nhẹ: 50 bộ dữ liệu ngẫu nhiên-xác-định luôn tất toán chính xác', () => {
    // PRNG xác định để test lặp lại được
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let round = 0; round < 50; round++) {
        const members = names.slice(0, 2 + Math.floor(rand() * 5));
        const expenses = [];
        const n = 1 + Math.floor(rand() * 8);
        for (let k = 0; k < n; k++) {
            const payer = members[Math.floor(rand() * members.length)];
            const selected = rand() < 0.5;
            const bens = selected
                ? members.filter(() => rand() < 0.6)
                : [];
            expenses.push({
                title: 't' + k,
                amount: 1 + Math.floor(rand() * 1000000),
                payer,
                benefitType: selected && bens.length ? 'selected' : 'all',
                beneficiaries: bens,
            });
        }
        const r = S.computeSplit({ members, expenses });
        const sum = Object.values(r.roundedBalances).reduce((a, b) => a + b, 0);
        assert.strictEqual(sum, 0, `round ${round}: tổng số dư ${sum} != 0`);
        assertTransfersSettle(r);
    }
});

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
    // Copy, không giữ tham chiếu mảy members
    members.push('D');
    assert.deepStrictEqual(expenses[1].beneficiaries, ['A', 'B', 'C']);
    // Khoản 'selected' sẵn có: không đụng
    assert.deepStrictEqual(expenses[2].beneficiaries, ['C']);
});

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

console.log(`\n${passed} test passed${process.exitCode ? ' (CÓ TEST FAIL)' : ' — tất cả OK'}`);
