'use strict';
// ============================================================================
// Bin Media — authcore: ten tai khoan, token, session hash, luat khoa VIP
// (5 lan sai lien tiep → khoa 300 giay, tra 429 AUTH_LOCKED)
// Moi thoi han tinh theo GIOI HE THONG (server). Khong nhan gio tu client.
// ============================================================================
const crypto = require('crypto');

// ---- Hằng số thời gian ------------------------------------------------------
var FREE_DURATION_MS = 48 * 60 * 60 * 1000; // 48 giờ (mặc định, đổi qua env)
var VIP_LOCK_MS = 5 * 60 * 1000;            // 300 giây
var VIP_FAIL_LIMIT = 5;                     // 5 lần sai liên tiếp

// ---- Mã lỗi ổn định (app map ra thông báo có ý nghĩa) ----------------------
var E = {
    BAD_REQUEST: 'BAD_REQUEST',
    NAME_INVALID: 'NAME_INVALID',
    NAME_TAKEN: 'NAME_TAKEN',
    DEVICE_INVALID: 'DEVICE_INVALID',
    DEVICE_REGISTERED: 'DEVICE_REGISTERED',
    NO_ACCOUNT: 'NO_ACCOUNT',
    SESSION_REQUIRED: 'SESSION_REQUIRED',
    SESSION_INVALID: 'SESSION_INVALID',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    SESSION_REVOKED: 'SESSION_REVOKED',
    FREE_EXPIRED: 'FREE_EXPIRED',
    VIP_INVALID: 'VIP_INVALID',
    VIP_INACTIVE: 'VIP_INACTIVE',
    VIP_SOURCE_UNAVAILABLE: 'VIP_SOURCE_UNAVAILABLE',
    AUTH_LOCKED: 'AUTH_LOCKED',
    RATE_LIMITED: 'RATE_LIMITED',
    ADMIN_REQUIRED: 'ADMIN_REQUIRED',
    ADMIN_FORBIDDEN: 'ADMIN_FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
    HISTORY_CONSENT_REQUIRED: 'HISTORY_CONSENT_REQUIRED',
    HISTORY_DISABLED: 'HISTORY_DISABLED',
    SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
    SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
    INTERNAL: 'INTERNAL',
};

function codedError(code, httpStatus, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    e.httpStatus = httpStatus || 400;
    if (extra) {
        var keys = Object.keys(extra);
        for (var i = 0; i < keys.length; i++) e[keys[i]] = extra[keys[i]];
    }
    return e;
}

// ---- Chuẩn hóa tên tài khoản ------------------------------------------------
// - NFC, trim, gộp khoảng trắng
// - 2..40 ký tự chữ/số (có dấu tiếng Việt được), cho phép khoảng trắng và . _ -
// - nameKey = so khớp không phân biệt hoa/thường
var NAME_RE = /^[\p{L}\p{N}]+(?:[ ._-][\p{L}\p{N}]+)*$/u;

function normalizeName(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (s.length < 2 || s.length > 40) return null;
    if (!NAME_RE.test(s)) return null;
    return s;
}

function nameKey(name) {
    return String(name).normalize('NFC').toLowerCase();
}

// ---- Mã định danh thiết bị --------------------------------------------------
// App tự sinh ngẫu nhiên (>=16 ký tự), KHÔNG dùng số IMEI/serial phần cứng.
var DEVICE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function isValidDeviceId(d) {
    return typeof d === 'string' && DEVICE_RE.test(d);
}

// ---- Token / session --------------------------------------------------------
function newSessionToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function newId(prefix) {
    return (prefix || '') + crypto.randomBytes(9).toString('hex');
}

function timingSafeEqualStr(a, b) {
    var ba = Buffer.from(String(a), 'utf8');
    var bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// ---- Slug (metadata video) --------------------------------------------------
function slugify(raw) {
    var s = String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/đ/g, 'd').replace(/Đ/g, 'D');
    s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
}

