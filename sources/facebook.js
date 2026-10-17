'use strict';
// ============================================================================
// Bin Media — MODULE NGUỒN: FACEBOOK (tách riêng, không trộn vào logic app)
// ============================================================================
// PHẠM VI CHO PHÉP (bắt buộc tuân thủ khi phát triển thật):
//   - Chỉ xử lý nội dung CÔNG KHAI mà quản trị viên đã chủ động liên kết
//     (admin link từng tập phim với một URL video Facebook hợp lệ).
//   - Chuẩn hóa tham chiếu → trả URL nhúng (official Facebook plugin) và
//     URL xem gốc. Không lưu, không tải lại, không phân phối lại nội dung.
//   - "Xác minh trạng thái truy cập" = kiểm tra URL công khai còn truy cập
//     được hay không (không cookie, không phiên đăng nhập). Nếu nguồn đòi
//     đăng nhập / gỡ / riêng tư → trả lỗi SOURCE_UNAVAILABLE.
//
// KHÔNG ĐƯỢC LÀM (vi phạm điều khoản Facebook và nguyên tắc dự án):
//   - Không vượt xác thực, không né giới hạn truy cập (login wall, rate limit).
//   - Không lấy nội dung riêng tư / nhóm kín / members-only.
//   - Không giả mạo người dùng Facebook, không dùng token đánh cắp, không
//     scraping bằng phiên đăng nhập cá nhân.
//
// TRƯỚC KHI PHÁT TRIỂN THẬT: chốt API chính thức (Graph API + đăng ký ứng
// dụng, quyền public_video...), xem lại Điều khoản nền tảng Facebook và
// khả năng phát video trong ứng dụng (webview với plugin nhúng chính thức).
// ============================================================================

const https = require('https');
const core = require('../lib/authcore');
const E = core.E;

var SOURCE_TYPE = 'facebook';

