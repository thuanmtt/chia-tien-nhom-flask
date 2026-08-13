// Khởi tạo Google Analytics (gtag) — tách khỏi index.html để CSP script-src
// không phải mở 'unsafe-inline' (script inline là vector XSS chính CSP chặn).
// LƯU Ý: measurement ID ở đây phải KHỚP id trong thẻ gtag/js ở index.html.
window.dataLayer = window.dataLayer || [];

function gtag() {
    dataLayer.push(arguments);
}

gtag('js', new Date());

gtag('config', 'G-85JFS83FXC');
