    $(document).ready(function () {
        let currentEventCode = localStorage.getItem('currentEventCode') || null;
        let members = [];
        let expenses = [];
        let editingExpenseIndex = null; // index của expense đang sửa, null = đang thêm mới
        let bankInfo = {};
        let couples = []; // [{id, label, members:[names], primary:name}]
        let couplesDraft = []; // bản nháp khi đang mở modal, chỉ commit khi bấm Lưu
        let rates = {}; // { [currencyCode]: { rate: Number, source: 'fawazahmed0'|'exchangerate-api'|'vietcombank'|'vietcombank-mid'|'custom'|'missing', rateDate: 'YYYY-MM-DD', rateType: 'mid'|'transfer'|... } } — 1 đơn vị = rate VND
        const API_SOURCES = new Set(['fawazahmed0', 'exchangerate-api', 'vietcombank', 'vietcombank-mid']);
        const SOURCE_BADGE_SHORT = {
            'fawazahmed0': 'Fawaz',
            'exchangerate-api': 'ER-API',
            'vietcombank': 'VCB',
            'vietcombank-mid': 'VCB·mid',
        };
        function renderSourceBadge(entry) {
            if (!entry) return '<span class="badge bg-warning text-dark">Chưa có</span>';
            if (API_SOURCES.has(entry.source)) {
                const label = SOURCE_BADGE_SHORT[entry.source] || 'API';
                const dateStr = entry.rateDate ? ` (${escapeHtml(entry.rateDate)})` : '';
                return `<span class="badge bg-primary">${label}${dateStr}</span>`;
            }
            if (entry.source === 'custom') return '<span class="badge bg-secondary">Tùy chỉnh</span>';
            return '<span class="badge bg-warning text-dark">Chưa có</span>';
        }
        let ratesDraft = {}; // bản nháp khi mở modal
        let sortOrder = 'newest'; // 'newest' hoặc 'oldest'
        let allowEdit = true; // Mặc định cho phép sửa
        const EXPENSE_PAGE_SIZE = 10;
        let expenseDisplayLimit = EXPENSE_PAGE_SIZE;
        // Trạng thái lưu: tuần tự hóa request + mốc updated_at cho optimistic locking
        let saveInFlight = false;
        let savePendingAgain = false;
        let lastKnownUpdatedAt = null;
        // Chia sẻ kiểu Google Docs: 'restricted' | 'link' + vai trò 'viewer' | 'editor'
        let shareAccess = 'link';
        let shareRole = 'viewer';
        let isOwner = false;    // chủ sở hữu event hiện tại (quản lý người được mời)

        // Escape HTML để chống XSS khi render dữ liệu người dùng
        // (tên thành viên, tiêu đề chi phí, tên sự kiện, tên nhóm...)
        function escapeHtml(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[ch]));
        }

        // Danh sách tiền tệ thông dụng cho dropdown
        const COMMON_CURRENCIES = [
            { code: 'VND', name: 'Việt Nam Đồng' },
            { code: 'USD', name: 'US Dollar' },
            { code: 'JPY', name: 'Japanese Yen' },
            { code: 'EUR', name: 'Euro' },
            { code: 'KRW', name: 'Korean Won' },
            { code: 'THB', name: 'Thai Baht' },
            { code: 'SGD', name: 'Singapore Dollar' },
            { code: 'CNY', name: 'Chinese Yuan' },
            { code: 'AUD', name: 'Australian Dollar' },
            { code: 'GBP', name: 'UK Pound' },
            { code: 'HKD', name: 'Hong Kong Dollar' },
            { code: 'TWD', name: 'Taiwan Dollar' },
            { code: 'MYR', name: 'Malaysian Ringgit' },
            { code: 'CHF', name: 'Swiss Franc' },
            { code: 'CAD', name: 'Canadian Dollar' },
        ];
        const CURRENCY_NAME = {};
        COMMON_CURRENCIES.forEach(c => { CURRENCY_NAME[c.code] = c.name; });

        function getCurrencyOfExpense(expense) {
            return (expense && expense.currency) ? expense.currency : 'VND';
        }

        function todayISODate() {
            const d = new Date();
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }

        function formatDateTimeForDisplay(isoString) {
            if (!isoString) return '';
            const d = new Date(isoString);
            if (isNaN(d.getTime())) return isoString;
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        function formatExpenseDateForDisplay(dateStr) {
            if (!dateStr) return '';
            const parts = dateStr.split('-');
            if (parts.length !== 3) return dateStr;
            return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }

        function resetExpenseDateInput() {
            $('#expenseDate').val(todayISODate());
            $('#expenseCreatedTime').val('');
        }

        // Các hàm tính toán thuần nằm trong static/split.js (SplitLogic) để
        // test được bằng Node — ở đây chỉ bind với state hiện tại của trang
        function getRateToVND(currencyCode) {
            return SplitLogic.getRateToVND(currencyCode, rates);
        }

        function amountInVND(expense) {
            return SplitLogic.amountInVND(expense, rates);
        }

        function getExpenseBeneficiaries(expense) {
            return SplitLogic.getExpenseBeneficiaries(expense, members);
        }

        function collectCurrenciesFromExpenses() {
            const set = new Set();
            expenses.forEach(e => {
                const c = getCurrencyOfExpense(e);
                if (c && c !== 'VND') set.add(c);
            });
            return Array.from(set);
        }

        function renderCurrencyDropdown() {
            const $sel = $('#expenseCurrency');
            const current = $sel.val() || 'VND';
            $sel.empty();
            // Gộp: common + bất kỳ mã tiền tệ nào đang dùng trong expenses/rates
            const extras = new Set([...Object.keys(rates), ...collectCurrenciesFromExpenses()]);
            const seen = new Set();
            const codes = [];
            COMMON_CURRENCIES.forEach(c => { if (!seen.has(c.code)) { seen.add(c.code); codes.push(c.code); } });
            Array.from(extras).sort().forEach(code => { if (!seen.has(code)) { seen.add(code); codes.push(code); } });
            codes.forEach(code => {
                const name = CURRENCY_NAME[code] || (rates[code] && rates[code].currencyName) || '';
                $sel.append($('<option>').val(code).text(code + (name ? ' - ' + name : '')));
            });
            $sel.val(codes.includes(current) ? current : 'VND');
        }

        // Trả về map: memberName -> couple object (chỉ các nhóm hợp lệ: >=2 thành viên thực sự tồn tại)
        function getValidCouplesForMembers(currentMembers, coupleList) {
            return SplitLogic.getValidCouplesForMembers(currentMembers, coupleList);
        }

        function formatCoupleLabel(couple) {
            return couple.label && couple.label.trim() ? couple.label.trim() : couple.members.join(' & ');
        }

        // Kiểm tra xem có event_code trong URL không
        const urlParams = new URLSearchParams(window.location.search);
        const urlEventCode = urlParams.get('event_code');

        // Quyền chỉnh sửa do SERVER quyết định: GET event trả về cờ can_edit
        // theo JWT + chế độ chia sẻ. Có quyền → giao diện chỉnh sửa,
        // không có → giao diện chỉ xem (loadEventFromServer xử lý).
        // Overlay loading toàn trang khi đang tải sự kiện từ link.
        // % chỉ là mô phỏng (nhanh lúc đầu, chậm dần về ~95%) — cả quá trình tải
        // chỉ có 1 request nên không đo được tiến độ thật.
        let appLoadingTimer = null;
        function showAppLoading(show) {
            if (appLoadingTimer) {
                clearInterval(appLoadingTimer);
                appLoadingTimer = null;
            }
            if (show) {
                let percent = 0;
                $('#appLoadingPercent').text('0%');
                appLoadingTimer = setInterval(function () {
                    percent = Math.min(95, percent + Math.max(0.3, (95 - percent) * 0.08));
                    $('#appLoadingPercent').text(Math.floor(percent) + '%');
                }, 180);
            }
            $('#appLoading').toggleClass('d-none', !show);
        }

        // Event code sẽ mở lúc boot: link /share/ cũ, ?event_code=, hoặc event
        // gần nhất trong localStorage.
        const bootEventCode = window.location.pathname.startsWith('/share/')
            ? (window.location.pathname.split('/')[2] || null)
            : (urlEventCode || currentEventCode);

        // Đọc access token supabase-js đã lưu trong localStorage (ĐỒNG BỘ, không
        // chờ mạng) — chỉ tin khi còn hạn >30s; token hỏng/hết hạn coi như chưa
        // đăng nhập, auth thật sẽ refresh sau. Chỉ parse shape của supabase-js v2
        // (session nằm thẳng trong value) — app chưa từng ship bản v1.
        function readCachedSupabaseToken() {
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!/^sb-.+-auth-token$/.test(key)) continue;
                    const s = JSON.parse(localStorage.getItem(key));
                    if (s && s.access_token && s.expires_at
                            && s.expires_at * 1000 > Date.now() + 30000) {
                        return s.access_token;
                    }
                }
            } catch (e) { /* dữ liệu hỏng → coi như chưa đăng nhập */ }
            return null;
        }

        // Bắn GET event NGAY, song song với /api/config + getSession của auth.js —
        // loadEventFromServer chỉ "nhận nuôi" kết quả khi token lúc bắn trùng với
        // session thật sau khi auth xong (cả hai null = cùng ẩn danh), lệch thì
        // request lại như cũ. KHÔNG gắn handler ở đây để lỗi 403/404 sớm không
        // kích toast trước khi auth sẵn sàng.
        let earlyEvent = null; // {xhr, token, code} — dùng đúng một lần rồi xóa cả cụm
        if (bootEventCode) {
            const earlyToken = readCachedSupabaseToken();
            earlyEvent = {
                code: bootEventCode,
                token: earlyToken,
                xhr: $.ajax({
                    url: `/api/events/${bootEventCode}`,
                    method: 'GET',
                    headers: earlyToken ? { 'Authorization': 'Bearer ' + earlyToken } : {}
                })
            };
        }

        // Đang mở một sự kiện có sẵn? Che trang bằng overlay + đặt UI tạm theo
        // quyền dự đoán — người nhận link chỉ-xem sẽ không thấy "chớp" giao
        // diện chỉnh sửa trong lúc chờ server xác nhận quyền thật (can_edit).
        const bootHasEvent = !!bootEventCode;
        if (bootHasEvent) {
            showAppLoading(true);
            if (window.location.pathname.startsWith('/share/')) {
                allowEdit = false;
            } else if (urlEventCode) {
                allowEdit = false;
            }
            updateUIForEditMode();
        }

        // Cơ chế edit key đã bỏ (2026-08) — dọn khóa cũ còn sót trên máy
        localStorage.removeItem('eventEditKeys');

        // Chờ AppAuth biết session (từ localStorage, không chờ mạng lâu) rồi mới
        // tải event — để owner mở event của mình trên máy mới nhận đúng can_edit
        // qua JWT thay vì bị rơi về chế độ chỉ xem.
        AppAuth.onReady(function () {
            migrateLocalSavedEvents();
            if (window.location.pathname.startsWith('/share/')) {
                // Link chỉ-xem kiểu cũ (/share/<code>) — giữ tương thích, luôn chỉ xem
                allowEdit = false;
                localStorage.removeItem('currentEventCode');
                const pathParts = window.location.pathname.split('/');
                if (pathParts.length >= 3) {
                    currentEventCode = pathParts[2];
                    loadEventFromServer(currentEventCode, { forceViewOnly: true });
                }
            } else if (urlEventCode) {
                // Link chia sẻ /?event_code=X — server xác nhận quyền qua can_edit.
                // Link cũ /?event_code=X&key=... vẫn mở được: tham số key bị bỏ qua.
                allowEdit = false;
                currentEventCode = urlEventCode;
                loadEventFromServer(currentEventCode);
            } else if (currentEventCode) {
                loadEventFromServer(currentEventCode);
            } else {
                // Tạo sự kiện mới
                createNewEvent();
            }
        });

        // Ẩn/hiện các nút dựa trên allowEdit
        function updateUIForEditMode() {
            if (!allowEdit) {
                // Ẩn các nút và form chỉnh sửa
                $('#savedEventsBtn').hide();
                $('#configBankInfoBtn').hide();
                $('#configRatesBtn').hide();
                $('#saveEventBtn').hide();
                $('#shareEventBtn').hide();
                $('#historyBtn').hide();
                $('#memberForm').hide();
                $('#expenseForm').hide();
                $('#calculateBtn').hide();
                $('#manageCouplesBtn').hide();
                $('#eventTitle').removeAttr('contenteditable');
                $('#eventTitle').css('cursor', 'default');
                
                // Ẩn các nút action trong danh sách thành viên và chi phí
                $('.member-close').hide();
                $('.action-btn').hide();

                // Nút sao chép giao dịch VẪN hiển thị ở chế độ chỉ xem —
                // người nhận link chính là người cần danh sách chuyển tiền

                // Thay đổi tiêu đề navbar
                $('.navbar-brand').html('<i class="fas fa-eye me-2"></i>Xem Sự Kiện (Chế Độ Chỉ Xem)');
                
                // Ẩn footer
                $('footer').hide();
            } else {
                // Hiện lại tất cả các nút và form
                $('#newEventBtn').show();
                $('#savedEventsBtn').show();
                $('#configBankInfoBtn').show();
                $('#saveEventBtn').show();
                $('#shareEventBtn').show();
                $('#historyBtn').show();
                $('#memberForm').show();
                $('#expenseForm').show();
                $('#calculateBtn').show();
                $('#manageCouplesBtn').show();
                $('#configRatesBtn').show();
                $('#eventTitle').attr('contenteditable', 'true');
                $('#eventTitle').css('cursor', 'text');
                
                // Hiện lại các nút action
                $('.member-close').show();
                $('.action-btn').show();

                // Khôi phục tiêu đề navbar
                $('.navbar-brand').html('<i class="fas fa-money-bill-wave me-2"></i>Ứng Dụng Chia Tiền Nhóm');
                
                // Hiện lại footer
                $('footer').show();
            }
        }

        // Load danh sách ngân hàng
        $.getJSON('/api/banks', function (data) {
            const banks = data.data.filter(bank => bank.supported);
            banks.forEach(bank => {
                // Dựng option qua DOM API (.val()/.text()/.attr()) — không nội suy
                // chuỗi HTML từ dữ liệu ngoài (code/short_name/name)
                $('#bankInfoBank').append(
                    $('<option>')
                        .val(bank.code)
                        .attr('data-image', 'https://qr.sepay.vn/assets/img/banklogo/' + encodeURIComponent(bank.code) + '.png')
                        .text(bank.short_name + ' - ' + bank.name)
                );
            });

            // Khởi tạo select2 sau khi append xong
            $('#bankInfoBank').select2({
                dropdownParent: $('#editBankInfoModal'), // Đảm bảo dropdown hiển thị đúng trong modal
                templateResult: formatBankOption,
                templateSelection: formatBankOption,
                width: '100%'
            });
        });

        // Cập nhật danh sách thành viên trong modal cấu hình ngân hàng
        function updateBankInfoMembers() {
            $('#bankInfoMember').empty();
            $('#bankInfoMember').append('<option value="" selected disabled>Chọn thành viên...</option>');
            members.forEach(member => {
                $('#bankInfoMember').append($('<option>').val(member).text(member));
            });
        }

        // Hiển thị bảng thông tin ngân hàng
        function renderBankInfoTable() {
            $('#bankInfoTableBody').empty();

            members.forEach(member => {
                const info = bankInfo[member] || {};
                // So theo value bằng .filter() thay vì nội suy vào selector —
                // giá trị chứa ký tự đặc biệt sẽ làm selector throw/vỡ render
                const bankValue = info.bank || '';
                const bankOption = $('#bankInfoBank option').filter(function () {
                    return $(this).val() === bankValue;
                }).first();
                const bankName = bankOption.text() || '';
                const bankLogo = bankOption.data('image') ? `<img src="${bankOption.data('image')}" style="height:16px;width:auto;vertical-align:middle;margin-right:8px;"/>` : '';

                $('#bankInfoTableBody').append(`
                    <tr>
                        <td>${escapeHtml(member)}</td>
                        <td>${bankLogo}${escapeHtml(bankName)}</td>
                        <td>${escapeHtml(info.account || '')}</td>
                        <td>
                            <button class="btn btn-sm btn-outline-primary edit-bank-info" data-member="${escapeHtml(member)}">
                                <i class="fas fa-edit"></i>
                            </button>
                            ${info.bank ? `
                                <button class="btn btn-sm btn-outline-danger delete-bank-info" data-member="${escapeHtml(member)}">
                                    <i class="fas fa-trash"></i>
                                </button>
                            ` : ''}
                        </td>
                    </tr>
                `);
            });
        }

        // Xử lý khi bấm nút cấu hình ngân hàng
        $('#configBankInfoBtn').click(function () {
            if (!allowEdit) return; // Không cho phép cấu hình nếu ở chế độ chỉ xem
            
            renderBankInfoTable();
            $('#bankInfoModal').modal('show');
        });

        // Xử lý khi bấm nút thêm thông tin ngân hàng
        $('#addBankInfoBtn').click(function () {
            if (!allowEdit) return; // Không cho phép thêm nếu ở chế độ chỉ xem
            
            updateBankInfoMembers();
            $('#bankInfoMember').val('');
            $('#bankInfoBank').val('');
            $('#bankInfoAccount').val('');
            $('#editBankInfoModal').modal('show');
        });

        // Xử lý khi bấm nút sửa thông tin ngân hàng
        $(document).on('click', '.edit-bank-info', function () {
            if (!allowEdit) return; // Không cho phép sửa nếu ở chế độ chỉ xem
            
            const member = $(this).data('member');
            const info = bankInfo[member] || {};

            updateBankInfoMembers();
            $('#bankInfoMember').val(member);
            $('#bankInfoBank').val(info.bank || '');
            $('#bankInfoAccount').val(info.account || '');

            $('#editBankInfoModal').modal('show');
        });

        // Xử lý khi bấm nút xóa thông tin ngân hàng
        $(document).on('click', '.delete-bank-info', function () {
            if (!allowEdit) return; // Không cho phép xóa nếu ở chế độ chỉ xem
            
            const member = $(this).data('member');
            showConfirm(`Bạn có chắc chắn muốn xóa thông tin ngân hàng của ${member}?`, function () {
                delete bankInfo[member];
                localStorage.setItem('bankInfo', JSON.stringify(bankInfo));
                renderBankInfoTable();
                showToast('Đã xóa thông tin ngân hàng thành công!', 'success');
            }, { okLabel: 'Xóa' });
        });

        // Xử lý khi chọn thành viên trong modal thêm/sửa
        $('#bankInfoMember').change(function () {
            if (!allowEdit) return; // Không cho phép thay đổi nếu ở chế độ chỉ xem
            
            const member = $(this).val();
            if (member && bankInfo[member]) {
                $('#bankInfoBank').val(bankInfo[member].bank);
                $('#bankInfoAccount').val(bankInfo[member].account);
            } else {
                $('#bankInfoBank').val('');
                $('#bankInfoAccount').val('');
            }
        });

        // Xử lý khi lưu thông tin ngân hàng
        $('#saveBankInfoBtn').click(function () {
            if (!allowEdit) return; // Không cho phép lưu nếu ở chế độ chỉ xem
            
            const member = $('#bankInfoMember').val();
            const bank = $('#bankInfoBank').val();
            const account = $('#bankInfoAccount').val();

            if (!member || !bank || !account) {
                showToast('Vui lòng điền đầy đủ thông tin!', 'warning');
                return;
            }

            bankInfo[member] = {bank, account};
            localStorage.setItem('bankInfo', JSON.stringify(bankInfo));
            $('#editBankInfoModal').modal('hide');
            saveEvent(false);
            renderBankInfoTable();
            showToast('Đã lưu thông tin ngân hàng thành công!', 'success');
        });

        // Xử lý khi bấm nút tạo QR code
        $(document).on('click', '.generate-qr-btn', function () {
            const from = $(this).data('from');
            const to = $(this).data('to');
            const amount = $(this).data('amount');

            if (!bankInfo[to]) {
                showToast('Vui lòng cấu hình thông tin ngân hàng cho người nhận trước!', 'warning');
                return;
            }

            const bankInfoTo = bankInfo[to];
            // encodeURIComponent: account/bank là dữ liệu người dùng — không được
            // chèn thẳng vào query string
            const qrUrl = `https://qr.sepay.vn/img?acc=${encodeURIComponent(bankInfoTo.account)}&bank=${encodeURIComponent(bankInfoTo.bank)}&amount=${encodeURIComponent(amount)}&template=compact&download=false`;
            // qrUrl += `&des=Chuyen tien cho ${to}`;

            $('#qrCodeImage').attr('src', qrUrl);
            $('#qrCodeModal').modal('show');
        });

        // Xử lý khi bấm nút tải ảnh QR (cho phép cả ở chế độ chỉ xem —
        // người nhận link chính là người cần QR để chuyển tiền)
        $('#downloadQrBtn').click(async function () {
            const qrUrl = $('#qrCodeImage').attr('src');
            if (!qrUrl) {
                showToast('Chưa có mã QR để tải!', 'warning');
                return;
            }
            // Ảnh nằm ở domain khác (qr.sepay.vn) nên thuộc tính `download`
            // bị trình duyệt bỏ qua → phải tải qua fetch → blob
            try {
                const resp = await fetch(qrUrl);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const blob = await resp.blob();
                const objUrl = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = objUrl;
                link.download = 'qr-chuyen-tien.png';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(objUrl);
                showToast('Đã tải ảnh QR thành công!', 'success');
            } catch (err) {
                // fetch bị chặn (CORS/mạng) — dùng chế độ download của sepay
                window.open(qrUrl.replace('download=false', 'download=true'), '_blank');
            }
        });

        // Format số tiền thành định dạng VND
        function formatCurrency(amount) {
            return new Intl.NumberFormat('vi-VN').format(Math.round(amount)) + ' VND';
        }

        // Format số tiền theo currency (không chuyển đổi)
        function formatAmountWithCurrency(amount, currencyCode) {
            const n = Number(amount) || 0;
            const formatted = new Intl.NumberFormat('vi-VN').format(Math.round(n));
            return `${formatted} ${currencyCode || 'VND'}`;
        }

        // Hàm cập nhật preview số tiền sẽ lưu
        function updateAmountPreview() {
            const amountInput = $('#expenseAmount');
            const checkbox = $('#addZerosCheckbox');
            const previewSpan = $('#amountPreview span');
            const currency = $('#expenseCurrency').val() || 'VND';

            const amount = amountInput.val().trim();

            if (amount && !isNaN(amount) && isFinite(parseFloat(amount))) {
                let raw = parseFloat(amount);
                if (checkbox.is(':checked')) {
                    // "K" = nghìn: NHÂN 1000, không nối chuỗi (nối chuỗi làm
                    // "1.5" thành "1.5000" = 1.5 thay vì 1500)
                    raw *= 1000;
                }
                let text = escapeHtml(formatAmountWithCurrency(raw, currency));
                if (currency !== 'VND') {
                    const rate = getRateToVND(currency);
                    if (rate !== null) {
                        text += ` (≈ ${formatCurrency(raw * rate)})`;
                    } else {
                        text += ` <span class="text-danger">(chưa có tỷ giá — bấm "Cấu hình tỷ giá")</span>`;
                    }
                }
                previewSpan.html(text);
            } else {
                previewSpan.text(currency === 'VND' ? '0 VND' : `0 ${currency}`);
            }
        }

        // Xử lý khi nhập số tiền - cập nhật preview
        $('#expenseAmount').on('input', function() {
            if (!allowEdit) return; // Không cho phép nhập nếu ở chế độ chỉ xem
            
            updateAmountPreview();
        });

        // Xử lý khi thay đổi checkbox - cập nhật preview
        $('#addZerosCheckbox').change(function() {
            if (!allowEdit) return; // Không cho phép thay đổi nếu ở chế độ chỉ xem

            updateAmountPreview();
        });

        // Đổi tiền tệ → mặc định bật +K cho VND, tắt cho ngoại tệ; cập nhật preview
        $('#expenseCurrency').on('change', function () {
            const currency = $(this).val() || 'VND';
            $('#addZerosCheckbox').prop('checked', currency === 'VND');
            updateAmountPreview();
        });

        // Hàm tạo sự kiện mới
        function createNewEvent() {
            localStorage.removeItem('currentEventCode');
            currentEventCode = null;
            lastKnownUpdatedAt = null;
            allowEdit = true; // sự kiện mới do chính mình tạo
            $('#loginToEditBanner').addClass('d-none');
            shareAccess = 'link';   // mặc định: bất kỳ ai có đường liên kết
            shareRole = 'viewer';   // với vai trò Người xem
            isOwner = true;     // sự kiện mới do chính mình tạo
            setSaveStatus('');
            $('#eventTitle').text('Sự Kiện Mới');
            $('#eventCodeDisplay').text('');
            members = [];
            expenses = [];
            editingExpenseIndex = null;
            bankInfo = {};
            couples = [];
            rates = {};
            renderCurrencyDropdown();
            renderMembers();
            renderExpenses();
            $('#resultContainer').hide();

            // Cập nhật UI dựa trên chế độ chỉnh sửa
            updateUIForEditMode();
            showAppLoading(false);
        }

        // Link chia sẻ chỉ có event_code — server quyết quyền theo cài đặt
        // chia sẻ kiểu Google Docs (shareAccess/shareRole).
        // ===== Link chia sẻ =====
        function buildShareLink(eventCode) {
            return window.location.origin + '/?event_code=' + encodeURIComponent(eventCode);
        }

        function copyTextToClipboard(text, successMsg) {
            function legacyCopy() {
                // Input tạm phải nằm TRONG modal đang mở — focus-trap của
                // Bootstrap giật focus khỏi phần tử ngoài modal làm copy hụt
                const $host = $('.modal.show').last();
                const $tmp = $('<input type="text">')
                    .appendTo($host.length ? $host : $('body')).val(text);
                $tmp[0].select();
                document.execCommand('copy');
                $tmp.remove();
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(legacyCopy);
            } else {
                legacyCopy();
            }
            showToast(successMsg, 'success');
        }
        // ===== Hết phần chia sẻ =====

        // Indicator trạng thái lưu ở header: Đang lưu... / Đã lưu lúc HH:MM / lỗi
        // lastSaveFailed: lần lưu gần nhất lỗi → còn thay đổi chưa lên server
        let lastSaveFailed = false;
        function setSaveStatus(state) {
            if (state === 'error') lastSaveFailed = true;
            else if (state === 'saved' || state === '') lastSaveFailed = false;
            const $s = $('#saveStatus');
            if (!$s.length) return;
            if (state === 'saving') {
                $s.attr('class', 'text-muted ms-2')
                    .html('<i class="fas fa-circle-notch fa-spin me-1"></i>Đang lưu...');
            } else if (state === 'saved') {
                const d = new Date();
                const pad = n => String(n).padStart(2, '0');
                $s.attr('class', 'text-success ms-2')
                    .html(`<i class="fas fa-check me-1"></i>Đã lưu lúc ${pad(d.getHours())}:${pad(d.getMinutes())}`);
            } else if (state === 'error') {
                $s.attr('class', 'text-danger ms-2')
                    .html('<i class="fas fa-triangle-exclamation me-1"></i>Chưa lưu được');
            } else {
                $s.attr('class', 'text-muted ms-2').empty();
            }
        }

        // Cảnh báo trước khi rời trang khi còn thay đổi chưa lưu xong:
        // đang lưu dở, có lần lưu đang chờ nối tiếp, hoặc lần lưu gần nhất lỗi.
        window.addEventListener('beforeunload', function (e) {
            if (saveInFlight || savePendingAgain || lastSaveFailed) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // ===== Lưu dữ liệu lên server =====
        // Các lần lưu được TUẦN TỰ HÓA: chỉ 1 request tại một thời điểm, các
        // thao tác trong lúc chờ được gộp thành đúng 1 lần lưu tiếp theo.
        // Nhờ vậy không bắn PUT dồn dập và expectedUpdatedAt luôn mới.
        function saveEvent(showAlert = true) {
            if (!allowEdit) return; // Không cho phép lưu nếu ở chế độ chỉ xem

            // Tạo sự kiện mới cần tài khoản (server cũng chặn 401) — sự kiện đã
            // tồn tại thì quyền sửa do server quyết theo chế độ chia sẻ.
            if (!currentEventCode && !AppAuth.isLoggedIn()) {
                setSaveStatus('error');
                showToast('Vui lòng đăng nhập để tạo và lưu sự kiện.', 'warning');
                if (showAlert) AppAuth.showLoginModal();
                return;
            }

            if (members.length === 0 && showAlert) {
                showToast('Vui lòng thêm ít nhất một thành viên trước khi lưu!', 'warning');
                return;
            }

            if (saveInFlight) {
                savePendingAgain = true;
                return;
            }

            const eventData = {
                title: $('#eventTitle').text(),
                members: members,
                expenses: expenses,
                bankInfo: bankInfo,
                couples: couples,
                rates: rates
            };

            function finishSave() {
                saveInFlight = false;
                if (savePendingAgain) {
                    savePendingAgain = false;
                    saveEvent(false);
                }
            }

            saveInFlight = true;
            setSaveStatus('saving');

            if (currentEventCode) {
                // Cập nhật sự kiện hiện có
                eventData.expectedUpdatedAt = lastKnownUpdatedAt;
                $.ajax({
                    url: `/api/events/${currentEventCode}`,
                    method: 'PUT',
                    contentType: 'application/json',
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify(eventData),
                    success: function(response) {
                        if (response.success) {
                            if (response.updated_at) {
                                lastKnownUpdatedAt = response.updated_at;
                            }
                            setSaveStatus('saved');
                            if (showAlert) {
                                showToast('Sự kiện đã được cập nhật thành công!', 'success');
                            }
                        }
                    },
                    error: function(xhr) {
                        setSaveStatus('error');
                        if (xhr.status === 401) {
                            // Phiên đăng nhập hết hạn giữa chừng — KHÔNG về chỉ-xem,
                            // giữ nguyên dữ liệu trên trang; đăng nhập xong lưu lại được
                            showToast('Vui lòng đăng nhập để chỉnh sửa sự kiện.', 'warning');
                            AppAuth.showLoginModal();
                        } else if (xhr.status === 403) {
                            // Server từ chối quyền (bị gỡ khỏi danh sách mời / chế độ
                            // chia sẻ đổi) → chuyển giao diện về chế độ chỉ xem
                            showToast('Bạn không có quyền chỉnh sửa sự kiện này — chuyển về chế độ chỉ xem.', 'error');
                            allowEdit = false;
                            updateUIForEditMode();
                        } else if (xhr.status === 409) {
                            // Người khác vừa lưu bản mới hơn — không ghi đè,
                            // tải lại dữ liệu mới nhất (thay đổi local vừa rồi bị bỏ)
                            savePendingAgain = false;
                            showToast('Sự kiện vừa được cập nhật ở nơi khác — đang tải lại dữ liệu mới nhất. Thao tác vừa rồi chưa được lưu, vui lòng thực hiện lại.', 'warning');
                            loadEventFromServer(currentEventCode);
                        } else {
                            showToast('Lỗi khi cập nhật sự kiện!', 'error');
                        }
                    },
                    complete: finishSave
                });
            } else {
                // Tạo sự kiện mới
                $.ajax({
                    url: '/api/events',
                    method: 'POST',
                    contentType: 'application/json',
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify(eventData),
                    success: function(response) {
                        if (response.success) {
                            currentEventCode = response.event_code;
                            localStorage.setItem('currentEventCode', currentEventCode);
                            $('#eventCodeDisplay').text(currentEventCode);
                            rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"
                            lastKnownUpdatedAt = response.updated_at || null;
                            isOwner = true; // người tạo là chủ sở hữu
                            setSaveStatus('saved');
                            if (showAlert) {
                                showToast('Sự kiện đã được tạo thành công và thêm vào danh sách của bạn!', 'success');
                            }
                        }
                    },
                    error: function(xhr) {
                        setSaveStatus('error');
                        if (xhr.status === 401) {
                            showToast('Vui lòng đăng nhập để tạo sự kiện.', 'warning');
                            AppAuth.showLoginModal();
                        } else {
                            showToast('Lỗi khi tạo sự kiện!', 'error');
                        }
                    },
                    complete: finishSave
                });
            }
        }

        // Hàm tải sự kiện từ server — server trả cờ can_edit (JWT + chế độ
        // chia sẻ), cờ này quyết định giao diện chỉnh sửa hay chỉ xem.
        function loadEventFromServer(eventCode, opts) {
            opts = opts || {};
            // Nhận nuôi request bắn sớm lúc boot (chỉ dùng một lần): phải đúng
            // event code VÀ token lúc bắn trùng session hiện tại — lệch (token
            // vừa refresh / đổi tài khoản) thì bỏ, request lại với token thật.
            let req = null;
            if (earlyEvent) {
                const matches = earlyEvent.code === eventCode
                    && earlyEvent.token === AppAuth.accessToken();
                if (matches) req = earlyEvent.xhr;
                earlyEvent = null;
            }
            if (!req) {
                req = $.ajax({
                    url: `/api/events/${eventCode}`,
                    method: 'GET',
                    headers: AppAuth.authHeaders()
                });
            }
            req.done(function(response) {
                if (response.success) {
                    const eventData = response.event;
                    currentEventCode = eventData.event_code;

                    // Quyền chỉnh sửa do server xác nhận
                    if (opts.forceViewOnly) {
                        allowEdit = false;
                        $('#loginToEditBanner').addClass('d-none');
                    } else {
                        allowEdit = !!eventData.can_edit;
                        // Có quyền sửa nhưng chưa đăng nhập → banner mời đăng nhập
                        $('#loginToEditBanner').toggleClass('d-none', !eventData.login_required_to_edit);
                    }

                    // Mốc updated_at cho optimistic locking khi lưu
                    lastKnownUpdatedAt = eventData.updated_at || null;
                    // Cài đặt chia sẻ hiện tại (cho modal Chia sẻ)
                    shareAccess = eventData.share_access || 'link';
                    shareRole = eventData.share_role || 'viewer';
                    isOwner = !!eventData.is_owner;
                    setSaveStatus(''); // dữ liệu vừa tải, chưa có thay đổi cần lưu

                    // Cập nhật tên sự kiện + mã sự kiện hiển thị
                    $('#eventTitle').text(eventData.title);
                    $('#eventCodeDisplay').text(currentEventCode || '');

                    // Cập nhật thành viên & nhóm chung quỹ
                    members = eventData.members || [];
                    couples = Array.isArray(eventData.couples) ? eventData.couples : [];
                    renderMembers();

                    // Cập nhật tỷ giá
                    rates = (eventData.rates && typeof eventData.rates === 'object') ? eventData.rates : {};
                    renderCurrencyDropdown();

                    // Cập nhật chi phí — chuẩn hóa dữ liệu 'all' cũ thành
                    // danh sách đích danh (ghi xuống DB ở lần lưu kế tiếp)
                    expenses = eventData.expenses || [];
                    SplitLogic.normalizeExpenses(expenses, members);
                    editingExpenseIndex = null;
                    $('#expenseSubmitBtn').text('Thêm Chi Phí');
                    $('#cancelEditExpenseBtn').addClass('d-none');
                    renderExpenses();

                    // Cập nhật thông tin ngân hàng
                    bankInfo = eventData.bankInfo || {};

                    // Chỉ lưu event_code vào localStorage khi ở chế độ cho phép chỉnh sửa,
                    // để tránh trường hợp mở link chỉ-xem rồi quay lại "/" vẫn vào được chế độ sửa
                    if (allowEdit) {
                        localStorage.setItem('currentEventCode', currentEventCode);
                        rememberEvent(currentEventCode); // Thêm vào "Sự Kiện Của Tôi"
                    }

                    // Tự động tính toán khi tải sự kiện
                    calculateSplit(false);

                    // Cập nhật UI dựa trên chế độ chỉnh sửa
                    updateUIForEditMode();
                    showAppLoading(false);
                } else {
                    showToast('Không tìm thấy sự kiện!', 'error');
                    createNewEvent();
                }
            }).fail(function(xhr) {
                if (xhr && xhr.status === 403) {
                    // Chế độ "Hạn chế" — chỉ chủ sở hữu truy cập được
                    showToast('Sự kiện đang ở chế độ hạn chế — chỉ chủ sở hữu mới truy cập được.', 'error');
                } else {
                    showToast('Lỗi khi tải sự kiện!', 'error');
                }
                createNewEvent();
            });
        }

        // Hàm hiển thị danh sách thành viên
        function renderMembers() {
            $('#membersList').empty();
            $('#expensePayer').empty();
            $('#expensePayer').append('<option value="" selected disabled>Chọn người thanh toán...</option>');

            const coupleMap = getValidCouplesForMembers(members, couples).byMember;

            members.forEach(function (member, index) {
                const couple = coupleMap[member];
                let badge = '';
                if (couple) {
                    const isPrimary = couple.primary === member;
                    const tooltip = `Nhóm: ${formatCoupleLabel(couple)}${isPrimary ? ' (đại diện)' : ''}`;
                    badge = `<span class="couple-badge" title="${escapeHtml(tooltip)}">
                        ${isPrimary ? '<span class="primary-dot"></span>' : ''}
                        <i class="fas fa-heart me-1" style="font-size:0.65rem;"></i>${escapeHtml(formatCoupleLabel(couple))}
                    </span>`;
                }
                $('#membersList').append(`
                <div class="member-pill">
                    ${escapeHtml(member)}${badge}
                    <button type="button" class="member-close" data-index="${index}" aria-label="Xóa thành viên ${escapeHtml(member)}" style="${!allowEdit ? 'display: none;' : ''}"><i class="fas fa-times" aria-hidden="true"></i></button>
                </div>
            `);

                $('#expensePayer').append($('<option>').val(member).text(member));
            });

            // Đồng bộ tuỳ chọn người trả / người hưởng trong bộ lọc chi phí
            rebuildFilterMemberOptions();

            // Tự động tính toán khi danh sách thành viên thay đổi
            autoCalculate();
        }

        // Hàm sắp xếp danh sách chi phí
        function sortExpenses() {
            if (sortOrder === 'newest') {
                // Sắp xếp theo thứ tự mới nhất (đảo ngược)
                return [...expenses].reverse();
            } else {
                // Sắp xếp theo thứ tự cũ nhất (giữ nguyên thứ tự hiện tại)
                return [...expenses];
            }
        }

        // Chuẩn hoá Tiếng Việt → không dấu, để search "do an" khớp "đồ ăn"
        function normalizeViet(str) {
            return (str == null ? '' : String(str))
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/đ/g, 'd').replace(/Đ/g, 'D')
                .toLowerCase()
                .trim();
        }

        // Chuẩn hoá ngày của expense về dạng YYYY-MM-DD theo trường được chọn
        function getExpenseDateKey(exp, field) {
            const raw = exp && exp[field];
            if (!raw) return null;
            const s = String(raw);
            return s.length >= 10 ? s.slice(0, 10) : s;
        }

        // Áp các bộ lọc lên một danh sách expense
        function filterExpenses(list) {
            const q = normalizeViet($('#filterSearch').val());
            const payer = $('#filterPayer').val() || '';
            const benef = $('#filterBeneficiary').val() || '';
            const dateField = $('#filterDateField').val() || 'expense_date';
            const fromStr = $('#filterDateFrom').val() || '';
            const toStr = $('#filterDateTo').val() || '';

            return list.filter(exp => {
                if (q && !normalizeViet(exp.title).includes(q)) return false;
                if (payer && exp.payer !== payer) return false;
                if (benef && !getExpenseBeneficiaries(exp).includes(benef)) return false;
                if (fromStr || toStr) {
                    const dateStr = getExpenseDateKey(exp, dateField);
                    if (!dateStr) return false;
                    if (fromStr && dateStr < fromStr) return false;
                    if (toStr && dateStr > toStr) return false;
                }
                return true;
            });
        }

        function countActiveFilters() {
            let n = 0;
            if (($('#filterSearch').val() || '').trim()) n++;
            if ($('#filterPayer').val()) n++;
            if ($('#filterBeneficiary').val()) n++;
            if ($('#filterDateFrom').val() || $('#filterDateTo').val()) n++;
            return n;
        }

        function updateActiveFilterBadge() {
            const n = countActiveFilters();
            const $b = $('#activeFilterCount');
            if (n > 0) $b.text(n).removeClass('d-none');
            else $b.addClass('d-none');
        }

        // Đổ lại danh sách thành viên vào select Người trả / Người hưởng
        function rebuildFilterMemberOptions() {
            const $payer = $('#filterPayer');
            const $benef = $('#filterBeneficiary');
            if (!$payer.length || !$benef.length) return;

            const prevPayer = $payer.val();
            const prevBenef = $benef.val();

            $payer.find('option:not(:first)').remove();
            $benef.find('option:not(:first)').remove();

            members.forEach(m => {
                const opt = $('<option>').val(m).text(m);
                $payer.append(opt.clone());
                $benef.append(opt);
            });

            if (prevPayer && members.includes(prevPayer)) $payer.val(prevPayer);
            if (prevBenef && members.includes(prevBenef)) $benef.val(prevBenef);
        }

        // ===== Lazy-load thư viện nặng (Chart.js, xlsx, jsPDF) =====
        // Không nằm trong index.html nữa để khỏi chặn boot (~1.5MB lần ghé đầu);
        // tải khi cần bằng thẻ script động, GIỮ NGUYÊN SRI hash — đổi phiên bản
        // thì tính lại hash như quy ước CDN trong CLAUDE.md.
        const _lazyScriptPromises = {};
        function loadScriptOnce(src, integrity) {
            if (_lazyScriptPromises[src]) return _lazyScriptPromises[src];
            _lazyScriptPromises[src] = new Promise(function (resolve, reject) {
                const el = document.createElement('script');
                el.src = src;
                el.integrity = integrity;
                el.crossOrigin = 'anonymous';
                el.onload = function () { resolve(); };
                el.onerror = function () {
                    // Xóa promise lỗi để lần bấm sau thử tải lại được
                    delete _lazyScriptPromises[src];
                    reject(new Error('Không tải được ' + src));
                };
                document.head.appendChild(el);
            });
            return _lazyScriptPromises[src];
        }
        function ensureChartJs() {
            if (typeof Chart !== 'undefined') return Promise.resolve();
            return loadScriptOnce('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
                'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4');
        }
        function ensureXlsx() {
            if (typeof XLSX !== 'undefined') return Promise.resolve();
            return loadScriptOnce('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
                'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT');
        }
        function ensureJsPdf() {
            // autotable phải nạp SAU jspdf (plugin gắn vào window.jspdf)
            const base = (window.jspdf && window.jspdf.jsPDF)
                ? Promise.resolve()
                : loadScriptOnce('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
                    'sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/');
            return base.then(function () {
                return loadScriptOnce('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js',
                    'sha384-Xl/CUCfJbzsngMp0CFxkmF0VW/8C160IsGujqeQlIhaGxKz2+JsIGORFqtCPeldF');
            });
        }

        // Hàm hiển thị danh sách chi phí
        let dailyStatsChartInstance = null;

        function renderDailyStats(sourceList) {
            const $container = $('#dailyStatsContainer');
            const list = Array.isArray(sourceList) ? sourceList : expenses;

            if (!list.length) {
                $container.addClass('d-none');
                if (dailyStatsChartInstance) {
                    dailyStatsChartInstance.destroy();
                    dailyStatsChartInstance = null;
                }
                return;
            }

            // Chart.js lazy-load: lần đầu có dữ liệu mới tải thư viện rồi render
            // lại; tải hỏng (offline) → ẩn khối biểu đồ, phần còn lại chạy bình thường
            if (typeof Chart === 'undefined') {
                ensureChartJs()
                    .then(function () { renderDailyStats(sourceList); })
                    .catch(function () { $container.addClass('d-none'); });
                return;
            }

            const groups = {};
            let anyMissing = false;
            list.forEach(e => {
                const key = e.expense_date || '__no_date__';
                if (!groups[key]) groups[key] = { count: 0, total: 0 };
                groups[key].count += 1;
                const vnd = amountInVND(e);
                if (vnd === null) {
                    anyMissing = true;
                } else {
                    groups[key].total += vnd;
                }
            });

            // Sắp xếp tăng dần theo ngày để biểu đồ đọc trái→phải = cũ→mới
            const dateKeys = Object.keys(groups).sort((a, b) => {
                if (a === '__no_date__') return 1;
                if (b === '__no_date__') return -1;
                return a.localeCompare(b);
            });

            const labels = dateKeys.map(k => k === '__no_date__' ? 'Chưa có ngày' : formatExpenseDateForDisplay(k));
            const totals = dateKeys.map(k => groups[k].total);
            const counts = dateKeys.map(k => groups[k].count);

            $('#dailyStatsDays').text(dateKeys.length);
            $('#dailyStatsMissingNote').toggleClass('d-none', !anyMissing);
            $container.removeClass('d-none');

            const ctx = document.getElementById('dailyStatsChart').getContext('2d');

            if (dailyStatsChartInstance) {
                dailyStatsChartInstance.data.labels = labels;
                dailyStatsChartInstance.data.datasets[0].data = totals;
                dailyStatsChartInstance.data.datasets[0]._counts = counts;
                dailyStatsChartInstance.data.datasets[0]._dateKeys = dateKeys;
                dailyStatsChartInstance.update();
                return;
            }

            dailyStatsChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Tổng chi phí (VND)',
                        data: totals,
                        _counts: counts,
                        _dateKeys: dateKeys,
                        backgroundColor: 'rgba(13, 110, 253, 0.6)',
                        borderColor: 'rgba(13, 110, 253, 1)',
                        borderWidth: 1,
                        borderRadius: 4,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    onClick: function (evt, elements, chart) {
                        if (!elements || !elements.length) return;
                        const idx = elements[0].index;
                        const keys = chart.data.datasets[0]._dateKeys || [];
                        const key = keys[idx];
                        if (!key) return;
                        if (key === '__no_date__') {
                            showToast('Không thể lọc theo chi phí chưa có ngày.', 'warning');
                            return;
                        }
                        $('#filterDateField').val('expense_date');
                        $('#filterDateFrom').val(key);
                        $('#filterDateTo').val(key);
                        const $filtersBody = $('#expenseFiltersBody');
                        if (!$filtersBody.hasClass('show') && window.bootstrap && bootstrap.Collapse) {
                            bootstrap.Collapse.getOrCreateInstance($filtersBody[0]).show();
                        }
                        expenseDisplayLimit = EXPENSE_PAGE_SIZE;
                        renderExpenses();
                        showToast(`Đã lọc theo ngày ${formatExpenseDateForDisplay(key)}.`, 'info');
                    },
                    onHover: function (evt, elements) {
                        const target = evt && evt.native ? evt.native.target : null;
                        if (target && target.style) {
                            target.style.cursor = elements && elements.length ? 'pointer' : 'default';
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (ctx) {
                                    const cnt = ctx.dataset._counts ? ctx.dataset._counts[ctx.dataIndex] : 0;
                                    return [
                                        `Tổng: ${formatCurrency(ctx.parsed.y)}`,
                                        `Số chi phí: ${cnt}`,
                                        'Bấm để lọc theo ngày này'
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                callback: function (value) {
                                    if (value >= 1e9) return (value / 1e9).toFixed(1) + ' tỷ';
                                    if (value >= 1e6) return (value / 1e6).toFixed(1) + ' tr';
                                    if (value >= 1e3) return (value / 1e3).toFixed(0) + 'k';
                                    return value;
                                }
                            }
                        }
                    }
                }
            });
        }

        function buildExportFilename(ext) {
            const title = ($('#eventTitle').text() || 'chi-phi').trim();
            const safe = title
                .normalize('NFD').replace(/[̀-ͯ]/g, '')
                .replace(/đ/g, 'd').replace(/Đ/g, 'D')
                .replace(/[^a-zA-Z0-9-_]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .toLowerCase() || 'chi-phi';
            return `${safe}-${todayISODate()}.${ext}`;
        }

        function buildExpenseExportRows() {
            const sorted = sortExpenses();
            return sorted.map((e, displayIndex) => {
                const stt = sortOrder === 'newest' ? sorted.length - displayIndex : displayIndex + 1;
                const cur = getCurrencyOfExpense(e);
                const vnd = amountInVND(e);
                // Luôn ghi tên đích danh (danh sách thực tế sau lọc/fallback)
                const beneficiaries = getExpenseBeneficiaries(e).join(', ');
                return {
                    stt,
                    title: e.title || '',
                    amount: Number(e.amount) || 0,
                    currency: cur || 'VND',
                    amountVnd: vnd === null ? null : Math.round(vnd),
                    payer: e.payer || '',
                    beneficiaries,
                    expenseDate: e.expense_date || '',
                    createdTime: e.created_time || '',
                    updatedTime: e.updated_time || '',
                };
            });
        }

        function buildDailyStatsExportRows() {
            const groups = {};
            expenses.forEach(e => {
                const key = e.expense_date || '';
                if (!groups[key]) groups[key] = { count: 0, total: 0, missing: false };
                groups[key].count += 1;
                const v = amountInVND(e);
                if (v === null) groups[key].missing = true;
                else groups[key].total += v;
            });
            return Object.keys(groups)
                .sort((a, b) => {
                    if (!a) return 1;
                    if (!b) return -1;
                    return a.localeCompare(b);
                })
                .map(k => ({
                    date: k || 'Chưa có ngày',
                    count: groups[k].count,
                    total: Math.round(groups[k].total),
                    missing: groups[k].missing,
                }));
        }

        // Tiền điều kiện: gọi qua ensureXlsx() — XLSX chắc chắn đã nạp
        function exportExpensesToExcel() {
            if (!expenses.length) {
                showToast('Chưa có chi phí để xuất.', 'warning');
                return;
            }

            const expenseRows = buildExpenseExportRows();
            const sheet1 = [[
                'STT', 'Tiêu đề', 'Số tiền', 'Tiền tệ', 'Quy đổi (VND)',
                'Người trả', 'Người hưởng', 'Ngày phát sinh', 'Tạo lúc', 'Cập nhật lúc'
            ]];
            expenseRows.forEach(r => {
                sheet1.push([
                    r.stt, r.title, r.amount, r.currency,
                    r.amountVnd === null ? 'Thiếu tỷ giá' : r.amountVnd,
                    r.payer, r.beneficiaries, r.expenseDate, r.createdTime, r.updatedTime,
                ]);
            });
            const totalVnd = expenseRows.reduce((s, r) => s + (r.amountVnd || 0), 0);
            sheet1.push([]);
            sheet1.push(['', 'Tổng chi phí (VND)', '', '', totalVnd]);

            const ws1 = XLSX.utils.aoa_to_sheet(sheet1);
            ws1['!cols'] = [
                { wch: 5 }, { wch: 32 }, { wch: 12 }, { wch: 8 }, { wch: 16 },
                { wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 20 }, { wch: 20 }
            ];

            const dailyRows = buildDailyStatsExportRows();
            const sheet2 = [['Ngày phát sinh', 'Số chi phí', 'Tổng (VND)', 'Ghi chú']];
            dailyRows.forEach(r => {
                sheet2.push([r.date, r.count, r.total, r.missing ? 'Thiếu tỷ giá' : '']);
            });
            const ws2 = XLSX.utils.aoa_to_sheet(sheet2);
            ws2['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws1, 'Chi phí');
            XLSX.utils.book_append_sheet(wb, ws2, 'Theo ngày');
            XLSX.writeFile(wb, buildExportFilename('xlsx'));
            showToast('Đã xuất Excel thành công!', 'success');
        }

        // Cache font Unicode (DejaVu Sans hỗ trợ tiếng Việt) cho jsPDF
        let _pdfUnicodeFontPromise = null;
        function ensurePdfUnicodeFont() {
            if (_pdfUnicodeFontPromise) return _pdfUnicodeFontPromise;
            _pdfUnicodeFontPromise = (async () => {
                const urls = [
                    'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf',
                    'https://cdn.jsdelivr.net/gh/dejavu-fonts/dejavu-fonts@version_2_37/ttf/DejaVuSans.ttf',
                ];
                for (const url of urls) {
                    try {
                        const resp = await fetch(url);
                        if (!resp.ok) continue;
                        const buf = await resp.arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        let bin = '';
                        const chunk = 0x8000;
                        for (let i = 0; i < bytes.length; i += chunk) {
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                        }
                        return btoa(bin);
                    } catch (e) {
                        // thử URL kế tiếp
                    }
                }
                throw new Error('Không tải được font Unicode cho PDF');
            })();
            return _pdfUnicodeFontPromise;
        }

        // Tiền điều kiện: gọi qua ensureJsPdf() — jspdf + autotable chắc chắn đã nạp
        async function exportExpensesToPDF() {
            if (!expenses.length) {
                showToast('Chưa có chi phí để xuất.', 'warning');
                return;
            }

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

            let fontName = 'helvetica';
            try {
                const fontBase64 = await ensurePdfUnicodeFont();
                doc.addFileToVFS('DejaVuSans.ttf', fontBase64);
                doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
                fontName = 'DejaVuSans';
            } catch (e) {
                console.warn(e);
                showToast('Không tải được font tiếng Việt, PDF có thể hiển thị sai dấu.', 'warning');
            }

            const expenseRows = buildExpenseExportRows();
            const dailyRows = buildDailyStatsExportRows();
            const totalVnd = expenseRows.reduce((s, r) => s + (r.amountVnd || 0), 0);
            const hasMissing = expenseRows.some(r => r.amountVnd === null);
            const title = ($('#eventTitle').text() || 'Chi phí').trim();
            const exportedAt = new Date().toLocaleString('vi-VN');

            // Header
            doc.setFont(fontName, 'normal');
            doc.setFontSize(16);
            doc.setTextColor(13, 110, 253);
            doc.text(title, 14, 16);
            doc.setFontSize(9);
            doc.setTextColor(108, 117, 125);
            doc.text('Xuất lúc: ' + exportedAt, 14, 22);
            doc.setDrawColor(13, 110, 253);
            doc.setLineWidth(0.4);
            doc.line(14, 24, 196, 24);

            doc.setFontSize(10);
            doc.setTextColor(33, 37, 41);
            const summaryLine = `Số chi phí: ${expenseRows.length}    Tổng (VND): ${formatCurrency(totalVnd)}`
                + (hasMissing ? '   (một số khoản thiếu tỷ giá)' : '');
            doc.text(summaryLine, 14, 30);

            doc.setFontSize(12);
            doc.text('Danh sách chi phí', 14, 38);

            doc.autoTable({
                startY: 41,
                margin: { left: 10, right: 10 },
                head: [['STT', 'Tiêu đề', 'Số tiền', 'Quy đổi (VND)', 'Người trả', 'Người hưởng', 'Ngày']],
                body: expenseRows.map(r => [
                    String(r.stt),
                    r.title,
                    formatAmountWithCurrency(r.amount, r.currency),
                    r.amountVnd === null ? 'Thiếu tỷ giá' : formatCurrency(r.amountVnd),
                    r.payer,
                    r.beneficiaries,
                    r.expenseDate ? formatExpenseDateForDisplay(r.expenseDate) : '-',
                ]),
                styles: {
                    font: fontName,
                    fontStyle: 'normal',
                    fontSize: 8.5,
                    cellPadding: 1.6,
                    overflow: 'linebreak',
                    valign: 'middle',
                },
                headStyles: {
                    font: fontName,
                    fontStyle: 'normal',
                    fillColor: [13, 110, 253],
                    textColor: 255,
                    halign: 'center',
                },
                bodyStyles: { textColor: [33, 37, 41] },
                alternateRowStyles: { fillColor: [248, 249, 250] },
                columnStyles: {
                    0: { cellWidth: 9, halign: 'center' },
                    1: { cellWidth: 'auto' },
                    2: { cellWidth: 22, halign: 'right' },
                    3: { cellWidth: 26, halign: 'right' },
                    4: { cellWidth: 22 },
                    5: { cellWidth: 30 },
                    6: { cellWidth: 18, halign: 'center' },
                },
                didParseCell: function (data) {
                    if (data.section === 'body' && data.column.index === 3) {
                        const raw = data.cell.raw;
                        if (typeof raw === 'string' && raw.indexOf('Thiếu') === 0) {
                            data.cell.styles.textColor = [220, 53, 69];
                        }
                    }
                },
                didDrawPage: function (data) {
                    const pageCount = doc.internal.getNumberOfPages();
                    const pageNum = doc.internal.getCurrentPageInfo().pageNumber;
                    doc.setFont(fontName, 'normal');
                    doc.setFontSize(8);
                    doc.setTextColor(108, 117, 125);
                    doc.text(`Trang ${pageNum}/${pageCount}`, 196, 290, { align: 'right' });
                },
            });

            // Thống kê theo ngày — đặt ngay dưới bảng chính, sang trang nếu hết chỗ
            let cursorY = doc.lastAutoTable.finalY + 10;
            if (cursorY > 250) {
                doc.addPage();
                cursorY = 20;
            }
            doc.setFont(fontName, 'normal');
            doc.setFontSize(12);
            doc.setTextColor(33, 37, 41);
            doc.text('Thống kê theo ngày', 14, cursorY);

            doc.autoTable({
                startY: cursorY + 3,
                margin: { left: 10, right: 10 },
                tableWidth: 110,
                head: [['Ngày', 'Số chi phí', 'Tổng (VND)']],
                body: dailyRows.map(r => [
                    r.date === 'Chưa có ngày' ? r.date : formatExpenseDateForDisplay(r.date),
                    String(r.count),
                    formatCurrency(r.total) + (r.missing ? ' *' : ''),
                ]),
                styles: { font: fontName, fontStyle: 'normal', fontSize: 9, cellPadding: 1.6 },
                headStyles: {
                    font: fontName,
                    fontStyle: 'normal',
                    fillColor: [108, 117, 125],
                    textColor: 255,
                    halign: 'center',
                },
                columnStyles: {
                    0: { cellWidth: 30, halign: 'center' },
                    1: { cellWidth: 28, halign: 'center' },
                    2: { cellWidth: 52, halign: 'right' },
                },
            });

            if (hasMissing) {
                const noteY = doc.lastAutoTable.finalY + 5;
                doc.setFont(fontName, 'normal');
                doc.setFontSize(8);
                doc.setTextColor(108, 117, 125);
                doc.text('* Có chi phí thiếu tỷ giá nên chưa được tính vào tổng.', 14, noteY);
            }

            doc.save(buildExportFilename('pdf'));
            showToast('Đã xuất PDF thành công!', 'success');
        }

        function renderExpenses() {
            $('#expensesList').empty();
            rebuildFilterMemberOptions();
            updateActiveFilterBadge();

            if (expenses.length === 0) {
                $('#expensesSummary').addClass('d-none');
                $('#dailyStatsContainer').addClass('d-none');
                $('#expensesList').append('<p class="text-muted">Chưa có chi phí nào.</p>');
                autoCalculate();
                return;
            }

            // Sắp xếp danh sách chi phí theo thứ tự hiện tại
            const sortedExpenses = sortExpenses();
            // Áp các bộ lọc
            const filtered = filterExpenses(sortedExpenses);
            const filteredSet = new Set(filtered);
            const isFiltering = countActiveFilters() > 0;

            // Tính tổng chi phí (quy đổi về VND) — theo danh sách đã lọc
            let totalVND = 0;
            let hasMissingRate = false;
            filtered.forEach(e => {
                const vnd = amountInVND(e);
                if (vnd === null) {
                    hasMissingRate = true;
                } else {
                    totalVND += vnd;
                }
            });
            const countText = isFiltering
                ? `${filtered.length} <span class="text-muted">/ ${expenses.length}</span>`
                : String(expenses.length);
            $('#expensesCount').html(countText);
            const totalText = formatCurrency(totalVND) + (hasMissingRate ? ' <span class="text-danger">(thiếu tỷ giá)</span>' : '');
            $('#expensesTotal').html(totalText);
            $('#expensesSummary').removeClass('d-none');
            renderDailyStats(filtered);

            if (filtered.length === 0) {
                $('#expensesList').append('<p class="text-muted">Không có chi phí nào khớp với bộ lọc.</p>');
                autoCalculate();
                return;
            }

            const visibleLimit = Math.min(expenseDisplayLimit, filtered.length);
            let renderedCount = 0;
            sortedExpenses.forEach(function (expense, displayIndex) {
                // Bỏ qua nếu không khớp bộ lọc, nhưng STT vẫn theo full sortedExpenses
                if (!filteredSet.has(expense)) return;
                if (renderedCount >= visibleLimit) return;
                renderedCount++;
                // Tìm index gốc trong mảng expenses
                const index = expenses.indexOf(expense);
                // Số thứ tự: cũ→mới hiển thị 1..n, mới→cũ hiển thị n..1
                const stt = sortOrder === 'newest'
                    ? expenses.length - displayIndex
                    : displayIndex + 1;
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

                const expCurrency = getCurrencyOfExpense(expense);
                let amountDisplay;
                if (expCurrency === 'VND') {
                    amountDisplay = formatCurrency(expense.amount);
                } else {
                    const vnd = amountInVND(expense);
                    const base = escapeHtml(formatAmountWithCurrency(expense.amount, expCurrency));
                    amountDisplay = vnd !== null
                        ? `${base} <span class="text-muted small">(≈ ${formatCurrency(vnd)})</span>`
                        : `${base} <span class="text-danger small">(chưa có tỷ giá)</span>`;
                }

                const expenseDateBadge = expense.expense_date
                    ? `<span class="badge bg-light text-dark border ms-2" style="font-weight:500;"><i class="fas fa-calendar-day me-1"></i>${escapeHtml(formatExpenseDateForDisplay(expense.expense_date))}</span>`
                    : '';
                const timeInfoParts = [];
                if (expense.created_time) {
                    timeInfoParts.push(`<span><i class="fas fa-plus-circle me-1"></i>Tạo: ${escapeHtml(formatDateTimeForDisplay(expense.created_time))}</span>`);
                }
                if (expense.updated_time && expense.updated_time !== expense.created_time) {
                    timeInfoParts.push(`<span><i class="fas fa-pen me-1"></i>Cập nhật: ${escapeHtml(formatDateTimeForDisplay(expense.updated_time))}</span>`);
                }
                const timeInfoDisplay = timeInfoParts.length
                    ? `<div class="mt-1 small text-muted d-flex flex-wrap gap-2">${timeInfoParts.join('')}</div>`
                    : '';

                $('#expensesList').append(`
        <div class="expense-item p-2">
            <div class="d-flex justify-content-between align-items-center">
                <div>
                    <h6 class="mb-1 d-flex align-items-center flex-wrap">
                        <span class="badge bg-secondary me-2">${stt}</span>
                        <span>${escapeHtml(expense.title)}</span>
                        ${expenseDateBadge}
                    </h6>
                    <p class="mb-0 text-muted">
                        <small>${escapeHtml(expense.payer)} đã thanh toán ${amountDisplay} ${escapeHtml(benefitInfo)}</small>
                    </p>
                    ${timeInfoDisplay}
                </div>
                <div style="${!allowEdit ? 'display: none;' : ''}">
                    <button type="button" class="action-btn edit-expense" data-index="${index}" aria-label="Sửa khoản chi ${escapeHtml(expense.title)}">
                        <i class="fas fa-edit" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="action-btn delete-expense" data-index="${index}" aria-label="Xóa khoản chi ${escapeHtml(expense.title)}">
                        <i class="fas fa-trash" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        </div>
        `);
            });

            const remaining = filtered.length - visibleLimit;
            if (remaining > 0) {
                const nextBatch = Math.min(EXPENSE_PAGE_SIZE, remaining);
                $('#expensesList').append(`
                    <div class="text-center mt-2">
                        <button type="button" class="btn btn-outline-primary btn-sm" id="loadMoreExpensesBtn">
                            <i class="fas fa-chevron-down me-1"></i>Tải thêm ${nextBatch} (còn ${remaining})
                        </button>
                    </div>
                `);
            }

            autoCalculate();
        }

        // Hàm tự động tính toán nếu có dữ liệu hợp lệ
        function autoCalculate() {
            if (members.length > 0 && expenses.length > 0) {
                calculateSplit(false); // Không hiển thị thông báo lỗi
            } else {
                // Ẩn kết quả nếu không đủ dữ liệu
                $('#resultContainer').hide();
            }
        }

        // ===== "Sự Kiện Của Tôi" =====
        // Đăng nhập: danh sách lưu THEO TÀI KHOẢN (bảng saved_events, đồng bộ
        // giữa các thiết bị). Chưa đăng nhập: localStorage như cũ (chỉ để xem).
        // Đọc savedEventCodes từ localStorage an toàn: dữ liệu hỏng (JSON lỗi,
        // không phải mảng chuỗi) → trả [] thay vì throw làm kẹt luồng đang chạy.
        function readSavedEventCodes() {
            try {
                const codes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
                if (!Array.isArray(codes)) return [];
                return codes.filter(code => typeof code === 'string');
            } catch (e) {
                return [];
            }
        }

        function saveEventCodeToLocalStorage(eventCode) {
            const savedEventCodes = readSavedEventCodes();
            if (!savedEventCodes.includes(eventCode)) {
                savedEventCodes.push(eventCode);
                localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
            }
        }

        function removeEventCodeFromLocalStorage(eventCode) {
            const savedEventCodes = readSavedEventCodes().filter(code => code !== eventCode);
            localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
        }

        // Ghi nhớ event vào "Sự Kiện Của Tôi": đăng nhập → lưu theo tài khoản
        // (idempotent, fire-and-forget — lỗi mạng thì lần mở sau lưu lại);
        // chưa đăng nhập → localStorage.
        function rememberEvent(eventCode) {
            if (AppAuth.isLoggedIn()) {
                $.ajax({
                    url: '/api/my-events/save',
                    method: 'POST',
                    contentType: 'application/json',
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify({ codes: [eventCode] })
                });
            } else {
                saveEventCodeToLocalStorage(eventCode);
            }
        }

        // Migration một lần: đẩy danh sách đã lưu trên máy lên tài khoản rồi
        // XÓA local — nếu giữ lại, event đã gỡ trên máy khác sẽ "hồi sinh"
        // ở lần merge sau. Thất bại thì giữ nguyên local, lần đăng nhập sau thử lại.
        function migrateLocalSavedEvents() {
            if (!AppAuth.isLoggedIn()) return;
            const codes = readSavedEventCodes();
            if (codes.length === 0) return;
            const batches = [];
            for (let i = 0; i < codes.length; i += 50) batches.push(codes.slice(i, i + 50));
            Promise.all(batches.map(batch => $.ajax({
                url: '/api/my-events/save',
                method: 'POST',
                contentType: 'application/json',
                headers: AppAuth.authHeaders(),
                data: JSON.stringify({ codes: batch })
            }))).then(function () {
                localStorage.removeItem('savedEventCodes');
            }).catch(function () { /* giữ nguyên local, lần đăng nhập sau thử lại */ });
        }

        // Hàm hiển thị danh sách sự kiện đã lưu.
        // Đăng nhập: danh sách theo TÀI KHOẢN (/api/my-events = sở hữu ∪ được
        // mời ∪ đã lưu). Chưa đăng nhập: danh sách localStorage của máy này.
        function renderSavedEvents() {
            $('#savedEventsList').empty();
            $('#savedEventsList').append('<p class="text-center text-muted">Đang tải...</p>');

            const loggedIn = AppAuth.isLoggedIn();
            const emptyText = loggedIn
                ? 'Chưa có sự kiện nào trong tài khoản của bạn.'
                : 'Chưa có sự kiện nào được lưu trên máy này.';

            // Tiêu đề + mô tả modal theo trạng thái đăng nhập: đăng nhập → danh
            // sách đồng bộ theo tài khoản; chưa đăng nhập → danh sách của máy này.
            $('#savedEventsModalTitle').text(loggedIn
                ? 'Sự Kiện Của Tôi'
                : 'Sự Kiện Đã Lưu Trên Máy Này');
            $('#savedEventsModalDesc').text(loggedIn
                ? 'Danh sách này đồng bộ theo tài khoản của bạn (sự kiện bạn sở hữu, được mời hoặc đã lưu) — đăng nhập trên máy nào cũng thấy.'
                : 'Danh sách này chỉ hiển thị các sự kiện đã được lưu trên máy này. Mỗi máy sẽ có danh sách sự kiện riêng.');

            function fail() {
                $('#savedEventsList').empty();
                $('#savedEventsList').append('<p class="text-center text-danger">Không tải được danh sách sự kiện. Vui lòng thử lại.</p>');
            }

            // localCodes chỉ có ở nhánh chưa đăng nhập — dùng để dọn mã đã chết
            function proceed(codes, ownedByCode, localCodes) {
                if (codes.length === 0) {
                    $('#savedEventsList').empty();
                    $('#savedEventsList').append(`<p class="text-center text-muted">${emptyText}</p>`);
                    return;
                }
                // lookup nhận tối đa 50 mã/request → chia lô, tra song song rồi gộp
                const batches = [];
                for (let i = 0; i < codes.length; i += 50) batches.push(codes.slice(i, i + 50));
                Promise.all(batches.map(batch => $.ajax({
                    url: '/api/events/lookup',
                    method: 'POST',
                    contentType: 'application/json',
                    // Kèm JWT: event ở chế độ "Hạn chế" chỉ hiện với owner/người được mời
                    headers: AppAuth.authHeaders(),
                    data: JSON.stringify({ codes: batch }),
                }).then(function (response) {
                    return (response && response.events) || [];
                }))).then(function (results) {
                    const events = [].concat(...results);
                    // Chỉ dọn mã LOCAL khi TẤT CẢ các lô tra cứu thành công —
                    // lỗi mạng ở lô nào đó không đồng nghĩa event không còn tồn tại.
                    const found = new Set(events.map(e => e.event_code));
                    (localCodes || [])
                        .filter(code => !found.has(code))
                        .forEach(removeEventCodeFromLocalStorage);
                    displaySavedEvents(events, ownedByCode, emptyText);
                }).catch(fail);
            }

            if (loggedIn) {
                $.ajax({ url: '/api/my-events', headers: AppAuth.authHeaders() })
                    .done(function (r) {
                        const list = (r && r.events) || [];
                        const ownedByCode = {};
                        list.forEach(e => { ownedByCode[e.event_code] = !!e.owned; });
                        proceed(list.map(e => e.event_code), ownedByCode, []);
                    })
                    .fail(fail);
            } else {
                const localCodes = readSavedEventCodes();
                proceed(localCodes, {}, localCodes);
            }
        }

        // Vừa đăng nhập xong mà đang có dữ liệu nháp chưa tạo trên server → tạo luôn.
        // Đang mở event thì tải lại để server tính lại can_edit (đăng nhập → cho
        // phép chỉnh sửa; đăng xuất → về chỉ xem + banner). CHỈ tải lại khi trạng
        // thái đăng nhập thực sự đổi — appauth:change còn bắn cả khi refresh token
        // (~mỗi giờ), reload lúc đó sẽ xóa mất form người dùng đang nhập dở.
        let lastAuthLoggedIn = null;
        document.addEventListener('appauth:change', function () {
            const loggedIn = AppAuth.isLoggedIn();
            const changed = lastAuthLoggedIn !== null && loggedIn !== lastAuthLoggedIn;
            lastAuthLoggedIn = loggedIn;
            if (loggedIn) migrateLocalSavedEvents();
            if (loggedIn && !currentEventCode && allowEdit && members.length > 0) {
                saveEvent(false);
            } else if (changed && currentEventCode) {
                loadEventFromServer(currentEventCode);
            }
        });

        $(document).on('click', '#loginToEditBtn', function () {
            AppAuth.showLoginModal();
        });

        // Tính tổng chi phí của một sự kiện (quy đổi về VND theo rates riêng của sự kiện)
        function computeSavedEventTotal(event) {
            if (!event || !event.expenses || event.expenses.length === 0) {
                return { total: 0, missingRates: [] };
            }
            const eventRates = event.rates || {};
            const missingRates = new Set();
            let total = 0;
            event.expenses.forEach(exp => {
                const amt = parseFloat(exp.amount) || 0;
                const cur = (exp && exp.currency) ? exp.currency : 'VND';
                if (cur === 'VND') {
                    total += amt;
                    return;
                }
                const entry = eventRates[cur];
                const rate = (entry && typeof entry.rate === 'number' && entry.rate > 0) ? entry.rate : null;
                if (rate === null) {
                    missingRates.add(cur);
                    return;
                }
                total += amt * rate;
            });
            return { total, missingRates: Array.from(missingRates) };
        }

        // Hàm hiển thị danh sách sự kiện
        function displaySavedEvents(events, ownedByCode, emptyText) {
            $('#savedEventsList').empty();

            if (events.length === 0) {
                $('#savedEventsList').append(`<p class="text-center text-muted">${emptyText}</p>`);
                return;
            }

            // Sắp xếp theo thời gian cập nhật mới nhất
            events.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

            events.forEach(function(event) {
                const date = new Date(event.updated_at).toLocaleDateString('vi-VN');
                const time = new Date(event.updated_at).toLocaleTimeString('vi-VN', {hour: '2-digit', minute: '2-digit'});
                const { total, missingRates } = computeSavedEventTotal(event);
                const totalLabel = missingRates.length > 0
                    ? `${formatCurrency(total)} <span class="text-danger small">(thiếu tỷ giá: ${escapeHtml(missingRates.join(', '))})</span>`
                    : formatCurrency(total);
                const safeCode = escapeHtml(event.event_code);
                // Owner → xóa thật; còn lại → chỉ gỡ khỏi danh sách của mình
                const owned = !!(ownedByCode && ownedByCode[event.event_code]);
                const actionBtn = owned
                    ? `<button class="btn btn-sm btn-danger delete-event-btn" data-event-code="${safeCode}" title="Xóa sự kiện">
                            <i class="fas fa-trash"></i>
                       </button>`
                    : `<button class="btn btn-sm btn-outline-secondary unsave-event-btn" data-event-code="${safeCode}" title="Gỡ khỏi danh sách">
                            <i class="fas fa-times"></i>
                       </button>`;

                $('#savedEventsList').append(`
                    <div class="list-group-item list-group-item-action event-item" data-event-code="${safeCode}">
                        <div class="d-flex w-100 justify-content-between">
                            <h5 class="mb-1">${escapeHtml(event.title)}</h5>
                            <small class="text-muted">${date} ${time}</small>
                        </div>
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <p class="mb-1">Số thành viên: ${event.members ? event.members.length : 0}</p>
                                <p class="mb-1">Số chi phí: ${event.expenses ? event.expenses.length : 0}</p>
                                <p class="mb-1">Tổng chi phí: ${totalLabel}</p>
                                <small class="text-muted">Mã: ${safeCode}</small>
                            </div>
                            <div>
                                <button class="btn btn-sm btn-outline-primary me-1 share-event-btn" data-event-code="${safeCode}">
                                    <i class="fas fa-share-alt"></i>
                                </button>
                                ${actionBtn}
                            </div>
                        </div>
                    </div>
                `);
            });
        }

        // Thuật toán chia tiền — toàn bộ tính toán nằm trong SplitLogic.computeSplit
        // (static/split.js, có unit test bằng Node); ở đây chỉ render kết quả.
        function calculateSplit(showErrors = true) {
            if (members.length === 0) {
                if (showErrors) showToast('Vui lòng thêm ít nhất một thành viên!', 'warning');
                $('#resultContainer').hide();
                return;
            }

            if (expenses.length === 0) {
                if (showErrors) showToast('Vui lòng thêm ít nhất một chi phí!', 'warning');
                $('#resultContainer').hide();
                return;
            }

            const result = SplitLogic.computeSplit({ members, expenses, couples, rates });

            if (result.missingRates.length > 0) {
                if (showErrors) showToast(`Thiếu tỷ giá cho: ${result.missingRates.join(', ')}. Vui lòng bấm "Tỷ giá" để thiết lập.`, 'warning');
                $('#resultContainer').hide();
                return;
            }

            const coupleByMember = result.validCouples.byMember;

            // Hiển thị tổng quan
            $('#summaryTableBody').empty();
            members.forEach(member => {
                const info = result.memberInfo[member] || { paid: 0, needToPay: 0 };

                const couple = coupleByMember[member];
                const isPrimary = couple && couple.primary === member;
                const coupleTag = couple
                    ? `<span class="couple-badge ms-1" title="Nhóm: ${escapeHtml(formatCoupleLabel(couple))}">
                         ${isPrimary ? '<span class="primary-dot"></span>' : ''}
                         <i class="fas fa-heart me-1" style="font-size:0.65rem;"></i>${escapeHtml(formatCoupleLabel(couple))}
                       </span>`
                    : '';

                let balanceCell;
                if (couple && !isPrimary) {
                    balanceCell = `<td class="text-end text-muted small">→ gộp vào ${escapeHtml(couple.primary)}</td>`;
                } else {
                    // Số dư nguyên VND đã khử lệch làm tròn — khớp chính xác với các giao dịch
                    const b = result.roundedBalances[member] || 0;
                    balanceCell = `<td class="text-end ${b >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(b)}</td>`;
                }

                $('#summaryTableBody').append(`
        <tr>
            <td>${escapeHtml(member)}${coupleTag}</td>
            <td class="text-end">${formatCurrency(info.paid)}</td>
            <td class="text-end">${formatCurrency(info.needToPay)}</td>
            ${balanceCell}
        </tr>
        `);
            });

            // Hiển thị các giao dịch chuyển tiền
            $('#transfersList').empty();

            if (result.transfers.length === 0) {
                $('#transfersList').append('<p class="text-muted">Không cần chuyển tiền.</p>');
            } else {
                result.transfers.forEach(transfer => {
                    $('#transfersList').append(`
            <div class="transfer-item">
                <i class="fas fa-exchange-alt me-2"></i>
                <strong>${escapeHtml(transfer.from)}</strong> chuyển <strong>${formatCurrency(transfer.amount)}</strong> cho <strong>${escapeHtml(transfer.to)}</strong>
                <div class="mt-2">
                    <button class="btn btn-sm btn-outline-primary generate-qr-btn" data-from="${escapeHtml(transfer.from)}" data-to="${escapeHtml(transfer.to)}" data-amount="${transfer.amount}">
                        <i class="fas fa-qrcode me-1"></i> Bấm vào đây để tạo QR chuyển tiền
                    </button>
                </div>
            </div>
            `);
                });
            }

            // Hiển thị kết quả
            $('#resultContainer').show();
            // Lưu ý: KHÔNG saveEvent() ở đây — các thao tác thay đổi dữ liệu
            // đã tự lưu; gọi thêm ở đây gây double-PUT cho mỗi thao tác.
        }

        function renderBeneficiaries() {
            $('#beneficiariesList').empty();

            members.forEach(function (member, idx) {
                const id = `benefit_idx_${idx}`;
                const $row = $(`
            <div class="form-check">
                <input class="form-check-input beneficiary-checkbox" type="checkbox" id="${id}">
                <label class="form-check-label" for="${id}"></label>
            </div>
        `);
                // Set value và label text qua DOM API để tránh lỗi escape khi tên chứa
                // ký tự đặc biệt (dấu nháy, dấu ngoặc, ký tự đặc biệt…)
                $row.find('input').val(member);
                $row.find('label').text(member);
                $('#beneficiariesList').append($row);
            });
        }

        // Hiển thị hoặc ẩn danh sách người hưởng lợi dựa vào loại hưởng lợi
        $('#benefitType').change(function () {
            if (!allowEdit) return; // Không cho phép thay đổi nếu ở chế độ chỉ xem
            
            if ($(this).val() === 'selected') {
                $('#beneficiariesContainer').show();
                renderBeneficiaries();
            } else {
                $('#beneficiariesContainer').hide();
            }
        });


        // Xử lý khi bấm nút "Chọn tất cả"
        $('#selectAllBeneficiaries').click(function () {
            if (!allowEdit) return; // Không cho phép chọn nếu ở chế độ chỉ xem
            
            const allChecked = $('.beneficiary-checkbox').length === $('.beneficiary-checkbox:checked').length;
            $('.beneficiary-checkbox').prop('checked', !allChecked);
        });


        // Xử lý thêm thành viên
        $('#memberForm').submit(function (e) {
            e.preventDefault();
            if (!allowEdit) return; // Không cho phép thêm nếu ở chế độ chỉ xem
            
            const memberName = $('#memberName').val().trim();

            if (memberName) {
                if (members.includes(memberName)) {
                    showToast('Thành viên này đã được thêm vào danh sách!', 'warning');
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
            } else {
                showToast('Vui lòng nhập tên thành viên!', 'warning');
            }
        });

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

                // index chụp trước khi showConfirm mở có thể ôi (mảng members đổi do
                // reload nền) — tra lại theo tên thay vì dùng index cũ.
                const idx = members.indexOf(memberToRemove);
                if (idx === -1) return;
                members.splice(idx, 1);

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

        // Xử lý thêm chi phí
        $('#expenseForm').submit(function (e) {
            e.preventDefault();
            if (!allowEdit) return; // Không cho phép thêm nếu ở chế độ chỉ xem
            
            const title = $('#expenseTitle').val().trim();
            const amountStr = $('#expenseAmount').val().trim();
            const payer = $('#expensePayer').val();
            const benefitType = $('#benefitType').val();

            if (!title) {
                showToast('Vui lòng nhập mục chi tiêu!', 'warning');
                return;
            }

            let amount = parseFloat(amountStr);
            if (!amountStr || isNaN(amount) || !isFinite(amount) || amount <= 0) {
                showToast('Vui lòng nhập số tiền hợp lệ!', 'warning');
                return;
            }

            // Checkbox "K" = nghìn: NHÂN 1000, không nối chuỗi (nối chuỗi làm
            // "1.5" thành "1.5000" = 1.5 thay vì 1500)
            if ($('#addZerosCheckbox').is(':checked')) {
                amount = amount * 1000;
            }

            if (!payer) {
                showToast('Vui lòng chọn người thanh toán!', 'warning');
                return;
            }

            // Xác định người hưởng lợi
            let beneficiaries = [];

            if (benefitType === 'all') {
                // Nếu là tất cả, thêm toàn bộ thành viên
                beneficiaries = [...members];
            } else {
                // Nếu chỉ là một số người, lấy danh sách từ checkbox đã chọn
                $('.beneficiary-checkbox:checked').each(function () {
                    beneficiaries.push($(this).val());
                });

                // Kiểm tra nếu không có ai được chọn
                if (beneficiaries.length === 0) {
                    showToast('Vui lòng chọn ít nhất một người được hưởng lợi!', 'warning');
                    return;
                }
            }

            const currency = $('#expenseCurrency').val() || 'VND';
            if (currency !== 'VND' && getRateToVND(currency) === null) {
                showToast(`Chưa có tỷ giá cho ${currency}. Vui lòng bấm "Cấu hình tỷ giá" để thêm!`, 'warning');
                return;
            }

            const nowIso = new Date().toISOString();
            const expenseDate = $('#expenseDate').val() || todayISODate();
            const createdTime = $('#expenseCreatedTime').val() || nowIso;

            const expenseData = {
                title: title,
                amount: amount,
                currency: currency,
                payer: payer,
                // Luôn lưu đích danh; chọn "Tất cả" trên form chỉ là shortcut
                // chốt đủ thành viên tại thời điểm lưu
                benefitType: 'selected',
                beneficiaries: beneficiaries,
                expense_date: expenseDate,
                created_time: createdTime,
                updated_time: nowIso
            };

            const isAdding = editingExpenseIndex === null;
            if (editingExpenseIndex !== null && expenses[editingExpenseIndex]) {
                // Cập nhật tại chỗ, giữ created_time gốc
                expenseData.created_time = expenses[editingExpenseIndex].created_time || createdTime;
                expenses[editingExpenseIndex] = expenseData;
            } else {
                expenses.push(expenseData);
            }

            // Thoát edit mode (cũng reset form & re-render)
            exitEditExpenseMode();

            // Tự động lưu sau khi thêm/cập nhật chi phí
            saveEvent(false);

            showToast(isAdding ? `Đã thêm chi phí "${title}"!` : `Đã cập nhật chi phí "${title}"!`, 'success');

            // Focus lại ô Mục chi tiêu để nhập tiếp khi vừa thêm mới
            if (isAdding) {
                $('#expenseTitle').trigger('focus');
            }
        });

        // Xử lý xóa chi phí
        $(document).on('click', '.delete-expense', function () {
            if (!allowEdit) return; // Không cho phép xóa nếu ở chế độ chỉ xem

            const index = $(this).data('index');
            const expense = expenses[index];
            if (!expense) return;

            const title = expense.title || '(không có tên)';
            const cur = getCurrencyOfExpense(expense) || 'VND';
            const amountDisplay = new Intl.NumberFormat('vi-VN').format(Math.round(expense.amount || 0)) + ' ' + cur;
            showConfirm(`Bạn có chắc chắn muốn xoá chi phí "${title}" (${amountDisplay})?`, function () {
                // index chụp trước khi showConfirm mở có thể ôi (mảng expenses bị
                // thay do reload nền 409/đổi tài khoản) — tra lại theo object.
                const idx = expenses.indexOf(expense);
                if (idx === -1) return;
                expenses.splice(idx, 1);

                // Đồng bộ editingExpenseIndex nếu đang ở edit mode
                if (editingExpenseIndex !== null) {
                    if (editingExpenseIndex === idx) {
                        // Xoá chính expense đang sửa → thoát edit mode
                        exitEditExpenseMode();
                    } else if (editingExpenseIndex > idx) {
                        editingExpenseIndex -= 1;
                    }
                }

                renderExpenses();

                // Tự động lưu sau khi xóa chi phí
                saveEvent(false);
                showToast(`Đã xoá chi phí "${title}"!`, 'success');
                // Không cần gọi autoCalculate() vì đã được gọi trong renderExpenses()
            }, { okLabel: 'Xóa' });
        });

        // Resize biểu đồ thống kê khi mở collapse (canvas cần kích thước thật)
        $('#dailyStatsBody').on('shown.bs.collapse', function () {
            if (dailyStatsChartInstance) dailyStatsChartInstance.resize();
        });

        // Xuất Excel / PDF — thư viện lazy-load, tải xong mới export
        $('#exportExcelBtn').click(function () {
            ensureXlsx().then(exportExpensesToExcel).catch(function () {
                showToast('Không tải được thư viện xuất Excel — kiểm tra mạng rồi thử lại.', 'error');
            });
        });
        $('#exportPdfBtn').click(async function () {
            const $btn = $(this);
            const original = $btn.html();
            $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin me-1"></i>Đang xuất...');
            try {
                await ensureJsPdf();
                await exportExpensesToPDF();
            } catch (err) {
                console.error(err);
                showToast('Không thể xuất PDF: ' + err.message, 'error');
            } finally {
                $btn.prop('disabled', false).html(original);
            }
        });

        // Xử lý nút sắp xếp danh sách chi phí
        $('#sortExpensesBtn').click(function () {
            // Đảo ngược thứ tự sắp xếp
            sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';

            // Cập nhật text hiển thị
            $('#sortText').text(sortOrder === 'newest' ? 'Mới nhất' : 'Cũ nhất');

            // Cập nhật icon
            const icon = sortOrder === 'newest' ? 'fa-sort-down' : 'fa-sort-up';
            $('#sortExpensesBtn i').removeClass('fa-sort fa-sort-up fa-sort-down').addClass(icon);

            // Render lại danh sách chi phí
            expenseDisplayLimit = EXPENSE_PAGE_SIZE;
            renderExpenses();
        });

        // Tải thêm chi phí (mỗi lần +10)
        $('#expensesList').on('click', '#loadMoreExpensesBtn', function () {
            expenseDisplayLimit += EXPENSE_PAGE_SIZE;
            renderExpenses();
        });

        // ======= Bộ lọc danh sách chi phí =======
        let _filterSearchTimer = null;
        $('#filterSearch').on('input', function () {
            clearTimeout(_filterSearchTimer);
            _filterSearchTimer = setTimeout(function () {
                expenseDisplayLimit = EXPENSE_PAGE_SIZE;
                renderExpenses();
            }, 150);
        });
        $('#filterPayer, #filterBeneficiary, #filterDateField, #filterDateFrom, #filterDateTo').on('change', function () {
            expenseDisplayLimit = EXPENSE_PAGE_SIZE;
            renderExpenses();
        });
        $('#clearFiltersBtn').click(function () {
            const hadFilters = countActiveFilters() > 0;
            $('#filterSearch').val('');
            $('#filterPayer').val('');
            $('#filterBeneficiary').val('');
            $('#filterDateField').val('expense_date');
            $('#filterDateFrom').val('');
            $('#filterDateTo').val('');
            expenseDisplayLimit = EXPENSE_PAGE_SIZE;
            renderExpenses();
            if (hadFilters) {
                showToast('Đã xoá tất cả bộ lọc!', 'success');
            }
        });

        // ======= Nhóm chung quỹ =======
        function generateCoupleId() {
            return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }

        function renderCouplesModal() {
            const $list = $('#couplesList');
            $list.empty();

            if (members.length < 2) {
                $list.append('<div class="alert alert-warning mb-0">Cần ít nhất 2 thành viên trước khi tạo nhóm chung quỹ.</div>');
                $('#addCoupleBtn').prop('disabled', true);
                return;
            }
            $('#addCoupleBtn').prop('disabled', false);

            if (couplesDraft.length === 0) {
                $list.append('<p class="text-muted mb-2">Chưa có nhóm nào. Bấm "Thêm nhóm mới" để tạo.</p>');
                return;
            }

            couplesDraft.forEach((couple, ci) => {
                const selectedMembers = (couple.members || []).filter(m => members.includes(m));
                const primary = selectedMembers.includes(couple.primary) ? couple.primary : (selectedMembers[0] || '');

                const memberOptions = members.map(m => {
                    const checked = selectedMembers.includes(m) ? 'checked' : '';
                    return `<label class="me-2">
                        <input type="checkbox" class="couple-member-cb" data-ci="${ci}" value="${escapeHtml(m)}" ${checked}> ${escapeHtml(m)}
                    </label>`;
                }).join('');

                const primaryOptions = selectedMembers.length > 0
                    ? selectedMembers.map(m => {
                        const checked = m === primary ? 'checked' : '';
                        return `<label class="me-2">
                            <input type="radio" class="couple-primary-rb" name="primary-${ci}" data-ci="${ci}" value="${escapeHtml(m)}" ${checked}> ${escapeHtml(m)}
                        </label>`;
                    }).join('')
                    : '<span class="text-muted small">Chọn thành viên trước</span>';

                $list.append(`
                    <div class="couple-row" data-ci="${ci}">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <strong><i class="fas fa-heart text-danger me-1"></i>Nhóm ${ci + 1}</strong>
                            <button type="button" class="btn btn-sm btn-outline-danger remove-couple-btn" data-ci="${ci}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                        <div class="mb-2">
                            <label class="form-label small mb-1">Tên nhóm (tùy chọn)</label>
                            <input type="text" class="form-control form-control-sm couple-label-input" data-ci="${ci}"
                                   value="${escapeHtml(couple.label || '')}" placeholder="Ví dụ: Vợ chồng An & Bình">
                        </div>
                        <div class="mb-2">
                            <div class="small text-muted mb-1">Thành viên trong nhóm:</div>
                            <div class="couple-member-options">${memberOptions}</div>
                        </div>
                        <div>
                            <div class="small text-muted mb-1">Người đại diện (người đứng tên chuyển/nhận tiền):</div>
                            <div class="couple-member-options">${primaryOptions}</div>
                        </div>
                    </div>
                `);
            });
        }

        $('#manageCouplesBtn').click(function () {
            if (!allowEdit) return;
            if (members.length === 0) {
                showToast('Vui lòng thêm thành viên trước!', 'warning');
                return;
            }
            // Deep clone để chỉnh sửa không ảnh hưởng state gốc cho tới khi Save
            couplesDraft = JSON.parse(JSON.stringify(couples || []));
            renderCouplesModal();
            $('#couplesModal').modal('show');
        });

        $('#addCoupleBtn').click(function () {
            couplesDraft.push({ id: generateCoupleId(), label: '', members: [], primary: '' });
            renderCouplesModal();
        });

        $(document).on('click', '.remove-couple-btn', function () {
            const ci = $(this).data('ci');
            couplesDraft.splice(ci, 1);
            renderCouplesModal();
        });

        $(document).on('change', '.couple-member-cb', function () {
            const ci = $(this).data('ci');
            const name = $(this).val();
            const couple = couplesDraft[ci];
            if (!couple) return;
            couple.members = couple.members || [];
            if (this.checked) {
                if (!couple.members.includes(name)) couple.members.push(name);
            } else {
                couple.members = couple.members.filter(m => m !== name);
                if (couple.primary === name) couple.primary = couple.members[0] || '';
            }
            if (!couple.primary && couple.members.length > 0) couple.primary = couple.members[0];
            renderCouplesModal();
        });

        $(document).on('change', '.couple-primary-rb', function () {
            const ci = $(this).data('ci');
            if (couplesDraft[ci]) {
                couplesDraft[ci].primary = $(this).val();
            }
        });

        $(document).on('input', '.couple-label-input', function () {
            const ci = $(this).data('ci');
            if (couplesDraft[ci]) {
                couplesDraft[ci].label = $(this).val();
            }
        });

        $('#saveCouplesBtn').click(function () {
            // Validate và chuẩn hóa
            const cleaned = [];
            const seen = new Set();
            for (const c of couplesDraft) {
                const memberList = (c.members || []).filter(m => members.includes(m));
                if (memberList.length < 2) continue; // bỏ nhóm chỉ có <2 người
                // Một thành viên chỉ được thuộc 1 nhóm
                const dup = memberList.find(m => seen.has(m));
                if (dup) {
                    showToast(`Thành viên "${dup}" đang ở trong nhiều nhóm. Vui lòng kiểm tra lại!`, 'warning');
                    return;
                }
                memberList.forEach(m => seen.add(m));
                const primary = memberList.includes(c.primary) ? c.primary : memberList[0];
                cleaned.push({
                    id: c.id || generateCoupleId(),
                    label: (c.label || '').trim(),
                    members: memberList,
                    primary
                });
            }
            couples = cleaned;
            $('#couplesModal').modal('hide');
            renderMembers();
            saveEvent(false);
            if (expenses.length > 0) calculateSplit(false);
            showToast('Đã cập nhật nhóm chung quỹ!', 'success');
        });
        // ======= Hết phần nhóm chung quỹ =======

        // ======= Cấu hình tỷ giá =======
        function renderRatesTable() {
            const $tb = $('#ratesTableBody');
            $tb.empty();
            const codes = Object.keys(ratesDraft).sort();
            // Luôn gợi ý thêm các currency đang dùng trong expenses mà chưa có trong ratesDraft
            collectCurrenciesFromExpenses().forEach(c => {
                if (!ratesDraft[c]) {
                    ratesDraft[c] = { rate: null, source: 'missing', rateDate: null, rateType: null };
                    if (!codes.includes(c)) codes.push(c);
                }
            });
            codes.sort();
            if (codes.length === 0) {
                $tb.append('<tr><td colspan="5" class="text-center text-muted">Chưa có ngoại tệ nào. Thêm ở ô bên dưới hoặc bấm "Lấy tỷ giá".</td></tr>');
                return;
            }
            codes.forEach(code => {
                const entry = ratesDraft[code] || {};
                const rateVal = (typeof entry.rate === 'number' && entry.rate > 0) ? entry.rate : '';
                const name = CURRENCY_NAME[code] || entry.currencyName || '';
                const sourceBadge = renderSourceBadge(entry);
                const safeCode = escapeHtml(code);
                $tb.append(`
                    <tr data-code="${safeCode}">
                        <td><strong>${safeCode}</strong></td>
                        <td class="small text-muted">${escapeHtml(name)}</td>
                        <td class="text-end">
                            <input type="number" step="0.0001" min="0" class="form-control form-control-sm text-end rates-rate-input"
                                   value="${rateVal}" data-code="${safeCode}" style="max-width:180px;display:inline-block;">
                        </td>
                        <td>${sourceBadge}</td>
                        <td class="text-end">
                            <button class="btn btn-sm btn-outline-danger rates-remove-btn" data-code="${safeCode}" title="Xóa">
                                <i class="fas fa-times"></i>
                            </button>
                        </td>
                    </tr>
                `);
            });
        }

        function openRatesModal() {
            if (!allowEdit) return;
            ratesDraft = JSON.parse(JSON.stringify(rates || {}));
            $('#ratesDate').val(todayISODate());
            $('#ratesStatus').text('');
            renderRatesTable();
            $('#ratesModal').modal('show');
        }

        $('#configRatesBtn').click(openRatesModal);
        $('#openRatesFromFormBtn').click(openRatesModal);

        const SOURCE_LABEL = {
            'fawazahmed0': 'Fawazahmed0 (mid-market)',
            'exchangerate-api': 'exchangerate-api.com (mid-market)',
            'vietcombank-mid': 'Vietcombank (trung bình mua-bán)',
            'vietcombank': 'Vietcombank',
        };
        const RATE_TYPE_LABEL = {
            'mid': 'thị trường',
            'transfer': 'chuyển khoản',
            'cash': 'tiền mặt',
            'sell': 'bán ra',
        };

        $('#fetchRatesBtn').click(function () {
            const date = $('#ratesDate').val() || todayISODate();
            const rateType = $('#ratesType').val() || 'mid';
            const $btn = $(this);
            $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin me-1"></i>Đang lấy...');
            $('#ratesStatus').text('');
            $.ajax({
                url: '/api/exchange-rates?date=' + encodeURIComponent(date) + '&type=' + encodeURIComponent(rateType),
                method: 'GET',
                success: function (resp) {
                    if (!resp.success) {
                        $('#ratesStatus').html(`<span class="text-danger">${escapeHtml(resp.error || 'Lỗi không xác định')}</span>`);
                        showToast(resp.error || 'Không lấy được tỷ giá!', 'error');
                        return;
                    }
                    const src = resp.rates || {};
                    const codesToUpdate = new Set([
                        ...Object.keys(ratesDraft),
                        ...collectCurrenciesFromExpenses(),
                    ]);
                    // Nếu chưa có gì, lấy các currency thông dụng mà nguồn trả về
                    if (codesToUpdate.size === 0) {
                        COMMON_CURRENCIES.forEach(c => {
                            if (c.code !== 'VND' && src[c.code]) codesToUpdate.add(c.code);
                        });
                    }
                    let updated = 0, missing = [];
                    codesToUpdate.forEach(code => {
                        if (code === 'VND') return;
                        const entry = src[code];
                        if (!entry) { missing.push(code); return; }
                        const rate = entry.rate || entry[rateType];
                        if (!rate || rate <= 0) { missing.push(code); return; }
                        ratesDraft[code] = {
                            rate: rate,
                            source: resp.source || 'api',
                            rateDate: (resp.date || date || '').slice(0, 10),
                            rateType: resp.rateType || rateType,
                            currencyName: entry.currencyName || CURRENCY_NAME[code] || '',
                        };
                        updated++;
                    });
                    const srcLabel = SOURCE_LABEL[resp.source] || escapeHtml(resp.source || 'API');
                    const typeLabel = escapeHtml(RATE_TYPE_LABEL[resp.rateType || rateType] || rateType);
                    let msg = `Đã cập nhật ${updated} tỷ giá từ <strong>${srcLabel}</strong> (${typeLabel}, ngày ${escapeHtml((resp.date || date || '').slice(0, 10))}).`;
                    if (missing.length > 0) msg += ` Không có tỷ giá cho: ${escapeHtml(missing.join(', '))}.`;
                    $('#ratesStatus').html(`<span class="text-success">${msg}</span>`);
                    renderRatesTable();
                    showToast(`Đã lấy ${updated} tỷ giá từ ${srcLabel}!`, 'success');
                },
                error: function (xhr) {
                    let err = 'Không kết nối được máy chủ.';
                    try { err = JSON.parse(xhr.responseText).error || err; } catch (_) {}
                    $('#ratesStatus').html(`<span class="text-danger">${escapeHtml(err)}</span>`);
                    showToast(err, 'error');
                },
                complete: function () {
                    $btn.prop('disabled', false).html('<i class="fas fa-sync-alt me-1"></i>Lấy tỷ giá');
                }
            });
        });

        $(document).on('input', '.rates-rate-input', function () {
            const code = $(this).data('code');
            const v = parseFloat($(this).val());
            if (!ratesDraft[code]) ratesDraft[code] = {};
            if (!isNaN(v) && v > 0) {
                const previous = ratesDraft[code];
                // Giữ nguyên source nếu user không sửa rate; đổi sang custom nếu sửa khác
                const keepSource = previous && API_SOURCES.has(previous.source) && previous.rate === v;
                ratesDraft[code] = {
                    ...previous,
                    rate: v,
                    source: keepSource ? previous.source : 'custom',
                };
            } else {
                ratesDraft[code].rate = null;
                ratesDraft[code].source = 'missing';
            }
            // Re-render badge only (tránh mất focus input)
            const $row = $(this).closest('tr');
            $row.find('td').eq(3).html(renderSourceBadge(ratesDraft[code]));
        });

        $(document).on('click', '.rates-remove-btn', function () {
            const code = $(this).data('code');
            delete ratesDraft[code];
            renderRatesTable();
        });

        $('#addCurrencyBtn').click(function () {
            const code = ($('#addCurrencyCode').val() || '').trim().toUpperCase();
            if (!code || code === 'VND') {
                showToast('Vui lòng nhập mã tiền tệ (không phải VND).', 'warning');
                return;
            }
            const isNew = !ratesDraft[code];
            if (!ratesDraft[code]) {
                ratesDraft[code] = { rate: null, source: 'missing' };
            }
            $('#addCurrencyCode').val('');
            renderRatesTable();
            if (isNew) {
                showToast(`Đã thêm tiền tệ ${code}. Vui lòng nhập tỷ giá!`, 'success');
            } else {
                showToast(`Tiền tệ ${code} đã có sẵn trong danh sách.`, 'info');
            }
        });

        $('#saveRatesBtn').click(function () {
            // Chỉ giữ các entry có rate hợp lệ
            const cleaned = {};
            Object.keys(ratesDraft).forEach(code => {
                const entry = ratesDraft[code];
                if (entry && typeof entry.rate === 'number' && entry.rate > 0) {
                    cleaned[code] = {
                        rate: entry.rate,
                        source: API_SOURCES.has(entry.source) ? entry.source : 'custom',
                        rateDate: entry.rateDate || null,
                        rateType: entry.rateType || null,
                        currencyName: entry.currencyName || CURRENCY_NAME[code] || '',
                    };
                }
            });
            rates = cleaned;
            $('#ratesModal').modal('hide');
            renderCurrencyDropdown();
            updateAmountPreview();
            renderExpenses();
            saveEvent(false);
            if (expenses.length > 0) calculateSplit(false);
            showToast('Đã lưu tỷ giá!', 'success');
        });
        // ======= Hết phần cấu hình tỷ giá =======

        // Vẫn giữ nút tính toán cho trường hợp người dùng muốn tính lại
        $('#calculateBtn').click(function () {
            if (!allowEdit) return; // Không cho phép tính toán nếu ở chế độ chỉ xem

            calculateSplit(true); // Hiển thị thông báo lỗi nếu có
            if ($('#resultContainer').is(':visible')) {
                showToast('Đã tính toán chia tiền!', 'success');
            }
        });

        // Xử lý lưu sự kiện (hiện thông báo)
        $('#saveEventBtn').click(function () {
            if (!allowEdit) return; // Không cho phép lưu nếu ở chế độ chỉ xem
            
            saveEvent(true);
        });

        // Xử lý khi người dùng chỉnh sửa tên sự kiện
        $('#eventTitle').on('blur', function () {
            if (!allowEdit) return; // Không cho phép chỉnh sửa nếu ở chế độ chỉ xem
            
            const newTitle = $(this).text().trim();
            if (newTitle) {
                // Lưu tên sự kiện mới
                saveEvent(false);
            } else {
                showToast('Vui lòng nhập tên sự kiện!', 'warning');
                $(this).text('Sự Kiện Mới'); // Đặt lại tên mặc định nếu người dùng xóa hết
            }
        });

        // Xử lý khi người dùng nhấn Enter để kết thúc chỉnh sửa
        $('#eventTitle').on('keypress', function (e) {
            if (!allowEdit) return; // Không cho phép chỉnh sửa nếu ở chế độ chỉ xem
            
            if (e.which === 13) { // 13 là mã phím Enter
                e.preventDefault(); // Ngăn không cho xuống dòng
                $(this).blur(); // Kích hoạt sự kiện blur để lưu tên
            }
        });

        // Hiển thị danh sách sự kiện đã lưu khi mở modal
        $('#savedEventsBtn').click(function () {
            renderSavedEvents();
        });

        // Xử lý khi chọn sự kiện đã lưu
        $(document).on('click', '.event-item', function (e) {
            // Không chọn sự kiện nếu click vào nút xoá hoặc share
            if ($(e.target).hasClass('delete-event-btn') || $(e.target).closest('.delete-event-btn').length ||
                $(e.target).hasClass('share-event-btn') || $(e.target).closest('.share-event-btn').length) {
                return;
            }

            const eventCode = $(this).data('event-code');
            loadEventFromServer(eventCode);
            $('#savedEventsModal').modal('hide');
        });

        // Gỡ khỏi "Sự Kiện Của Tôi" — không xóa event, mở lại link là lưu lại được
        $(document).on('click', '.unsave-event-btn', function (e) {
            e.stopPropagation();
            // .attr() thay vì .data(): mã sự kiện có thể toàn chữ số, jQuery sẽ ép kiểu
            const eventCode = String($(this).attr('data-event-code') || '');

            function done() {
                showToast('Đã gỡ sự kiện khỏi danh sách.', 'success');
                renderSavedEvents();
            }
            if (AppAuth.isLoggedIn()) {
                $.ajax({
                    url: `/api/my-events/${encodeURIComponent(eventCode)}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders(),
                    success: done,
                    error: function () {
                        showToast('Không gỡ được sự kiện, vui lòng thử lại.', 'error');
                    }
                });
            } else {
                removeEventCodeFromLocalStorage(eventCode);
                done();
            }
        });

        // Xử lý xoá sự kiện
        $(document).on('click', '.delete-event-btn', function (e) {
            e.stopPropagation(); // Ngăn không cho sự kiện propagate lên parent
            // .attr() thay vì .data(): mã sự kiện có thể toàn chữ số, jQuery sẽ ép kiểu
            const eventCode = String($(this).attr('data-event-code') || '');

            showConfirm('Bạn có chắc chắn muốn xoá sự kiện này?', function () {
                $.ajax({
                    url: `/api/events/${eventCode}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders(),
                    success: function(response) {
                        if (response.success) {
                            showToast('Đã xoá sự kiện thành công!', 'success');

                            // Nếu đang xoá sự kiện hiện tại, tạo mới
                            if (eventCode === currentEventCode) {
                                createNewEvent();
                            }

                            // Cập nhật danh sách sự kiện
                            renderSavedEvents();
                        } else {
                            showToast('Lỗi khi xoá sự kiện!', 'error');
                        }
                    },
                    error: function(xhr) {
                        if (xhr.status === 403) {
                            showToast('Bạn không có quyền xóa sự kiện này.', 'error');
                        } else {
                            showToast('Lỗi kết nối server!', 'error');
                        }
                    }
                });
            }, { okLabel: 'Xóa' });
        });

        // Chia sẻ từ danh sách "Sự Kiện Của Tôi": copy thẳng link (cài đặt
        // quyền chi tiết nằm trong nút Chia sẻ khi mở sự kiện)
        $(document).on('click', '.share-event-btn', function (e) {
            e.stopPropagation(); // Ngăn không cho sự kiện propagate lên parent
            copyTextToClipboard(buildShareLink($(this).data('event-code')), 'Đã sao chép đường liên kết!');
        });

        // Xử lý tạo sự kiện mới
        $('#newEventBtn').click(function () {
            if (!AppAuth.isLoggedIn()) {
                showToast('Vui lòng đăng nhập để tạo sự kiện mới.', 'warning');
                AppAuth.showLoginModal();
                return;
            }
            if (!allowEdit) {
                // Ở chế độ chỉ xem (share), chuyển về trang chính để tạo mới (chế độ chỉnh sửa)
                localStorage.removeItem('currentEventCode');
                window.location.href = '/';
                return;
            }
            showConfirm('Bạn có chắc chắn muốn tạo sự kiện mới? Dữ liệu hiện tại đã được lưu.', function () {
                createNewEvent();
                showToast('Đã tạo sự kiện mới!', 'success');
            }, { okLabel: 'Tạo mới', okClass: 'btn-primary' });
        });

        // ===== Lịch sử chỉnh sửa =====
        const REVISION_KIND_BADGE = {
            create: '<span class="badge bg-primary me-1">Tạo</span>',
            restore: '<span class="badge bg-warning text-dark me-1">Khôi phục</span>',
            share: '<span class="badge bg-info text-dark me-1">Chia sẻ</span>'
        };

        function formatRevisionTime(iso) {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        }

        function renderHistory(revisions) {
            const $list = $('#historyList').empty();
            if (!revisions.length) {
                $list.append('<li class="list-group-item text-muted">Chưa có lịch sử chỉnh sửa.</li>');
                return;
            }
            revisions.forEach((rev, idx) => {
                // XSS: actor_name là username tự đặt, summary chứa tên chi phí/
                // thành viên người dùng nhập — tất cả phải qua escapeHtml
                const badge = REVISION_KIND_BADGE[rev.kind] || '';
                const summaryHtml = (rev.summary || [])
                    .map(t => `<div class="small text-body-secondary">${escapeHtml(t)}</div>`).join('');
                const restoreBtn = idx === 0 ? '' : `
                    <button class="btn btn-sm btn-outline-warning history-restore-btn"
                            data-id="${escapeHtml(rev.id)}" data-time="${escapeHtml(rev.created_at || '')}">
                        <i class="fas fa-rotate-left me-1"></i>Khôi phục
                    </button>`;
                $list.append(`
                    <li class="list-group-item">
                        <div class="d-flex justify-content-between align-items-start">
                            <div>
                                <div>${badge}<strong>${escapeHtml(rev.actor_name || 'Không rõ')}</strong>
                                    <span class="text-muted small ms-1">${escapeHtml(formatRevisionTime(rev.created_at))}</span>
                                </div>
                                ${summaryHtml}
                            </div>
                            <div class="ms-2 flex-shrink-0">${restoreBtn}</div>
                        </div>
                    </li>`);
            });
        }

        function loadHistory() {
            $('#historyLoading').removeClass('d-none');
            $('#historyList').empty();
            $.ajax({
                url: `/api/events/${currentEventCode}/revisions`,
                headers: AppAuth.authHeaders(),
                success: function (res) {
                    $('#historyLoading').addClass('d-none');
                    if (res.success) renderHistory(res.revisions || []);
                },
                error: function (xhr) {
                    $('#historyLoading').addClass('d-none');
                    if (xhr.status === 401) {
                        showToast('Vui lòng đăng nhập để xem lịch sử.', 'warning');
                        AppAuth.showLoginModal();
                    } else {
                        showToast('Không tải được lịch sử chỉnh sửa.', 'error');
                    }
                }
            });
        }

        $('#historyBtn').on('click', function () {
            if (!allowEdit || !currentEventCode) return;
            bootstrap.Modal.getOrCreateInstance(document.getElementById('historyModal')).show();
            loadHistory();
        });

        $(document).on('click', '.history-restore-btn', function () {
            const revisionId = $(this).data('id');
            const timeLabel = formatRevisionTime(String($(this).data('time') || ''));
            showConfirm(
                `Khôi phục sự kiện về phiên bản lúc ${timeLabel}? Nội dung hiện tại sẽ được thay bằng bản này (thao tác khôi phục cũng được ghi vào lịch sử).`,
                function () {
                    $.ajax({
                        url: `/api/events/${currentEventCode}/restore`,
                        method: 'POST',
                        contentType: 'application/json',
                        headers: AppAuth.authHeaders(),
                        data: JSON.stringify({ revision_id: revisionId, expectedUpdatedAt: lastKnownUpdatedAt }),
                        success: function (res) {
                            if (res.success) {
                                bootstrap.Modal.getOrCreateInstance(document.getElementById('historyModal')).hide();
                                showToast('Đã khôi phục sự kiện về phiên bản đã chọn.', 'success');
                                loadEventFromServer(currentEventCode);
                            }
                        },
                        error: function (xhr) {
                            if (xhr.status === 409) {
                                showToast('Sự kiện vừa được cập nhật ở nơi khác — đang tải lại.', 'warning');
                                loadEventFromServer(currentEventCode);
                                loadHistory();
                            } else if (xhr.status === 401) {
                                showToast('Vui lòng đăng nhập để khôi phục.', 'warning');
                                AppAuth.showLoginModal();
                            } else {
                                showToast('Không khôi phục được phiên bản này.', 'error');
                            }
                        }
                    });
                },
                { okLabel: 'Khôi phục', okClass: 'btn-warning' }
            );
        });
        // ===== Hết phần lịch sử chỉnh sửa =====

        // Modal xác nhận thống nhất thay cho confirm() native
        let _confirmCallback = null;
        function showConfirm(message, onConfirm, opts) {
            opts = opts || {};
            $('#confirmModalMessage').text(message);
            $('#confirmModalOkBtn')
                .text(opts.okLabel || 'Xác nhận')
                .attr('class', 'btn ' + (opts.okClass || 'btn-danger'));
            // Nhãn nút Hủy tùy biến được (vd. "Có, chia cho X") — luôn reset về
            // mặc định để không rò rỉ nhãn sang các lần gọi khác
            $('#confirmModalCancelBtn').text(opts.cancelLabel || 'Hủy');
            _confirmCallback = onConfirm;
            bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmModal')).show();
        }

        $('#confirmModalOkBtn').on('click', function () {
            const cb = _confirmCallback;
            _confirmCallback = null;
            bootstrap.Modal.getOrCreateInstance(document.getElementById('confirmModal')).hide();
            if (cb) cb();
        });

        $('#confirmModal').on('hidden.bs.modal', function () {
            _confirmCallback = null; // đóng bằng nút Hủy/ESC/backdrop → không làm gì
        });

        // Bootstrap 5 không hỗ trợ modal lồng nhau: đóng modal trên cùng sẽ gỡ
        // class modal-open của body làm modal bên dưới mất scroll — khôi phục lại
        $(document).on('hidden.bs.modal', '.modal', function () {
            if ($('.modal.show').length) {
                $('body').addClass('modal-open');
            }
        });

        // Hàm hiển thị toast thay cho alert
        function showToast(message, type = 'info') {
            const toastId = 'toast-' + Date.now();
            const bgClass = {
                'success': 'bg-success text-white',
                'error': 'bg-danger text-white',
                'warning': 'bg-warning text-dark',
                'info': 'bg-info text-dark'
            };
            const iconClass = {
                'success': 'fa-check-circle',
                'error': 'fa-exclamation-circle',
                'warning': 'fa-exclamation-triangle',
                'info': 'fa-info-circle'
            };

            const toastHTML = `
                <div class="toast" role="alert" aria-live="assertive" aria-atomic="true" id="${toastId}">
                    <div class="toast-header ${bgClass[type]}">
                        <i class="fas ${iconClass[type]} me-2"></i>
                        <strong class="me-auto">Thông báo</strong>
                        <small>Vừa xong</small>
                        <button type="button" class="btn-close ${type === 'success' || type === 'error' ? 'btn-close-white' : ''}" data-bs-dismiss="toast" aria-label="Close"></button>
                    </div>
                    <div class="toast-body"></div>
                </div>
            `;

            // Set nội dung bằng .text() — message thường chứa dữ liệu người dùng
            const $toast = $(toastHTML);
            $toast.find('.toast-body').text(message);
            $('#toastContainer').append($toast);
            const toastElement = document.getElementById(toastId);
            const toast = new bootstrap.Toast(toastElement, {
                autohide: true,
                delay: 3000
            });
            toast.show();

            // Xóa toast khỏi DOM sau khi ẩn
            toastElement.addEventListener('hidden.bs.toast', function () {
                $(this).remove();
            });
        }

        // Xử lý sao chép giao dịch (cho phép cả ở chế độ chỉ xem — người nhận
        // link chính là người cần danh sách chuyển tiền)
        $('#copyTransfersBtn').click(function () {
            if ($('#transfersList').children().length === 0 ||
                $('#transfersList').text().includes('Không cần chuyển tiền')) {
                showToast('Không có giao dịch nào để sao chép!', 'warning');
                return;
            }

            // Tạo nội dung để sao chép
            let copyContent = `GIAO DỊCH CẦN THỰC HIỆN - ${$('#eventTitle').text()}\n\n`;

            $('#transfersList .transfer-item').each(function () {
                // Loại bỏ icon và format lại text
                const transferText = $(this).text().trim().replace('ị ', 'ị: ');
                copyContent += transferText + '\n';
            });

            // Copy vào clipboard
            navigator.clipboard.writeText(copyContent)
                .then(() => {
                    showToast('Đã sao chép các giao dịch thành công!', 'success');
                })
                .catch(err => {
                    console.error('Không thể sao chép: ', err);
                    showToast('Không thể sao chép. Vui lòng thử lại sau!', 'warning');
                });
        });

        // ===== Modal chia sẻ kiểu Google Docs =====
        function renderShareModal() {
            $('#shareEventTitle').text($('#eventTitle').text());
            $('#shareAccessSelect').val(shareAccess);
            $('#shareRoleSelect').val(shareRole).toggle(shareAccess === 'link');
            if (shareAccess === 'restricted') {
                $('#shareAccessIcon').attr('class', 'fas fa-lock text-secondary');
                $('#shareAccessDesc').text('Chỉ chủ sở hữu mới truy cập được bằng đường liên kết này.');
            } else {
                $('#shareAccessIcon').attr('class', 'fas fa-globe-asia text-success');
                $('#shareAccessDesc').text(shareRole === 'editor'
                    ? 'Bất kỳ ai có kết nối Internet và có đường liên kết này đều có thể chỉnh sửa.'
                    : 'Bất kỳ ai có kết nối Internet và có đường liên kết này đều có thể xem.');
            }
        }

        // ===== Người có quyền truy cập (chỉ owner thấy/quản lý) =====
        function renderCollaborators(collaborators) {
            const $list = $('#collabList').empty();
            $list.append(`
                <div class="list-group-item d-flex justify-content-between align-items-center px-0">
                    <span><i class="fas fa-user-circle me-2 text-secondary"></i>Bạn (chủ sở hữu)</span>
                    <span class="text-muted small">Chủ sở hữu</span>
                </div>`);
            (collaborators || []).forEach(c => {
                // XSS: display là username tự đặt hoặc email — phải escape,
                // kể cả khi đưa vào data-attribute
                const safeId = escapeHtml(c.user_id);
                const safeDisplay = escapeHtml(c.display || 'Không rõ');
                $list.append(`
                    <div class="list-group-item d-flex justify-content-between align-items-center gap-2 px-0">
                        <span class="text-truncate"><i class="fas fa-user me-2 text-secondary"></i>${safeDisplay}</span>
                        <span class="d-flex align-items-center gap-1 flex-shrink-0">
                            <select class="form-select form-select-sm w-auto collab-role-select"
                                    data-identifier="${escapeHtml(c.display || '')}">
                                <option value="viewer"${c.role === 'viewer' ? ' selected' : ''}>Người xem</option>
                                <option value="editor"${c.role === 'editor' ? ' selected' : ''}>Người chỉnh sửa</option>
                            </select>
                            <button type="button" class="btn btn-sm btn-outline-danger collab-remove-btn"
                                    data-user-id="${safeId}" data-display="${escapeHtml(c.display || '')}"
                                    title="Gỡ quyền truy cập">
                                <i class="fas fa-times"></i>
                            </button>
                        </span>
                    </div>`);
            });
        }

        function loadCollaborators() {
            $.ajax({
                url: `/api/events/${currentEventCode}/collaborators`,
                headers: AppAuth.authHeaders(),
                success: function (res) {
                    if (res.success) renderCollaborators(res.collaborators || []);
                },
                error: function (xhr) {
                    if (xhr.status === 401) {
                        AppAuth.showLoginModal();
                    } else {
                        showToast('Không tải được danh sách người có quyền truy cập.', 'error');
                    }
                }
            });
        }

        function upsertCollaborator(identifier, role, onDone) {
            $.ajax({
                url: `/api/events/${currentEventCode}/collaborators`,
                method: 'POST',
                contentType: 'application/json',
                headers: AppAuth.authHeaders(),
                data: JSON.stringify({ identifier: identifier, role: role }),
                success: function () {
                    loadCollaborators();
                    if (onDone) onDone(true);
                },
                error: function (xhr) {
                    // 404/400 có message tiếng Việt cụ thể từ server
                    showToast((xhr.responseJSON && xhr.responseJSON.error)
                        || 'Không thêm được người này, vui lòng thử lại.', 'error');
                    if (xhr.status === 401) {
                        AppAuth.showLoginModal();
                    } else {
                        loadCollaborators(); // đồng bộ lại UI (ví dụ dropdown role vừa đổi hụt)
                    }
                    if (onDone) onDone(false);
                }
            });
        }

        $('#collabAddBtn').on('click', function () {
            const identifier = $('#collabIdentifierInput').val().trim();
            if (!identifier) return;
            upsertCollaborator(identifier, $('#collabRoleSelect').val(), function (ok) {
                if (ok) {
                    $('#collabIdentifierInput').val('');
                    showToast('Đã thêm quyền truy cập.', 'success');
                }
            });
        });

        // Đổi vai trò tại chỗ: display (username/email) chính là identifier hợp lệ
        $(document).on('change', '.collab-role-select', function () {
            const identifier = $(this).attr('data-identifier');
            if (!identifier) {
                showToast('Không đổi được vai trò của người này.', 'error');
                loadCollaborators();
                return;
            }
            upsertCollaborator(identifier, $(this).val(), null);
        });

        $(document).on('click', '.collab-remove-btn', function () {
            const userId = $(this).attr('data-user-id');
            const display = $(this).attr('data-display') || 'người này';
            showConfirm(`Gỡ quyền truy cập của ${display}?`, function () {
                $.ajax({
                    url: `/api/events/${currentEventCode}/collaborators/${encodeURIComponent(userId)}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders(),
                    success: function () {
                        showToast('Đã gỡ quyền truy cập.', 'success');
                        loadCollaborators();
                    },
                    error: function (xhr) {
                        if (xhr.status === 401) {
                            AppAuth.showLoginModal();
                            return;
                        }
                        showToast('Không gỡ được quyền truy cập, vui lòng thử lại.', 'error');
                    }
                });
            }, { okLabel: 'Gỡ', okClass: 'btn-danger' });
        });

        function saveShareSettings(access, role) {
            const prevAccess = shareAccess, prevRole = shareRole;
            shareAccess = access;
            shareRole = role;
            renderShareModal();
            $.ajax({
                url: `/api/events/${currentEventCode}/sharing`,
                method: 'PUT',
                contentType: 'application/json',
                headers: AppAuth.authHeaders(),
                data: JSON.stringify({ access: access, role: role }),
                success: function () {
                    showToast('Đã cập nhật quyền truy cập.', 'success');
                },
                error: function () {
                    // Đổi thất bại → trả UI về trạng thái cũ
                    shareAccess = prevAccess;
                    shareRole = prevRole;
                    renderShareModal();
                    showToast('Không cập nhật được quyền truy cập, vui lòng thử lại.', 'error');
                }
            });
        }

        $('#shareEventBtn').click(function () {
            if (!currentEventCode) {
                showToast('Vui lòng lưu sự kiện trước khi chia sẻ!', 'warning');
                return;
            }
            renderShareModal();
            $('#collabSection').toggleClass('d-none', !isOwner);
            if (isOwner) loadCollaborators();
            $('#shareEventModal').modal('show');
        });

        $('#shareAccessSelect').change(function () {
            saveShareSettings($(this).val(), shareRole);
        });

        $('#shareRoleSelect').change(function () {
            saveShareSettings(shareAccess, $(this).val());
        });

        $('#copyShareLinkBtn').click(function () {
            copyTextToClipboard(buildShareLink(currentEventCode), 'Đã sao chép đường liên kết!');
        });

        function exitEditExpenseMode() {
            editingExpenseIndex = null;
            $('#expenseSubmitBtn').text('Thêm Chi Phí');
            $('#cancelEditExpenseBtn').addClass('d-none');
            $('#expenseTitle').val('');
            $('#expenseAmount').val('');
            resetExpenseDateInput();
            // Reset dropdown người hưởng — khoản MỚI tiếp theo mặc định "Tất cả",
            // tránh thừa hưởng 'selected' + tick của khoản vừa sửa xong.
            $('#benefitType').val('all').trigger('change');
            updateAmountPreview();
            renderExpenses();
        }

        $('#cancelEditExpenseBtn').on('click', function () {
            exitEditExpenseMode();
        });

        $(document).on('click', '.edit-expense', function () {
            if (!allowEdit) return; // Không cho phép chỉnh sửa nếu ở chế độ chỉ xem

            const index = $(this).data('index');
            const expense = expenses[index];

            // Điền thông tin chi phí vào form
            $('#expenseTitle').val(expense.title);
            $('#expenseAmount').val(expense.amount);
            $('#expensePayer').val(expense.payer);
            // Dữ liệu đã chuẩn hóa — form sửa luôn ở chế độ chọn đích danh
            $('#benefitType').val('selected').trigger('change');
            const curEdit = getCurrencyOfExpense(expense);
            if ($('#expenseCurrency').find('option').filter(function () { return this.value === curEdit; }).length === 0) {
                $('#expenseCurrency').append($('<option>').val(curEdit).text(curEdit));
            }
            $('#expenseCurrency').val(curEdit);

            // Xử lý checkbox thêm 3 số 0 khi edit (chỉ áp dụng ý nghĩa cho VND)
            const amountNum = Number(expense.amount);
            if (curEdit === 'VND' && amountNum % 1000 === 0 && amountNum !== 0) {
                $('#addZerosCheckbox').prop('checked', true);
                $('#expenseAmount').val(amountNum / 1000);
            } else {
                $('#addZerosCheckbox').prop('checked', false);
                $('#expenseAmount').val(amountNum);
            }

            // Khôi phục ngày phát sinh và created_time khi chỉnh sửa
            $('#expenseDate').val(expense.expense_date || todayISODate());
            $('#expenseCreatedTime').val(expense.created_time || '');

            // Cập nhật preview sau khi set giá trị
            updateAmountPreview();

            // Tick theo danh sách hưởng thực tế (đã lọc + fallback)
            // — an toàn với tên có dấu/khoảng trắng nhờ so theo value
            $('#beneficiariesList .beneficiary-checkbox').prop('checked', false);
            const wanted = new Set(getExpenseBeneficiaries(expense));
            $('#beneficiariesList .beneficiary-checkbox').each(function () {
                if (wanted.has(this.value)) this.checked = true;
            });

            // Bật edit mode: giữ nguyên expense trong mảng, chỉ đánh dấu index đang sửa
            editingExpenseIndex = index;
            $('#expenseSubmitBtn').text('Cập nhật Chi Phí');
            $('#cancelEditExpenseBtn').removeClass('d-none');
            renderExpenses();

            // Cuộn lên form để người dùng có thể chỉnh sửa
            $('html, body').animate({
                scrollTop: $("#expenseForm").offset().top - 100
            }, 500);
        });

        // Hàm hiển thị option ngân hàng có logo
        function formatBankOption(option) {
            if (!option.id) return option.text; // placeholder không có logo
            var img = $(option.element).data('image');
            if (img) {
                // Dựng bằng DOM API — không nội suy img/option.text vào chuỗi HTML
                return $('<span>')
                    .append($('<img>').attr('src', img))
                    .append(document.createTextNode(' ' + option.text));
            }
            return option.text;
        }

        // Khi mở modal Thêm/Sửa Thông Tin Ngân Hàng thì reset lại select2 để tránh lỗi
        $('#editBankInfoModal').on('shown.bs.modal', function () {
            $('#bankInfoBank').select2({
                dropdownParent: $('#editBankInfoModal'),
                templateResult: formatBankOption,
                templateSelection: formatBankOption,
                width: '100%'
            });
        });
        
        // Cập nhật UI ngay sau khi khởi tạo
        updateUIForEditMode();
        resetExpenseDateInput();
    });

    // Đăng ký service worker cho PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
                .catch((err) => console.warn('SW registration failed:', err));
        });
    }