// Các mẫu URL video CÔNG KHAI được chấp nhận (whitelist nghiêm ngặt)
var URL_PATTERNS = [
    /^https?:\/\/(?:www\.|m\.)?facebook\.com\/watch\/\?v=([0-9]{5,})(?:&.*)?$/i,
    /^https?:\/\/(?:www\.|m\.)?facebook\.com\/[^\/?]+\/videos\/(?:vb\.[0-9]+\/[0-9]+\/)?([0-9]{5,})(?:\/|[?#].*)?$/i,
    /^https?:\/\/fb\.watch\/([A-Za-z0-9_-]+)\/?$/i,
];

function sourceError(sourceCode, message) {
    var e = new Error(message || sourceCode);
    e.code = E.SOURCE_UNAVAILABLE;
    e.sourceCode = sourceCode;
    e.httpStatus = 502;
    return e;
}

/**
 * Chuẩn hóa tham chiếu nguồn từ admin/import.
 * Trả về ref chuẩn { type:'facebook', canonicalUrl, videoId|null } hoặc ném lỗi.
 */
function normalizeRef(rawRef) {
    if (typeof rawRef !== 'string' || !rawRef.trim()) {
        throw sourceError('SOURCE_INVALID_REF', 'tham chieu nguon Facebook trong');
    }
    var url = rawRef.trim();
    if (url.length > 512) {
        throw sourceError('SOURCE_INVALID_REF', 'tham chieu nguon qua dai');
    }
    for (var i = 0; i < URL_PATTERNS.length; i++) {
        var m = url.match(URL_PATTERNS[i]);
        if (m) {
            return {
                type: SOURCE_TYPE,
                canonicalUrl: url.replace(/[\/?]+$/, ''),
                videoId: /^[0-9]+$/.test(m[1]) ? m[1] : null,
                code: /^[0-9]+$/.test(m[1]) ? null : m[1],
            };
        }
    }
    throw sourceError('SOURCE_INVALID_REF',
        'chi chap nhan URL video Facebook cong khai (facebook.com/.../videos/..., watch?v=..., fb.watch/...)');
}

function isValidRef(rawRef) {
    try { normalizeRef(rawRef); return true; } catch (e) { return false; }
}

/**
 * Trả URL phát/URL nhúng hợp lệ cho một tham chiếu đã chuẩn hóa.
 * - embedUrl: trang plugin video chính thức của Facebook (phát trong webview).
 * - playUrl : URL xem gốc trên Facebook (mở trình duyệt / trình phát ngoài).
 * KHÔNG tải, không trích xuất stream riêng — chỉ liên kết tới nội dung công khai.
 */
function resolvePlayable(rawRef) {
    var ref;
    try {
        ref = normalizeRef(rawRef);
    } catch (e) {
        return { ok: false, sourceCode: e.sourceCode, code: E.SOURCE_UNAVAILABLE, message: e.message };
    }
    var embedUrl = 'https://www.facebook.com/plugins/video.php?href=' +
        encodeURIComponent(ref.canonicalUrl) + '&show_text=false&width=720&height=405';
    return {
        ok: true,
        source: SOURCE_TYPE,
        playUrl: ref.canonicalUrl,
        embedUrl: embedUrl,
        access: 'public-embed',
    };
}

/**
 * Xác minh trạng thái truy cập của URL công khai (không cookie, không đăng nhập).
 * Chỉ dùng khi online=true (FACEBOOK_VERIFY_ONLINE=1) — cần xem xét điều khoản
 * và tần suất gọi trước khi bật trong sản phẩm thật.
 *
 * Kết quả: { ok:true, status:'verified'|'unknown' } hoặc
 *          { ok:false, status:'unavailable', sourceCode, message }.
 * Redirect tới trang đăng nhập → 'unavailable' (KHÔNG vượt qua login wall).
 */
function verifyAccess(rawRef, opts) {
    opts = opts || {};
    var ref;
    try {
        ref = normalizeRef(rawRef);
    } catch (e) {
        return Promise.resolve({ ok: false, status: 'unavailable', sourceCode: e.sourceCode, message: e.message });
    }
    if (!opts.online) {
        return Promise.resolve({ ok: true, status: 'unknown', message: 'verify online dang tat (config)' });
    }
    return new Promise(function (resolve) {
        var settled = false;
        var done = function (v) { if (!settled) { settled = true; resolve(v); } };
        var u;
        try { u = new URL(ref.canonicalUrl); } catch (e) {
            return done({ ok: false, status: 'unavailable', sourceCode: 'SOURCE_INVALID_REF', message: 'URL khong hop le' });
        }
        var req = https.request({
            hostname: u.hostname,
            port: 443,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                // Trình duyệt/crawler thông thường — KHÔNG mang cookie/phiên đăng nhập
                'User-Agent': 'Mozilla/5.0 (compatible; BinMediaLinkCheck/1.0)',
                'Accept': 'text/html',
            },
        }, function (res) {
            res.resume();
            var loc = res.headers.location || '';
            var redirectedToLogin = loc.indexOf('/login') !== -1 || loc.indexOf('checkpoint') !== -1;
            if (res.statusCode >= 200 && res.statusCode < 300 && !redirectedToLogin) {
                return done({ ok: true, status: 'verified' });
            }
            done({
                ok: false,
                status: 'unavailable',
                sourceCode: 'SOURCE_ACCESS_DENIED',
                message: 'nguon khong truy cap duoc cong khai (HTTP ' + res.statusCode + ')',
            });
        });
        req.on('error', function (e) {
            done({ ok: false, status: 'unavailable', sourceCode: 'SOURCE_ERROR', message: 'khong kiem tra duoc nguon: ' + e.message });
        });
        req.setTimeout(10000, function () {
            req.destroy(new Error('timeout'));
        });
        req.end();
    });
}

module.exports = {
    SOURCE_TYPE: SOURCE_TYPE,
    normalizeRef: normalizeRef,
    isValidRef: isValidRef,
    resolvePlayable: resolvePlayable,
    verifyAccess: verifyAccess,
};