// ---- Cổng khóa / tần suất --------------------------------------------------
// Một bản ghi cổng: { fails, count, windowStart, lockedUntil, lastAt }
// kind 'fail': đếm SAI LIÊN TIẾP — thành công reset; đạt failLimit → khóa lockMs.
// kind 'rate': đếm LẦN GỌI trong windowMs — vượt max → khóa lockMs.

function newGate() {
    return { fails: 0, count: 0, windowStart: 0, lockedUntil: 0, lastAt: 0 };
}

function gateLocked(gate, now, policy) {
    if (!gate) return null;
    var until = gate.lockedUntil || 0;
    if (until > now) {
        return { retryAfterSec: Math.ceil((until - now) / 1000) };
    }
    if (until && until <= now) {
        // Hết khóa → cho phép thử lại theo chính sách: reset bộ đếm
        gate.fails = 0;
        gate.count = 0;
        gate.lockedUntil = 0;
        gate.windowStart = 0;
    }
    return null;
}

function gateHit(gate, now, policy) {
    // Ghi nhận MỘT lần thử (dùng cho cổng rate)
    gate.lastAt = now;
    if (!gate.windowStart || now - gate.windowStart >= (policy.windowMs || 3600000)) {
        gate.windowStart = now;
        gate.count = 0;
    }
    gate.count += 1;
    if (gate.count > (policy.max || 10)) {
        gate.lockedUntil = now + (policy.lockMs || 60000);
        return { retryAfterSec: Math.ceil((policy.lockMs || 60000) / 1000) };
    }
    return null;
}

function gateFail(gate, now, policy) {
    // Ghi nhận MỘT lần sai (dùng cho cổng fail — 5 lần liên tiếp → khóa)
    gate.lastAt = now;
    gate.fails += 1;
    if (gate.fails >= (policy.failLimit || VIP_FAIL_LIMIT)) {
        gate.lockedUntil = now + (policy.lockMs || VIP_LOCK_MS);
        return { retryAfterSec: Math.ceil((policy.lockMs || VIP_LOCK_MS) / 1000) };
    }
    return null;
}

function gateSuccess(gate) {
    if (!gate) return;
    gate.fails = 0;
    gate.count = 0;
    gate.windowStart = 0;
}

// ---- Chính sách mặc định (đúng đặc tả) -------------------------------------
var POLICIES = {
    vipFail: { failLimit: VIP_FAIL_LIMIT, lockMs: VIP_LOCK_MS },          // 5 sai → 300s
    vipRate: { max: 30, windowMs: 10 * 60 * 1000, lockMs: VIP_LOCK_MS },  // 30 lần/10 phút/IP
    registerRate: { max: 10, windowMs: 60 * 60 * 1000, lockMs: 10 * 60 * 1000 }, // 10 đăng ký/giờ/IP
};

function vipGateKeys(ip, deviceId, nk) {
    var keys = [];
    if (ip) keys.push('vipfail:ip:' + ip);
    if (deviceId) keys.push('vipfail:device:' + deviceId);
    if (nk) keys.push('vipfail:name:' + nk);
    return keys;
}

module.exports = {
    E: E,
    codedError: codedError,
    FREE_DURATION_MS: FREE_DURATION_MS,
    VIP_LOCK_MS: VIP_LOCK_MS,
    VIP_FAIL_LIMIT: VIP_FAIL_LIMIT,
    POLICIES: POLICIES,
    normalizeName: normalizeName,
    nameKey: nameKey,
    isValidDeviceId: isValidDeviceId,
    newSessionToken: newSessionToken,
    hashToken: hashToken,
    newId: newId,
    timingSafeEqualStr: timingSafeEqualStr,
    slugify: slugify,
    newGate: newGate,
    gateLocked: gateLocked,
    gateHit: gateHit,
    gateFail: gateFail,
    gateSuccess: gateSuccess,
    vipGateKeys: vipGateKeys,
};
