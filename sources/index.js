'use strict';
// ============================================================================
// Bin Media — registry module nguồn
// Mỗi nguồn (hiện tại: facebook) là module riêng, expose giao diện thống nhất:
//   - normalizeRef(raw)    → chuẩn hóa tham chiếu do admin cung cấp
//   - isValidRef(raw)      → kiểm tra nhanh
//   - resolvePlayable(raw) → { ok, playUrl, embedUrl } | { ok:false, code, sourceCode }
//   - verifyAccess(raw, o) → { ok, status } — xác minh truy cập công khai
// Lỗi nguồn luôn có dạng code = SOURCE_UNAVAILABLE / SOURCE_UNKNOWN để app
// hiển thị thông báo nhất quán.
// ============================================================================
const core = require('../lib/authcore');
const E = core.E;
const facebook = require('./facebook');

var REGISTRY = {
    facebook: facebook,
};

function get(type) {
    return REGISTRY[String(type || '').toLowerCase()] || null;
}

function normalizeRef(type, raw) {
    var mod = get(type);
    if (!mod) {
        var e = new Error('loai nguon khong ho tro: ' + type);
        e.code = E.SOURCE_UNKNOWN;
        e.httpStatus = 400;
        throw e;
    }
    return mod.normalizeRef(raw);
}

function resolvePlayable(type, raw) {
    var mod = get(type);
    if (!mod) {
        return { ok: false, code: E.SOURCE_UNKNOWN, sourceCode: 'SOURCE_UNKNOWN', message: 'loai nguon khong ho tro: ' + type };
    }
    return mod.resolvePlayable(raw);
}

function verifyAccess(type, raw, opts) {
    var mod = get(type);
    if (!mod) {
        return Promise.resolve({ ok: false, status: 'unavailable', sourceCode: 'SOURCE_UNKNOWN', message: 'loai nguon khong ho tro: ' + type });
    }
    return mod.verifyAccess(raw, opts);
}

module.exports = {
    REGISTRY: REGISTRY,
    get: get,
    normalizeRef: normalizeRef,
    resolvePlayable: resolvePlayable,
    verifyAccess: verifyAccess,
};
