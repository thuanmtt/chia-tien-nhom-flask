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
        const urlEditKey = urlParams.get('key');
        
        // Quyền chỉnh sửa do SERVER quyết định: GET event trả về cờ can_edit
        // dựa trên khóa X-Edit-Key gửi kèm. Có khóa hợp lệ → giao diện chỉnh sửa,
        // không có/sai khóa → giao diện chỉ xem (loadEventFromServer xử lý).
        // Chờ AppAuth biết session (từ localStorage, không chờ mạng lâu) rồi mới
        // tải event — để owner mở event của mình trên máy mới nhận đúng can_edit
        // qua JWT thay vì bị rơi về chế độ chỉ xem.
        AppAuth.onReady(function () {
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
                // Link chia sẻ /?event_code=X[&key=...]: lưu khóa nếu có,
                // server sẽ xác nhận quyền thật qua can_edit
                if (urlEditKey) {
                    setEditKey(urlEventCode, urlEditKey);
                }
                // Trạng thái tạm trong lúc chờ server: có khóa → giả định sửa được,
                // không khóa → chỉ xem (tránh nháy giao diện sai cho người xem)
                allowEdit = !!(urlEditKey || getEditKey(urlEventCode));
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
                $('#memberForm').hide();
                $('#expenseForm').hide();
                $('#calculateBtn').hide();
                $('#manageCouplesBtn').hide();
                $('#eventTitle').removeAttr('contenteditable');
                $('#eventTitle').css('cursor', 'default');
                
                // Ẩn các nút action trong danh sách thành viên và chi phí
                $('.member-close').hide();
                $('.action-btn').hide();
                
                // Ẩn nút copy trong kết quả
                $('#copyTransfersBtn').hide();
                
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
                
                // Hiện lại nút copy
                $('#copyTransfersBtn').show();
                
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
                $('#bankInfoBank').append(
                    `<option value="${bank.code}" data-image="https://qr.sepay.vn/assets/img/banklogo/${bank.code}.png">
                        ${bank.short_name} - ${bank.name}
                    </option>`
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
                const bankOption = $('#bankInfoBank option[value="' + (info.bank || '') + '"]');
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
            const qrUrl = `https://qr.sepay.vn/img?acc=${bankInfoTo.account}&bank=${bankInfoTo.bank}&amount=${amount}&template=compact&download=false`;
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
        }

        // ===== Khóa chỉnh sửa (edit key) =====
        // Server chỉ chấp nhận PUT/DELETE khi X-Edit-Key khớp với khóa của sự kiện.
        function getEditKeyMap() {
            try {
                const map = JSON.parse(localStorage.getItem('eventEditKeys') || '{}');
                return (map && typeof map === 'object') ? map : {};
            } catch (e) {
                return {};
            }
        }

        function getEditKey(eventCode) {
            return getEditKeyMap()[eventCode] || null;
        }

        function setEditKey(eventCode, key) {
            if (!eventCode || !key) return;
            const map = getEditKeyMap();
            map[eventCode] = key;
            localStorage.setItem('eventEditKeys', JSON.stringify(map));
        }

        function removeEditKey(eventCode) {
            const map = getEditKeyMap();
            if (eventCode in map) {
                delete map[eventCode];
                localStorage.setItem('eventEditKeys', JSON.stringify(map));
            }
        }

        // Sự kiện cũ (tạo trước khi có edit key): tự sinh khóa gửi lên,
        // server sẽ "nhận" khóa này cho sự kiện chưa có khóa.
        function getOrCreateEditKey(eventCode) {
            let key = getEditKey(eventCode);
            if (!key) {
                key = (window.crypto && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : 'k-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
                setEditKey(eventCode, key);
            }
            return key;
        }

        function buildShareLinks(eventCode) {
            const base = window.location.origin + '/?event_code=' + encodeURIComponent(eventCode);
            const key = getEditKey(eventCode);
            return {
                viewOnly: base,
                // Sự kiện cũ chưa có khóa: chưa phân biệt được quyền → hai link như nhau
                editable: key ? `${base}&key=${encodeURIComponent(key)}` : base,
            };
        }
        // ===== Hết phần khóa chỉnh sửa =====

        // Indicator trạng thái lưu ở header: Đang lưu... / Đã lưu lúc HH:MM / lỗi
        function setSaveStatus(state) {
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

        // ===== Lưu dữ liệu lên server =====
        // Các lần lưu được TUẦN TỰ HÓA: chỉ 1 request tại một thời điểm, các
        // thao tác trong lúc chờ được gộp thành đúng 1 lần lưu tiếp theo.
        // Nhờ vậy không bắn PUT dồn dập và expectedUpdatedAt luôn mới.
        function saveEvent(showAlert = true) {
            if (!allowEdit) return; // Không cho phép lưu nếu ở chế độ chỉ xem

            // Tạo sự kiện mới cần tài khoản (server cũng chặn 401) — sự kiện đã
            // tồn tại vẫn lưu được bằng edit_key như cũ (người được chia sẻ link)
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
                    headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(currentEventCode) }),
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
                        if (xhr.status === 403) {
                            // Khóa không còn hợp lệ → chuyển giao diện về chế độ chỉ xem
                            showToast('Bạn không có quyền chỉnh sửa sự kiện này — chuyển về chế độ chỉ xem.', 'error');
                            removeEditKey(currentEventCode);
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
                            saveEventCodeToLocalStorage(currentEventCode); // Lưu event_code vào localStorage
                            if (response.edit_key) {
                                setEditKey(currentEventCode, response.edit_key);
                            }
                            lastKnownUpdatedAt = response.updated_at || null;
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

        // Hàm tải sự kiện từ server.
        // Gửi kèm khóa chỉnh sửa (nếu có) để server trả về can_edit —
        // cờ này quyết định giao diện chỉnh sửa hay chỉ xem.
        function loadEventFromServer(eventCode, opts) {
            opts = opts || {};
            const storedKey = opts.forceViewOnly ? null : getEditKey(eventCode);
            $.ajax({
                url: `/api/events/${eventCode}`,
                method: 'GET',
                headers: AppAuth.authHeaders(storedKey ? { 'X-Edit-Key': storedKey } : {}),
                success: function(response) {
                    if (response.success) {
                        const eventData = response.event;
                        currentEventCode = eventData.event_code;

                        // Quyền chỉnh sửa do server xác nhận
                        if (opts.forceViewOnly) {
                            allowEdit = false;
                        } else {
                            allowEdit = !!eventData.can_edit;
                            if (!allowEdit && storedKey) {
                                // Khóa sai hoặc đã bị đổi — bỏ khóa hỏng, chuyển chỉ xem
                                removeEditKey(eventCode);
                                showToast('Khóa chỉnh sửa không đúng — đang mở ở chế độ chỉ xem.', 'warning');
                            }
                        }

                        // Mốc updated_at cho optimistic locking khi lưu
                        lastKnownUpdatedAt = eventData.updated_at || null;
                        setSaveStatus(''); // dữ liệu vừa tải, chưa có thay đổi cần lưu

                        // Cập nhật tên sự kiện
                        $('#eventTitle').text(eventData.title);
                        // Sau khi set currentEventCode hoặc tạo mới sự kiện, cập nhật eventCodeDisplay
                        function updateEventCodeDisplay() {
                            if (currentEventCode) {
                                $('#eventCodeDisplay').text(currentEventCode);
                            } else {
                                $('#eventCodeDisplay').text('');
                            }
                        }
                        updateEventCodeDisplay();

                        // Cập nhật thành viên & nhóm chung quỹ
                        members = eventData.members || [];
                        couples = Array.isArray(eventData.couples) ? eventData.couples : [];
                        renderMembers();

                        // Cập nhật tỷ giá
                        rates = (eventData.rates && typeof eventData.rates === 'object') ? eventData.rates : {};
                        renderCurrencyDropdown();

                        // Cập nhật chi phí
                        expenses = eventData.expenses || [];
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
                            saveEventCodeToLocalStorage(currentEventCode); // Lưu vào danh sách sự kiện đã lưu
                        }

                        // Tự động tính toán khi tải sự kiện
                        calculateSplit(false);
                        
                        // Cập nhật UI dựa trên chế độ chỉnh sửa
                        updateUIForEditMode();
                    } else {
                        showToast('Không tìm thấy sự kiện!', 'error');
                        createNewEvent();
                    }
                },
                error: function() {
                    showToast('Lỗi khi tải sự kiện!', 'error');
                    createNewEvent();
                }
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
                    <span class="member-close" data-index="${index}" style="${!allowEdit ? 'display: none;' : ''}"><i class="fas fa-times"></i></span>
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
                if (benef) {
                    // Đồng bộ với getExpenseBeneficiaries: không phải 'selected' = cho tất cả
                    const isAll = exp.benefitType !== 'selected';
                    const inList = (exp.beneficiaries || []).includes(benef);
                    if (!isAll && !inList) return false;
                }
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
                let beneficiaries;
                if (e.benefitType === 'all') {
                    beneficiaries = 'Tất cả';
                } else if (e.beneficiaries && e.beneficiaries.length) {
                    beneficiaries = e.beneficiaries.join(', ');
                } else {
                    beneficiaries = '';
                }
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

        function exportExpensesToExcel() {
            if (!expenses.length) {
                showToast('Chưa có chi phí để xuất.', 'warning');
                return;
            }
            if (typeof XLSX === 'undefined') {
                showToast('Thư viện xuất Excel chưa tải xong, vui lòng thử lại.', 'error');
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

        async function exportExpensesToPDF() {
            if (!expenses.length) {
                showToast('Chưa có chi phí để xuất.', 'warning');
                return;
            }
            if (!window.jspdf || !window.jspdf.jsPDF) {
                showToast('Thư viện xuất PDF chưa tải xong, vui lòng thử lại.', 'error');
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

            if (typeof doc.autoTable !== 'function') {
                showToast('Plugin bảng PDF chưa tải xong, vui lòng thử lại.', 'error');
                return;
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
                    <span class="action-btn edit-expense" data-index="${index}">
                        <i class="fas fa-edit"></i>
                    </span>
                    <span class="action-btn delete-expense" data-index="${index}">
                        <i class="fas fa-trash"></i>
                    </span>
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

        // Hàm lưu event_code vào localStorage
        function saveEventCodeToLocalStorage(eventCode) {
            let savedEventCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
            if (!savedEventCodes.includes(eventCode)) {
                savedEventCodes.push(eventCode);
                localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
            }
        }

        // Hàm xóa event_code khỏi localStorage
        function removeEventCodeFromLocalStorage(eventCode) {
            let savedEventCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');
            savedEventCodes = savedEventCodes.filter(code => code !== eventCode);
            localStorage.setItem('savedEventCodes', JSON.stringify(savedEventCodes));
        }

        // Hàm hiển thị danh sách sự kiện đã lưu.
        // Đã đăng nhập: gộp event sở hữu trên server (/api/my-events) với danh
        // sách localStorage (event được chia sẻ cho mình vẫn hiện).
        function renderSavedEvents() {
            $('#savedEventsList').empty();
            $('#savedEventsList').append('<p class="text-center text-muted">Đang tải...</p>');

            const localCodes = JSON.parse(localStorage.getItem('savedEventCodes') || '[]');

            function proceed(serverCodes) {
                // lookup nhận tối đa 50 mã — ưu tiên mã trên server (mới hơn)
                const allCodes = Array.from(new Set(serverCodes.concat(localCodes))).slice(0, 50);
                if (allCodes.length === 0) {
                    $('#savedEventsList').empty();
                    $('#savedEventsList').append('<p class="text-center text-muted">Chưa có sự kiện nào được lưu trên máy này.</p>');
                    return;
                }
                $.ajax({
                    url: '/api/events/lookup',
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({ codes: allCodes }),
                    success: function (response) {
                        const events = (response && response.events) || [];
                        // Mã LOCAL không còn tồn tại trên server → dọn khỏi localStorage
                        const found = new Set(events.map(e => e.event_code));
                        localCodes
                            .filter(code => !found.has(code))
                            .forEach(removeEventCodeFromLocalStorage);
                        displaySavedEvents(events);
                    },
                    error: function () {
                        $('#savedEventsList').empty();
                        $('#savedEventsList').append('<p class="text-center text-danger">Không tải được danh sách sự kiện. Vui lòng thử lại.</p>');
                    }
                });
            }

            if (AppAuth.isLoggedIn()) {
                $.ajax({ url: '/api/my-events', headers: AppAuth.authHeaders() })
                    .done(function (r) { proceed(((r && r.events) || []).map(e => e.event_code)); })
                    .fail(function () { proceed([]); });
            } else {
                proceed([]);
            }
        }

        // Vừa đăng nhập xong mà đang có dữ liệu nháp chưa tạo trên server → tạo luôn
        document.addEventListener('appauth:change', function () {
            if (AppAuth.isLoggedIn() && !currentEventCode && allowEdit && members.length > 0) {
                saveEvent(false);
            }
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
        function displaySavedEvents(events) {
            $('#savedEventsList').empty();

            if (events.length === 0) {
                $('#savedEventsList').append('<p class="text-center text-muted">Chưa có sự kiện nào được lưu trên máy này.</p>');
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
                                <button class="btn btn-sm btn-danger delete-event-btn" data-event-code="${safeCode}">
                                    <i class="fas fa-trash"></i>
                                </button>
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
                    members.push(memberName);
                    renderMembers();
                    $('#memberName').val('');

                    // Tự động lưu sau khi thêm thành viên
                    saveEvent(false);
                    showToast(`Đã thêm thành viên "${memberName}"!`, 'success');
                    // Không cần gọi autoCalculate() vì đã được gọi trong renderMembers()
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

            // Kiểm tra xem thành viên có chi phí nào không
            const hasExpenses = expenses.some(expense => expense.payer === memberToRemove);

            // Chỉ chặn nếu là người hưởng ĐÍCH DANH ('selected'); các khoản
            // "cho tất cả" tự chia lại theo danh sách thành viên hiện tại
            const isBeneficiary = expenses.some(expense => expense.benefitType === 'selected'
                && expense.beneficiaries && expense.beneficiaries.includes(memberToRemove));

            if (hasExpenses || isBeneficiary) {
                showToast('Không thể xóa thành viên này vì họ đã có chi phí trong danh sách. Vui lòng xóa chi phí trước!', 'error');
                return;
            }

            members.splice(index, 1);

            // Dọn khỏi các nhóm chung quỹ
            couples = (couples || []).map(c => {
                const remaining = (c.members || []).filter(m => m !== memberToRemove);
                const primary = remaining.includes(c.primary) ? c.primary : (remaining[0] || '');
                return { ...c, members: remaining, primary };
            }).filter(c => c.members.length >= 2);

            renderMembers();

            // Tự động lưu sau khi xóa thành viên
            saveEvent(false);
            showToast(`Đã xoá thành viên "${memberToRemove}"!`, 'success');
            // Không cần gọi autoCalculate() vì đã được gọi trong renderMembers()
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
                benefitType: benefitType,
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
                expenses.splice(index, 1);

                // Đồng bộ editingExpenseIndex nếu đang ở edit mode
                if (editingExpenseIndex !== null) {
                    if (editingExpenseIndex === index) {
                        // Xoá chính expense đang sửa → thoát edit mode
                        exitEditExpenseMode();
                    } else if (editingExpenseIndex > index) {
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

        // Xuất Excel / PDF
        $('#exportExcelBtn').click(exportExpensesToExcel);
        $('#exportPdfBtn').click(async function () {
            const $btn = $(this);
            const original = $btn.html();
            $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin me-1"></i>Đang xuất...');
            try {
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
        function todayYYYYMMDD() {
            const d = new Date();
            const pad = n => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }

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
            $('#ratesDate').val(todayYYYYMMDD());
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
            const date = $('#ratesDate').val() || todayYYYYMMDD();
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

        // Xử lý xoá sự kiện
        $(document).on('click', '.delete-event-btn', function (e) {
            e.stopPropagation(); // Ngăn không cho sự kiện propagate lên parent
            const eventCode = $(this).data('event-code');

            showConfirm('Bạn có chắc chắn muốn xoá sự kiện này?', function () {
                $.ajax({
                    url: `/api/events/${eventCode}`,
                    method: 'DELETE',
                    headers: AppAuth.authHeaders({ 'X-Edit-Key': getOrCreateEditKey(eventCode) }),
                    success: function(response) {
                        if (response.success) {
                            showToast('Đã xoá sự kiện thành công!', 'success');

                            // Xóa event_code khỏi localStorage
                            removeEventCodeFromLocalStorage(eventCode);

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

        // Xử lý chia sẻ sự kiện từ danh sách
        $(document).on('click', '.share-event-btn', function (e) {
            e.stopPropagation(); // Ngăn không cho sự kiện propagate lên parent
            const eventCode = $(this).data('event-code');

            // Link chỉnh sửa chứa khóa bí mật; link chỉ xem chỉ có event_code
            const links = buildShareLinks(eventCode);
            $('#shareLinkViewOnly').val(links.viewOnly);
            $('#shareLinkEditable').val(links.editable);
            $('#shareEventModal').modal('show');
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

        // Modal xác nhận thống nhất thay cho confirm() native
        let _confirmCallback = null;
        function showConfirm(message, onConfirm, opts) {
            opts = opts || {};
            $('#confirmModalMessage').text(message);
            $('#confirmModalOkBtn')
                .text(opts.okLabel || 'Xác nhận')
                .attr('class', 'btn ' + (opts.okClass || 'btn-danger'));
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

        // Xử lý sao chép giao dịch
        $('#copyTransfersBtn').click(function () {
            if (!allowEdit) return; // Không cho phép copy nếu ở chế độ chỉ xem
            
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

        // Thêm handler cho nút share
        $('#shareEventBtn').click(function () {
            if (!currentEventCode) {
                showToast('Vui lòng lưu sự kiện trước khi chia sẻ!', 'warning');
                return;
            }

            // Link chỉnh sửa chứa khóa bí mật; link chỉ xem chỉ có event_code
            const links = buildShareLinks(currentEventCode);
            $('#shareLinkViewOnly').val(links.viewOnly);
            $('#shareLinkEditable').val(links.editable);
            $('#shareEventModal').modal('show');
        });

        // Xử lý copy link chỉ xem
        $('#copyShareLinkViewOnlyBtn').click(function () {
            const shareLink = $('#shareLinkViewOnly');
            shareLink.select();
            document.execCommand('copy');
            showToast('Đã sao chép link chỉ xem thành công!', 'success');
        });

        // Xử lý copy link có thể chỉnh sửa
        $('#copyShareLinkEditableBtn').click(function () {
            const shareLink = $('#shareLinkEditable');
            shareLink.select();
            document.execCommand('copy');
            showToast('Đã sao chép link có thể chỉnh sửa thành công!', 'success');
        });

        function exitEditExpenseMode() {
            editingExpenseIndex = null;
            $('#expenseSubmitBtn').text('Thêm Chi Phí');
            $('#cancelEditExpenseBtn').addClass('d-none');
            $('#expenseTitle').val('');
            $('#expenseAmount').val('');
            resetExpenseDateInput();
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
            $('#benefitType').val(expense.benefitType || 'all').trigger('change');
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

            // Nếu là chi tiêu cho một số người, chọn lại các checkbox
            if (expense.benefitType === 'selected' && Array.isArray(expense.beneficiaries)) {
                // Bỏ trạng thái cũ trước, rồi tick theo value (an toàn với tên có dấu/khoảng trắng)
                $('#beneficiariesList .beneficiary-checkbox').prop('checked', false);
                const wanted = new Set(expense.beneficiaries);
                $('#beneficiariesList .beneficiary-checkbox').each(function () {
                    if (wanted.has(this.value)) this.checked = true;
                });
            }

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
                return $(`<span><img src="${img}" /> ${option.text}</span>`);
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
