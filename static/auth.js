// static/auth.js — Đăng nhập/đăng ký qua Supabase Auth (email/password + Google).
// Nạp TRƯỚC app.js; app.js chỉ dùng qua window.AppAuth. Khi Supabase chưa cấu
// hình (/api/config rỗng) mọi hàm vẫn an toàn: isLoggedIn()=false,
// authHeaders() trả nguyên headers — app chạy như bản không có auth.
(function () {
    'use strict';

    let client = null;   // Supabase client (null nếu chưa cấu hình)
    let session = null;  // Session hiện tại (null nếu chưa đăng nhập)
    let ready = false;
    const readyCallbacks = [];

    function onReady(cb) {
        if (ready) { cb(); } else { readyCallbacks.push(cb); }
    }

    function isLoggedIn() { return !!session; }

    function userEmail() {
        return (session && session.user && session.user.email) || '';
    }

    function authHeaders(extra) {
        const headers = Object.assign({}, extra || {});
        if (session && session.access_token) {
            headers['Authorization'] = 'Bearer ' + session.access_token;
        }
        return headers;
    }

    // ===== UI =====
    function renderAuthArea() {
        const $area = $('#authArea');
        if (!$area.length || !client) return;
        $area.empty();
        if (session) {
            // Dropdown user đồng bộ style nav-link với các mục còn lại.
            // Email là dữ liệu user-controlled → luôn qua .text()
            const email = userEmail();
            const shortName = email.split('@')[0];
            const $toggle = $('<a class="nav-link dropdown-toggle" href="#" role="button"'
                + ' data-bs-toggle="dropdown" aria-expanded="false">'
                + '<i class="fas fa-user-circle me-1"></i></a>');
            $toggle.append($('<span></span>').text(shortName));
            const $menu = $('<ul class="dropdown-menu dropdown-menu-end"></ul>');
            $menu.append($('<li></li>').append($('<h6 class="dropdown-header"></h6>').text(email)));
            $menu.append('<li><hr class="dropdown-divider"></li>');
            $menu.append('<li><button type="button" class="dropdown-item" id="accountBtn">'
                + '<i class="fas fa-user-cog me-1"></i>Tài khoản</button></li>');
            $menu.append('<li><button type="button" class="dropdown-item" id="logoutBtn">'
                + '<i class="fas fa-sign-out-alt me-1"></i>Đăng xuất</button></li>');
            $area.append($toggle).append($menu);
        } else {
            $area.append('<a class="nav-link" href="#" id="loginBtn">'
                + '<i class="fas fa-sign-in-alt me-1"></i>Đăng Nhập</a>');
        }
    }

    // supabase-js KHÔNG tự xóa #access_token=... khỏi thanh địa chỉ sau khi xử lý.
    // Nếu để lại: (1) URL xấu/lộ token khi copy; (2) lần đăng nhập OAuth sau sẽ
    // redirect kèm hash cũ → token cũ (đã thu hồi) đè token mới → đăng nhập "câm".
    function cleanAuthHash() {
        const h = window.location.hash;
        if (h && (h.indexOf('access_token=') !== -1 || h.indexOf('error_code=') !== -1
                || h.indexOf('error_description=') !== -1)) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }

    function setAuthMessage(msg, isError) {
        $('#authMessage')
            .attr('class', 'small mb-2 ' + (isError ? 'text-danger' : 'text-success'))
            .text(msg || '');
    }

    function showPane(pane) {
        $('#authPaneLogin').toggleClass('d-none', pane !== 'login');
        $('#authPaneRegister').toggleClass('d-none', pane !== 'register');
        $('#authPaneRecovery').toggleClass('d-none', pane !== 'recovery');
        setAuthMessage('');
    }

    function showLoginModal() {
        if (!client) return;
        showPane('login');
        $('#authModal').modal('show');
    }

    // ===== Khởi tạo =====
    async function init() {
        try {
            const resp = await fetch('/api/config');
            const cfg = await resp.json();
            if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) {
                client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
                // Đăng ký listener TRƯỚC getSession để không lỡ sự kiện SIGNED_IN
                // khi supabase-js đọc #access_token từ URL (OAuth redirect về)
                client.auth.onAuthStateChange(function (event, s) {
                    session = s;
                    cleanAuthHash();
                    renderAuthArea();
                    if (event === 'PASSWORD_RECOVERY') {
                        // Người dùng vào từ link đặt lại mật khẩu trong email
                        showPane('recovery');
                        $('#authModal').modal('show');
                    }
                    document.dispatchEvent(new CustomEvent('appauth:change'));
                });
                try {
                    const res = await client.auth.getSession();
                    session = (res.data && res.data.session) || null;
                } catch (e) {
                    // Token trong URL hỏng/đã thu hồi → coi như chưa đăng nhập,
                    // KHÔNG được làm chết phần auth còn lại
                    session = null;
                }
            }
        } catch (e) {
            // Thiếu cấu hình / lỗi mạng → chạy như bản không có auth
        }
        // Luôn dọn hash token khỏi URL, kể cả khi xử lý phía trên lỗi —
        // hash sót lại làm hỏng lần đăng nhập OAuth kế tiếp
        cleanAuthHash();
        renderAuthArea();
        ready = true;
        readyCallbacks.splice(0).forEach(function (cb) { cb(); });
    }

    // ===== Hành vi (delegated vì #authArea render động) =====
    $(document).on('click', '#loginBtn', showLoginModal);

    $(document).on('click', '#logoutBtn', async function () {
        if (client) await client.auth.signOut();
    });

    // ===== Modal Tài Khoản: username + đặt/đổi mật khẩu =====
    // hasPassword: tài khoản đã có identity 'email' (đặt mật khẩu xong GoTrue
    // thêm identity này — đã kiểm chứng thực tế). Chưa có → ẩn ô mật khẩu cũ.
    let hasPassword = false;

    function setAccountMessage(msg, isError) {
        $('#accountMessage')
            .attr('class', 'small mb-2 ' + (isError ? 'text-danger' : 'text-success'))
            .text(msg || '');
    }

    async function openAccountModal() {
        if (!client || !session) return;
        setAccountMessage('');
        $('#accountOldPassword, #accountNewPassword, #accountConfirmPassword').val('');
        hasPassword = false;
        try {
            const res = await client.auth.getUser();
            const identities = (res.data && res.data.user && res.data.user.identities) || [];
            hasPassword = identities.some(function (i) { return i.provider === 'email'; });
        } catch (e) { /* coi như chưa có mật khẩu */ }
        $('#accountOldPasswordGroup').toggleClass('d-none', !hasPassword);
        $('#accountNoPasswordNote').toggleClass('d-none', hasPassword);
        $('#accountUsername').val('');
        $.ajax({ url: '/api/profile', headers: authHeaders() })
            .done(function (r) { if (r && r.username) $('#accountUsername').val(r.username); });
        $('#accountModal').modal('show');
    }

    $(document).on('click', '#accountBtn', openAccountModal);

    // Nút 👁 hiện/ẩn mật khẩu (dùng chung cho mọi ô trong modal Tài Khoản)
    $(document).on('click', '.toggle-password', function () {
        const $input = $($(this).data('target'));
        const show = $input.attr('type') === 'password';
        $input.attr('type', show ? 'text' : 'password');
        $(this).find('i').attr('class', show ? 'fas fa-eye-slash' : 'fas fa-eye');
    });

    $(document).on('submit', '#accountUsernameForm', function (e) {
        e.preventDefault();
        $.ajax({
            url: '/api/profile',
            method: 'PUT',
            contentType: 'application/json',
            headers: authHeaders(),
            data: JSON.stringify({ username: $('#accountUsername').val() })
        }).done(function (r) {
            if (r.username) {
                $('#accountUsername').val(r.username);
                setAccountMessage('Đã lưu username "' + r.username + '" — dùng được thay email khi đăng nhập.');
            } else {
                setAccountMessage('Đã xóa username.');
            }
        }).fail(function (xhr) {
            const err = xhr.responseJSON && xhr.responseJSON.error;
            setAccountMessage(err || 'Không lưu được username, vui lòng thử lại.', true);
        });
    });

    $(document).on('submit', '#accountPasswordForm', async function (e) {
        e.preventDefault();
        const oldPass = $('#accountOldPassword').val();
        const newPass = $('#accountNewPassword').val();
        const confirmPass = $('#accountConfirmPassword').val();
        if (newPass.length < 6) { setAccountMessage('Mật khẩu mới tối thiểu 6 ký tự.', true); return; }
        if (newPass !== confirmPass) { setAccountMessage('Mật khẩu nhập lại không khớp.', true); return; }
        if (hasPassword) {
            if (!oldPass) { setAccountMessage('Vui lòng nhập mật khẩu cũ.', true); return; }
            // GoTrue không kiểm tra mật khẩu cũ trong updateUser → tự xác minh
            // bằng một lần đăng nhập (thành công thì session được thay mới, vô hại)
            const check = await client.auth.signInWithPassword({ email: userEmail(), password: oldPass });
            if (check.error) { setAccountMessage('Mật khẩu cũ không đúng.', true); return; }
        }
        const res = await client.auth.updateUser({ password: newPass });
        if (res.error) {
            // Hiện lỗi thật từ Supabase — không nuốt message như bản cũ
            setAccountMessage('Không đổi được mật khẩu: ' + (res.error.message || 'lỗi không xác định.'), true);
            return;
        }
        hasPassword = true;
        $('#accountOldPasswordGroup').removeClass('d-none');
        $('#accountNoPasswordNote').addClass('d-none');
        $('#accountOldPassword, #accountNewPassword, #accountConfirmPassword').val('');
        setAccountMessage('Đã lưu mật khẩu — bạn có thể đăng nhập bằng email/username + mật khẩu.');
    });

    $(document).on('click', '#authShowRegister', function () { showPane('register'); });
    $(document).on('click', '#authShowLogin', function () { showPane('login'); });

    $(document).on('submit', '#authLoginForm', async function (e) {
        e.preventDefault();
        const identifier = $('#authLoginEmail').val().trim();
        const password = $('#authLoginPassword').val();
        if (!identifier || !password) { setAuthMessage('Vui lòng nhập email/username và mật khẩu.', true); return; }

        if (identifier.indexOf('@') !== -1) {
            // Email: đăng nhập thẳng với Supabase
            const res = await client.auth.signInWithPassword({ email: identifier, password: password });
            if (res.error) { setAuthMessage('Đăng nhập thất bại — email hoặc mật khẩu không đúng.', true); return; }
            $('#authModal').modal('hide');
            return;
        }

        // Username: backend tra email rồi đổi lấy session (không lộ email người khác)
        try {
            const resp = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: identifier, password: password })
            });
            const data = await resp.json();
            if (!resp.ok || !data.success || !data.session) {
                setAuthMessage((data && data.error) || 'Đăng nhập thất bại, vui lòng thử lại.', true);
                return;
            }
            const set = await client.auth.setSession({
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token
            });
            if (set.error) { setAuthMessage('Đăng nhập thất bại, vui lòng thử lại.', true); return; }
            $('#authModal').modal('hide');
        } catch (err) {
            setAuthMessage('Lỗi mạng khi đăng nhập, vui lòng thử lại.', true);
        }
    });

    $(document).on('submit', '#authRegisterForm', async function (e) {
        e.preventDefault();
        const email = $('#authRegisterEmail').val().trim();
        const password = $('#authRegisterPassword').val();
        if (!email || password.length < 6) {
            setAuthMessage('Email không hợp lệ hoặc mật khẩu quá ngắn (tối thiểu 6 ký tự).', true);
            return;
        }
        const res = await client.auth.signUp({ email: email, password: password });
        if (res.error) { setAuthMessage('Đăng ký thất bại — vui lòng thử lại.', true); return; }
        if (res.data && res.data.session) {
            // Project tắt "Confirm email" — có session ngay, đăng nhập tức thì
            $('#authModal').modal('hide');
            return;
        }
        const user = res.data && res.data.user;
        if (user && Array.isArray(user.identities) && user.identities.length === 0) {
            // Email đã có tài khoản: Supabase trả "thành công giả" (không gửi mail,
            // identities rỗng) để chống dò email — báo đúng thay vì bảo chờ mail
            setAuthMessage('Email này đã có tài khoản — hãy bấm "Đã có tài khoản? Đăng nhập" (hoặc dùng nút Google). '
                + 'Nếu tài khoản tạo bằng Google và bạn muốn có mật khẩu: đăng nhập Google rồi vào menu "Tài khoản" để đặt mật khẩu.', true);
            return;
        }
        setAuthMessage('Đăng ký thành công! Vui lòng kiểm tra email để xác nhận tài khoản.');
    });

    $(document).on('click', '#authGoogleBtn', async function () {
        if (!client) return;
        // Redirect sang Google rồi quay lại đúng trang hiện tại;
        // supabase-js tự bắt token trong URL khi quay về (detectSessionInUrl)
        await client.auth.signInWithOAuth({
            provider: 'google',
            // KHÔNG dùng location.href: nếu URL còn hash (#access_token cũ) thì
            // token mới bị gắn SAU hash cũ → parse trúng token đã thu hồi
            options: { redirectTo: window.location.origin + window.location.pathname + window.location.search }
        });
    });

    $(document).on('click', '#authForgotBtn', async function () {
        const email = $('#authLoginEmail').val().trim();
        if (!email) { setAuthMessage('Nhập email vào ô phía trên rồi bấm lại "Quên mật khẩu?".', true); return; }
        const res = await client.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/'
        });
        if (res.error) { setAuthMessage('Không gửi được email đặt lại mật khẩu.', true); return; }
        setAuthMessage('Đã gửi email đặt lại mật khẩu — vui lòng kiểm tra hộp thư.');
    });

    $(document).on('submit', '#authRecoveryForm', async function (e) {
        e.preventDefault();
        const password = $('#authRecoveryPassword').val();
        if (password.length < 6) { setAuthMessage('Mật khẩu tối thiểu 6 ký tự.', true); return; }
        const res = await client.auth.updateUser({ password: password });
        if (res.error) { setAuthMessage('Không đổi được mật khẩu, vui lòng thử lại.', true); return; }
        setAuthMessage('Đã đổi mật khẩu thành công.');
        setTimeout(function () { $('#authModal').modal('hide'); }, 1200);
    });

    window.AppAuth = {
        onReady: onReady,
        isLoggedIn: isLoggedIn,
        userEmail: userEmail,
        authHeaders: authHeaders,
        showLoginModal: showLoginModal
    };

    $(function () { init(); });
})();
