// Logic chia tiền thuần (không phụ thuộc DOM/jQuery) — dùng chung cho
// app.js (trình duyệt, qua window.SplitLogic) và test_split.js (Node).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SplitLogic = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 1 đơn vị ngoại tệ = bao nhiêu VND; null = chưa có tỷ giá
    function getRateToVND(currencyCode, rates) {
        if (!currencyCode || currencyCode === 'VND') return 1;
        const entry = (rates || {})[currencyCode];
        if (entry && typeof entry.rate === 'number' && entry.rate > 0) return entry.rate;
        return null;
    }

    // Quy đổi một chi phí về VND; null = thiếu tỷ giá
    function amountInVND(expense, rates) {
        const cur = (expense && expense.currency) ? expense.currency : 'VND';
        const amt = parseFloat(expense && expense.amount) || 0;
        if (cur === 'VND') return amt;
        const rate = getRateToVND(cur, rates);
        if (rate === null) return null;
        return amt * rate;
    }

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

    // "Chốt" các khoản đang chia cho tất cả (benefitType khác 'selected') thành
    // 'selected' với danh sách members đưa vào — dùng khi thêm thành viên mới mà
    // người dùng chọn KHÔNG chia các khoản cũ cho người mới. Sửa trực tiếp trên
    // mảng expenses; trả về số khoản đã chốt.
    function freezeAllExpenses(expenses, members) {
        let count = 0;
        (expenses || []).forEach(e => {
            if (!e || e.benefitType === 'selected') return;
            e.benefitType = 'selected';
            e.beneficiaries = (members || []).slice();
            count++;
        });
        return count;
    }

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

    // Trả về map: memberName -> couple object (chỉ các nhóm hợp lệ: >=2 thành viên thực sự tồn tại)
    function getValidCouplesForMembers(currentMembers, coupleList) {
        const result = { byMember: {}, list: [] };
        (coupleList || []).forEach(c => {
            if (!c || !Array.isArray(c.members)) return;
            const validMembers = c.members.filter(m => currentMembers.includes(m));
            if (validMembers.length < 2) return;
            const primary = validMembers.includes(c.primary) ? c.primary : validMembers[0];
            const entry = { id: c.id, label: c.label || '', members: validMembers, primary };
            result.list.push(entry);
            validMembers.forEach(m => { result.byMember[m] = entry; });
        });
        return result;
    }

    // Thuật toán chia tiền đầy đủ. Input: { members, expenses, couples, rates }.
    // Output:
    //   missingRates      — các mã tiền tệ thiếu tỷ giá (nếu có thì các trường khác bỏ trống)
    //   balances          — số dư float theo từng thành viên (VND)
    //   mergedBalances    — số dư sau khi gộp nhóm chung quỹ về người đại diện
    //   roundedBalances   — số dư nguyên VND đã khử lệch làm tròn (khớp chính xác với transfers)
    //   memberInfo        — { [member]: { paid, needToPay } } cho bảng tổng quan
    //   validCouples      — kết quả getValidCouplesForMembers
    //   transfers         — [{ from, to, amount }] số nguyên VND, tất toán chính xác
    //   totalExpense      — tổng chi phí quy đổi VND
    function computeSplit(input) {
        const members = (input && input.members) || [];
        const expenses = (input && input.expenses) || [];
        const couples = (input && input.couples) || [];
        const rates = (input && input.rates) || {};

        const missingRates = [];
        expenses.forEach(exp => {
            const c = (exp && exp.currency) ? exp.currency : 'VND';
            if (c !== 'VND' && getRateToVND(c, rates) === null && !missingRates.includes(c)) {
                missingRates.push(c);
            }
        });
        if (missingRates.length > 0) return { missingRates };

        // Số dư float: cộng phần đã trả, trừ phần được hưởng
        const balances = {};
        members.forEach(m => { balances[m] = 0; });

        let totalExpense = 0;
        expenses.forEach(e => {
            const vnd = amountInVND(e, rates) || 0;
            totalExpense += vnd;
            // Guard: payer không còn trong danh sách (dữ liệu chia sẻ/bất thường)
            // thì bỏ qua thay vì tạo NaN lan ra toàn bộ kết quả
            if (balances[e.payer] !== undefined) balances[e.payer] += vnd;
        });
        expenses.forEach(e => {
            const bens = getExpenseBeneficiaries(e, members);
            if (!bens.length) return;
            const per = (amountInVND(e, rates) || 0) / bens.length;
            bens.forEach(m => { if (balances[m] !== undefined) balances[m] -= per; });
        });

        // paid / needToPay từng người (cho bảng tổng quan)
        const memberInfo = {};
        members.forEach(m => { memberInfo[m] = { paid: 0, needToPay: 0 }; });
        expenses.forEach(e => {
            const vnd = amountInVND(e, rates) || 0;
            if (memberInfo[e.payer]) memberInfo[e.payer].paid += vnd;
            const bens = getExpenseBeneficiaries(e, members);
            if (!bens.length) return;
            const per = vnd / bens.length;
            bens.forEach(m => { if (memberInfo[m]) memberInfo[m].needToPay += per; });
        });

        // Gộp số dư theo nhóm chung quỹ: dồn về người đại diện (primary)
        const validCouples = getValidCouplesForMembers(members, couples);
        const mergedBalances = Object.assign({}, balances);
        validCouples.list.forEach(c => {
            let total = 0;
            c.members.forEach(m => {
                total += mergedBalances[m] || 0;
                mergedBalances[m] = 0;
            });
            mergedBalances[c.primary] = total;
        });

        // Làm tròn về số nguyên VND và khử phần lệch (drift) do làm tròn,
        // để tổng các giao dịch khớp CHÍNH XÁC với số dư — không lệch 1-2 đồng.
        const roundedBalances = {};
        let drift = 0;
        Object.keys(mergedBalances).forEach(m => {
            const r = Math.round(mergedBalances[m]);
            roundedBalances[m] = r;
            drift += r;
        });
        // Drift do làm tròn tối đa ~0.5 đồng/người; nếu lớn hơn nghĩa là dữ liệu
        // vốn đã mất cân bằng (vd. payer không tồn tại) — không "sửa" hộ
        if (drift !== 0 && Math.abs(drift) <= members.length) {
            let target = null;
            Object.keys(roundedBalances).forEach(m => {
                if (target === null || Math.abs(roundedBalances[m]) > Math.abs(roundedBalances[target])) {
                    target = m;
                }
            });
            if (target !== null) roundedBalances[target] -= drift;
        }

        // Ghép chủ nợ / con nợ (greedy). Vì số dư đã là số nguyên và tổng = 0
        // nên mọi khoản đều tất toán hết, không còn dư lẻ.
        const creditors = [];
        const debtors = [];
        Object.keys(roundedBalances).forEach(m => {
            if (roundedBalances[m] > 0) creditors.push({ name: m, amount: roundedBalances[m] });
            else if (roundedBalances[m] < 0) debtors.push({ name: m, amount: -roundedBalances[m] });
        });
        creditors.sort((a, b) => b.amount - a.amount);
        debtors.sort((a, b) => b.amount - a.amount);

        const transfers = [];
        let i = 0, j = 0;
        while (i < creditors.length && j < debtors.length) {
            const amount = Math.min(creditors[i].amount, debtors[j].amount);
            if (amount > 0) {
                transfers.push({ from: debtors[j].name, to: creditors[i].name, amount: amount });
            }
            creditors[i].amount -= amount;
            debtors[j].amount -= amount;
            if (creditors[i].amount === 0) i++;
            if (debtors[j].amount === 0) j++;
        }

        return {
            missingRates: [],
            balances: balances,
            mergedBalances: mergedBalances,
            roundedBalances: roundedBalances,
            memberInfo: memberInfo,
            validCouples: validCouples,
            transfers: transfers,
            totalExpense: totalExpense,
        };
    }

    return {
        getRateToVND: getRateToVND,
        amountInVND: amountInVND,
        getExpenseBeneficiaries: getExpenseBeneficiaries,
        freezeAllExpenses: freezeAllExpenses,
        normalizeExpenses: normalizeExpenses,
        countFullCoverage: countFullCoverage,
        addBeneficiaryToFullCoverage: addBeneficiaryToFullCoverage,
        getValidCouplesForMembers: getValidCouplesForMembers,
        computeSplit: computeSplit,
    };
});
