'use strict';
// ============================================================================
// BIN MEDIA SERVER — Backend cho ứng dụng Bin Media
// ----------------------------------------------------------------------------
// Trách nhiệm (đúng đặc tả):
//   - API cho ứng dụng di động.
//   - Quản lý tài khoản Free (48 giờ, 1 tài khoản/thiết bị) và VIP (tên trong
//     danh sách VIP quản lý trên GitLab — token GitLab chỉ tồn tại ở SERVER).
//   - Tạo/thu hồi session (token ngẫu nhiên, chỉ lưu HASH trong CSDL).
//   - Chống đăng ký Free trùng thiết bị (nguyên tử), giới hạn đăng nhập sai
//     (5 lần liên tiếp → khóa 300 giây, 429 AUTH_LOCKED — khóa sống qua restart).
//   - Metadata video: danh mục, phim, tập, trạng thái liên kết phim–video.
//   - Module nguồn Facebook tách riêng (sources/facebook.js) — chỉ nội dung
//     được phép, không vượt xác thực, lỗi nhất quán SOURCE_UNAVAILABLE.
//   - Lịch sử xem: chỉ ghi khi người dùng được thông báo và đồng ý.
//   - Log, xử lý lỗi, giám sát (/health, /api/admin/status).
//
// Nguyên tắc bảo mật:
//   - Backend là nguồn sự thật DUY NHẤT về thời hạn Free và trạng thái VIP.
//     Mọi mốc thời gian tính bằng đồng hồ server — client không thể sửa.
//   - Session token sinh ngẫu nhiên (32 byte), lưu SHA-256, thu hồi được.
//   - Session hết hạn / bị thu hồi → phải xác thực trực tuyến lại.
//   - Không trả danh sách tên VIP trong bất kỳ phản hồi lỗi nào.
// ============================================================================
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const core = require('./lib/authcore');
const storeLib = require('./lib/store');
const sources = require('./sources');

const E = core.E;
const codedError = core.codedError;

var VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------
function loadConfig(env, overrides) {
    env = env || process.env;
    var c = {
        port: parseInt(env.PORT || '8787', 10),
        host: env.HOST || '0.0.0.0',
        adminToken: env.ADMIN_TOKEN || '',

        // Store: 'postgres' (khuyến nghị trên Render) | 'json' | 'git'
        storeDriver: env.STORE_DRIVER || 'json',
        dataFile: env.DATA_FILE || 'data/bimedia.json',
        databaseUrl: env.DATABASE_URL || '',
        databaseSsl: env.DATABASE_SSL !== '0',
        autoMigrate: env.STORE_AUTO_MIGRATE !== '0',

        // Store 'git' (file JSON trong repo riêng — bền vững trên Render)
        gitProvider: env.STORE_GIT_PROVIDER || 'github',
        gitToken: env.STORE_GIT_TOKEN || env.GITHUB_TOKEN || '',
        gitOwner: env.STORE_GIT_OWNER || env.GITHUB_OWNER || '',
        gitRepo: env.STORE_GIT_REPO || env.GITHUB_REPO || '',
        gitProjectId: env.STORE_GIT_PROJECT_ID || '',
        gitPath: env.STORE_GIT_PATH || 'bimedia-db.json',
        gitBranch: env.STORE_GIT_BRANCH || env.GITHUB_BRANCH || 'main',
        gitApiUrl: env.STORE_GIT_API_URL || '',

        // Danh sách VIP (quản lý trên GitLab) — token chỉ ở server
        vipSource: env.VIP_SOURCE || (env.GITLAB_PROJECT_ID ? 'gitlab' : (env.VIP_LIST_STATIC ? 'static' : 'file')),
        vipListStatic: env.VIP_LIST_STATIC || '',
        vipListFile: env.VIP_LIST_FILE || 'vip.txt',
        gitlabApiUrl: env.GITLAB_API_URL || 'https://gitlab.com/api/v4',
        gitlabToken: env.GITLAB_TOKEN || '',
        gitlabProjectId: env.GITLAB_PROJECT_ID || '',
        gitlabVipPath: env.GITLAB_VIP_PATH || 'vip.txt',
        gitlabVipRef: env.GITLAB_VIP_REF || 'main',
        vipListTtlMs: parseInt(env.VIP_LIST_TTL_MS || '60000', 10),
        vipStaleMaxMs: parseInt(env.VIP_STALE_MAX_MS || String(24 * 3600 * 1000), 10),

        // Tài khoản Free / khóa VIP
        freeDurationHours: parseInt(env.FREE_DURATION_HOURS || '48', 10),
        vipFailLimit: parseInt(env.VIP_FAIL_LIMIT || '5', 10),
        vipLockSeconds: parseInt(env.VIP_LOCK_SECONDS || '300', 10),

        // HTTP
        corsOrigin: env.CORS_ORIGIN || '*',
        maxBody: parseInt(env.MAX_BODY || '65536', 10),
        trustProxy: env.TRUST_PROXY !== '0',

        // Lịch sử xem (thông báo cho người dùng trước khi ghi)
        historyEnabled: env.HISTORY_ENABLED !== '0',
        historyNotice: env.HISTORY_NOTICE ||
            'Bin Media lưu lịch sử xem của bạn trên máy chủ để hỗ trợ tiếp tục xem. ' +
            'Bạn có thể từ chối hoặc xóa lịch sử bất cứ lúc nào.',

        // Nguồn Facebook
        facebookVerifyOnline: env.FACEBOOK_VERIFY_ONLINE === '1',
        sourceCacheTtlMs: parseInt(env.SOURCE_CACHE_TTL_MS || '600000', 10),
    };
    if (overrides) {
        var keys = Object.keys(overrides);
        for (var i = 0; i < keys.length; i++) c[keys[i]] = overrides[keys[i]];
    }
    if (!c.now) c.now = function () { return Date.now(); };
    return c;
}

// ---------------------------------------------------------------------------
// Log (JSON lines, không bao giờ log token)
// ---------------------------------------------------------------------------
function makeLogger() {
    return function log(level, msg, extra) {
        var line = { ts: new Date().toISOString(), level: level, msg: msg };
        if (extra) {
            var keys = Object.keys(extra);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (/token|authorization|password|secret/i.test(k)) continue;
                line[k] = extra[k];
            }
        }
        console.log(JSON.stringify(line));
    };
}

// ---------------------------------------------------------------------------
// Danh sách VIP trên GitLab (hoặc static/file cho dev/test)
// TTL + stale-if-error: nguồn lỗi vẫn dùng dữ liệu cũ tối đa vipStaleMaxMs.
// ---------------------------------------------------------------------------
function createVipList(config, log) {
    var state = {
        keys: new Set(),       // nameKey (không phân biệt hoa/thường)
        names: [],             // tên gốc (KHÔNG BAO GIỜ trả ra ngoài)
        loadedAt: 0,
        ok: false,
        error: null,
    };

    function parseList(text) {
        var t = String(text || '').trim();
        if (!t) return [];
        try {
            var j = JSON.parse(t);
            if (Array.isArray(j)) {
                return j.filter(function (x) { return typeof x === 'string'; });
            }
        } catch (e) { /* không phải JSON → danh sách theo dòng */ }
        return t.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    }

    function fetchGitLab() {
        var url = config.gitlabApiUrl.replace(/\/+$/, '') + '/projects/' +
            encodeURIComponent(config.gitlabProjectId) + '/repository/files/' +
            encodeURIComponent(config.gitlabVipPath) + '?ref=' + encodeURIComponent(config.gitlabVipRef);
        return new Promise(function (resolve, reject) {
            var u = new URL(url);
            var headers = { 'User-Agent': 'binmedia-server/' + VERSION, 'Accept': 'application/json' };
            if (config.gitlabToken) headers['PRIVATE-TOKEN'] = config.gitlabToken;
            var req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: headers }, function (res) {
                var buf = '';
                res.on('data', function (c) { if (buf.length < 2 * 1024 * 1024) buf += c; });
                res.on('end', function () {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error('GitLab VIP list: HTTP ' + res.statusCode));
                    }
                    try {
                        var data = JSON.parse(buf);
                        resolve(Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8'));
                    } catch (e) {
                        reject(new Error('GitLab VIP list: response khong hop le'));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
            req.end();
        });
    }

    function fetchSource() {
        if (config.vipSource === 'static') {
            return Promise.resolve(config.vipListStatic || '[]');
        }
        if (config.vipSource === 'file') {
            return fs.promises.readFile(config.vipListFile, 'utf8');
        }
        if (config.vipSource === 'gitlab') {
            return fetchGitLab();
        }
        return Promise.reject(new Error('vip source khong ho tro: ' + config.vipSource));
    }

    async function refresh() {
        try {
            var text = await fetchSource();
            var names = parseList(text);
            state.keys = new Set(names.map(function (n) { return core.nameKey(n); }));
            state.names = names;
            state.loadedAt = config.now();
            state.ok = true;
            state.error = null;
            log('info', 'vip list loaded', { source: config.vipSource, count: names.length });
            return true;
        } catch (e) {
            state.error = e.message;
            log('error', 'vip list load failed', { source: config.vipSource, error: e.message });
            return false;
        }
    }

    function freshness() {
        if (state.loadedAt && state.ok) return 'fresh';
        if (state.loadedAt && (config.now() - state.loadedAt) <= config.vipStaleMaxMs) return 'stale';
        return 'unknown';
    }

    return {
        refresh: refresh,
        // { known, member, stale } — known=false nghĩa là KHÔNG xác định được
        check: function (nameKeyValue) {
            var f = freshness();
            if (f === 'unknown') return { known: false, member: false, stale: false };
            return { known: true, member: state.keys.has(nameKeyValue), stale: f === 'stale' };
        },
        state: function () {
            return {
                source: config.vipSource,
                ok: state.ok,
                count: state.keys.size,
                loadedAt: state.loadedAt ? new Date(state.loadedAt).toISOString() : null,
                stale: freshness() === 'stale',
                error: state.error,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, code, obj) {
    if (res.headersSent) return;
    var body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function fail(res, code, httpStatus, message, extra) {
    var err = { code: code, message: message };
    if (extra) Object.assign(err, extra);
    return send(res, httpStatus, { error: err });
}

function readBody(req, maxBody) {
    return new Promise(function (resolve, reject) {
        var body = '';
        var size = 0;
        var settled = false;
        var finish = function (fn, v) { if (!settled) { settled = true; fn(v); } };
        req.on('data', function (chunk) {
            size += chunk.length;
            if (size > maxBody) {
                req.destroy();
                finish(reject, codedError(E.BAD_REQUEST, 400, 'body qua lon'));
                return;
            }
            body += chunk;
        });
        req.on('end', function () {
            try {
                finish(resolve, body ? JSON.parse(body) : {});
            } catch (e) {
                finish(reject, codedError(E.BAD_REQUEST, 400, 'JSON khong hop le'));
            }
        });
        req.on('error', function () {
            finish(reject, codedError(E.BAD_REQUEST, 400, 'khong doc duoc body'));
        });
    });
}

function clientIp(req, config) {
    if (config.trustProxy) {
        var xff = req.headers['x-forwarded-for'];
        if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function bearerToken(req) {
    var h = req.headers.authorization || '';
    return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}

function matchRoute(route, method, pathname) {
    if (route.method !== method) return null;
    return pathMatches(route.parts, pathname);
}

function pathMatches(parts, pathname) {
    var segs = pathname.split('/').filter(Boolean);
    if (segs.length !== parts.length) return null;
    var params = {};
    for (var i = 0; i < segs.length; i++) {
        var p = parts[i];
        if (p.charAt(0) === ':') params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) return null;
    }
    return params;
}

// ---------------------------------------------------------------------------
// Ứng dụng
// ---------------------------------------------------------------------------
function createApp(opts) {
    opts = opts || {};
    var config = opts.config || loadConfig();
    var store = opts.store;
    var log = opts.log || makeLogger();
    var vipList = opts.vipList || createVipList(config, log);
    var policies = {
        vipFail: { failLimit: config.vipFailLimit, lockMs: config.vipLockSeconds * 1000 },
        vipRate: core.POLICIES.vipRate,
        registerRate: core.POLICIES.registerRate,
    };

    // Cache kết quả resolve nguồn (không gọi lại liên tục — "cache dữ liệu nguồn")
    var sourceCache = new Map(); // key → { at, value }

    function cacheGet(key) {
        var e = sourceCache.get(key);
        if (!e) return null;
        if (config.now() - e.at > config.sourceCacheTtlMs) { sourceCache.delete(key); return null; }
        return e.value;
    }
    function cacheSet(key, value) {
        sourceCache.set(key, { at: config.now(), value: value });
    }

    function historyNotice() {
        return {
            enabled: config.historyEnabled,
            notice: config.historyNotice,
            policy: 'history_consent_required',
        };
    }

    function publicAccount(acc, now) {
        return {
            name: acc.name,
            type: acc.type,
            status: acc.status,
            createdAt: acc.createdAt,
            freeExpiresAt: acc.type === 'free' ? acc.freeExpiresAt : null,
            freeValid: acc.type === 'free' ? now < acc.freeExpiresAt : null,
            remainingFreeSec: acc.type === 'free' ? Math.max(0, Math.floor((acc.freeExpiresAt - now) / 1000)) : null,
            historyConsent: acc.historyConsent
                ? { accepted: !!acc.historyConsent.accepted, at: acc.historyConsent.at || null }
                : null,
            serverTime: new Date(now).toISOString(),
        };
    }

    function publicSession(s) {
        return {
            id: s.id,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt || null,
            revokedAt: s.revokedAt || null,
            lastSeenAt: s.lastSeenAt || null,
        };
    }

    async function createSessionFor(acc, ip, ua) {
        var now = config.now();
        var token = core.newSessionToken();
        var session = {
            id: core.newId('ses_'),
            tokenHash: core.hashToken(token), // chỉ hash — token thô KHÔNG lưu
            accountId: acc.id,
            createdAt: now,
            expiresAt: acc.type === 'free' ? acc.freeExpiresAt : null,
            revokedAt: null,
            lastSeenAt: now,
            ip: ip,
            ua: ua,
        };
        await store.createSession(session);
        return { token: token, session: session };
    }

    // Xác thực session: hết hạn / thu hồi → phải xác thực trực tuyến lại.
    async function authenticate(req) {
        var token = bearerToken(req);
        if (!token) throw codedError(E.SESSION_REQUIRED, 401, 'can session hop le');
        var session = await store.findSessionByTokenHash(core.hashToken(token));
        if (!session) throw codedError(E.SESSION_INVALID, 401, 'session khong hop le');
        if (session.revokedAt) throw codedError(E.SESSION_REVOKED, 401, 'session da bi thu hoi');
        var now = config.now();
        var acc = await store.getAccountById(session.accountId);
        if (!acc || acc.status !== 'active') {
            throw codedError(E.SESSION_INVALID, 401, 'tai khoan khong con hieu luc');
        }
        // Kiểm tra quyền theo tài khoản TRƯỚC — lỗi trả về phải có ý nghĩa
        // (FREE_EXPIRED/VIP_INACTIVE) thay vì "session hết hạn" chung chung.
        if (acc.type === 'free') {
            if (now >= acc.freeExpiresAt) {
                throw codedError(E.FREE_EXPIRED, 403, 'tai khoan Free da het han 48 gio');
            }
        } else if (acc.type === 'vip') {
            var v = vipList.check(acc.nameKey);
            if (!v.known) {
                throw codedError(E.VIP_SOURCE_UNAVAILABLE, 503, 'khong xac minh duoc quyen VIP luc nay');
            }
            if (!v.member) {
                throw codedError(E.VIP_INACTIVE, 403, 'quyen VIP khong con hieu luc');
            }
        }
        if (session.expiresAt && now > session.expiresAt) {
            throw codedError(E.SESSION_EXPIRED, 401, 'session da het han');
        }
        store.touchSession(session.id, now).catch(function () {});
        return { session: session, account: acc, now: now };
    }

    function requireAdmin(req) {
        if (!config.adminToken) {
            throw codedError(E.INTERNAL, 500, 'server chua cau hinh ADMIN_TOKEN');
        }
        var token = bearerToken(req) || String(req.headers['x-admin-token'] || '');
        if (!token || !core.timingSafeEqualStr(token, config.adminToken)) {
            throw codedError(E.ADMIN_FORBIDDEN, 403, 'sai admin token');
        }
    }

    // ---- Cổng khóa/tần suất ------------------------------------------------
    async function gateCheck(keys, policy, kind) {
        for (var i = 0; i < keys.length; i++) {
            var g = await store.getAttempt(keys[i]);
            var locked = core.gateLocked(g, config.now(), policy);
            if (locked) {
                return { locked: locked, gate: g, key: keys[i], kind: kind };
            }
        }
        return null;
    }
    async function gateFailAll(keys, policy) {
        var retryAfterSec = null;
        for (var i = 0; i < keys.length; i++) {
            var g = await store.getAttempt(keys[i]);
            var r = core.gateFail(g, config.now(), policy);
            if (r) retryAfterSec = r.retryAfterSec;
            await store.saveAttempt(keys[i], g);
        }
        return retryAfterSec;
    }
    async function gateSuccessAll(keys) {
        for (var i = 0; i < keys.length; i++) {
            var g = await store.getAttempt(keys[i]);
            core.gateSuccess(g);
            await store.saveAttempt(keys[i], g);
        }
    }

    // ---- Handlers: auth ----------------------------------------------------
    async function handleRegisterFree(ctx) {
        var now = config.now();
        var body = ctx.body;

        // Giới hạn tần suất theo IP (kết hợp với khóa theo thiết bị/tên ở login-vip)
        var rateKeys = ['reg:ip:' + ctx.ip];
        var rate = await gateCheck(rateKeys, policies.registerRate, 'rate');
        if (rate) {
            throw codedError(E.RATE_LIMITED, 429, 'qua nhieu luot dang ky, thu lai sau', { retryAfterSec: rate.locked.retryAfterSec });
        }
        var rateGate = await store.getAttempt(rateKeys[0]);
        core.gateHit(rateGate, now, policies.registerRate);
        await store.saveAttempt(rateKeys[0], rateGate);

        var name = core.normalizeName(body.name);
        if (!name) throw codedError(E.NAME_INVALID, 400, 'ten tai khoan khong hop le (2–40 ky tu)');
        if (!core.isValidDeviceId(body.deviceId)) {
            throw codedError(E.DEVICE_INVALID, 400, 'ma thiet bi khong hop le');
        }
        var nk = core.nameKey(name);

        // Không cho đăng ký Free bằng tên nằm trong danh sách VIP (không hé lộ danh sách)
        var v = vipList.check(nk);
        if (!v.known) {
            throw codedError(E.SERVICE_UNAVAILABLE, 503, 'khong xac minh duoc ten tai khoan luc nay');
        }
        if (v.member) {
            throw codedError(E.NAME_TAKEN, 409, 'ten tai khoan da duoc su dung');
        }

        var account;
        try {
            account = await store.registerFree({
                accountId: core.newId('acc_'),
                name: name,
                nameKey: nk,
                deviceId: String(body.deviceId),
                now: now,
                freeExpiresAt: now + config.freeDurationHours * 3600 * 1000,
            });
        } catch (e) {
            if (e.code === E.DEVICE_REGISTERED || e.code === E.NAME_TAKEN) throw e;
            throw e;
        }
        var created = await createSessionFor(account, ctx.ip, ctx.ua);
        log('info', 'register-free ok', { accountId: account.id, ip: ctx.ip });
        return {
            token: created.token,
            account: publicAccount(account, now),
            session: publicSession(created.session),
            history: historyNotice(),
        };
    }

    async function handleRestore(ctx) {
        var now = config.now();
        var deviceId = String(ctx.body.deviceId || '');
        if (!core.isValidDeviceId(deviceId)) {
            throw codedError(E.DEVICE_INVALID, 400, 'ma thiet bi khong hop le');
        }
        var device = await store.getFreeDevice(deviceId);
        var acc = null;
        if (device) {
            var byDevice = await store.getAccountById(device.accountId);
            if (byDevice && byDevice.status === 'active') acc = byDevice;
        }
        if (!acc) {
            // Thiết bị chưa đăng ký Free → app chuyển sang luồng đăng ký
            // (tài khoản VIP thuần không khôi phục bằng deviceId — đăng nhập lại bằng tên)
            throw codedError(E.NO_ACCOUNT, 404, 'thiet bi chua co tai khoan');
        }
        if (acc.lastDeviceId !== deviceId && acc.deviceId !== deviceId) {
            throw codedError(E.NO_ACCOUNT, 404, 'thiet bi chua co tai khoan');
        }
        if (acc.type === 'free' && now >= acc.freeExpiresAt) {
            throw codedError(E.FREE_EXPIRED, 403, 'tai khoan Free da het han 48 gio');
        }
        if (acc.type === 'vip') {
            var v = vipList.check(acc.nameKey);
            if (!v.known) throw codedError(E.VIP_SOURCE_UNAVAILABLE, 503, 'khong xac minh duoc quyen VIP luc nay');
            if (!v.member) throw codedError(E.VIP_INACTIVE, 403, 'quyen VIP khong con hieu luc');
        }
        var created = await createSessionFor(acc, ctx.ip, ctx.ua);
        log('info', 'restore ok', { accountId: acc.id, ip: ctx.ip });
        return {
            token: created.token,
            account: publicAccount(acc, now),
            session: publicSession(created.session),
            history: historyNotice(),
        };
    }

    async function handleLoginVip(ctx) {
        var now = config.now();
        var body = ctx.body;
        var rawName = typeof body.name === 'string' ? body.name : '';
        var deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
        var name = core.normalizeName(rawName);
        var nk = name ? core.nameKey(name) : core.nameKey(rawName.trim().slice(0, 40) || '?');

        // Cổng khóa: IP + thiết bị + tên — bất kỳ cổng nào đang khóa đều chặn
        var failKeys = core.vipGateKeys(ctx.ip, core.isValidDeviceId(deviceId) ? deviceId : '', nk);
        var hit = await gateCheck(failKeys, policies.vipFail, 'fail');
        if (hit) {
            log('warn', 'vip login blocked (locked)', { ip: ctx.ip, key: hit.key, retryAfterSec: hit.locked.retryAfterSec });
            throw codedError(E.AUTH_LOCKED, 429,
                'dang nhap bi khoa sau qua nhieu lan sai, thu lai sau ' + hit.locked.retryAfterSec + ' giay',
                { retryAfterSec: hit.locked.retryAfterSec });
        }
        var rateKeys = ['viplate:ip:' + ctx.ip];
        var rate = await gateCheck(rateKeys, policies.vipRate, 'rate');
        if (rate) {
            throw codedError(E.RATE_LIMITED, 429, 'qua nhieu luot dang nhap, thu lai sau', { retryAfterSec: rate.locked.retryAfterSec });
        }
        var rateGate = await store.getAttempt(rateKeys[0]);
        core.gateHit(rateGate, now, policies.vipRate);
        await store.saveAttempt(rateKeys[0], rateGate);

        // Tên không hợp lệ cũng tính là 1 lần sai (không lộ danh sách VIP)
        if (!name) {
            await gateFailAll(failKeys, policies.vipFail);
            throw codedError(E.VIP_INVALID, 401, 'ten VIP khong hop le');
        }

        var v = vipList.check(nk);
        if (!v.known) {
            // Không xác minh được danh sách → KHÔNG cấp quyền mới, không tính lần sai
            throw codedError(E.VIP_SOURCE_UNAVAILABLE, 503, 'khong xac minh duoc danh sach VIP luc nay');
        }
        if (!v.member) {
            var retryAfterSec = await gateFailAll(failKeys, policies.vipFail);
            log('warn', 'vip login failed', { ip: ctx.ip, hasDevice: !!deviceId, fails: true });
            throw codedError(E.VIP_INVALID, 401, 'ten VIP khong hop le',
                retryAfterSec ? { retryAfterSec: retryAfterSec } : undefined);
        }

        await gateSuccessAll(failKeys);

        var acc = await store.getAccountByNameKey(nk);
        if (!acc) {
            acc = await store.saveAccount({
                id: core.newId('acc_'),
                name: name,
                nameKey: nk,
                type: 'vip',
                deviceId: null,
                lastDeviceId: core.isValidDeviceId(deviceId) ? deviceId : null,
                createdAt: now,
                freeExpiresAt: null,
                historyConsent: null,
                status: 'active',
                updatedAt: now,
            });
        } else if (acc.type === 'free') {
            // Tên Free được admin đưa vào danh sách VIP → nâng quyền theo server
            acc.type = 'vip';
            acc.freeExpiresAt = null;
            if (core.isValidDeviceId(deviceId)) acc.lastDeviceId = deviceId;
            acc = await store.saveAccount(acc);
        } else {
            if (core.isValidDeviceId(deviceId)) {
                acc.lastDeviceId = deviceId;
                acc = await store.saveAccount(acc);
            }
        }

        var created = await createSessionFor(acc, ctx.ip, ctx.ua);
        log('info', 'vip login ok', { accountId: acc.id, ip: ctx.ip });
        return {
            token: created.token,
            account: publicAccount(acc, now),
            session: publicSession(created.session),
            history: historyNotice(),
        };
    }

    async function handleMe(ctx) {
        return {
            account: publicAccount(ctx.account, ctx.now),
            session: publicSession(ctx.session),
            history: historyNotice(),
        };
    }

    async function handleLogout(ctx) {
        await store.revokeSession(ctx.session.id, config.now());
        return { ok: true };
    }

    // ---- Handlers: lịch sử xem (có thông báo + đồng ý) ---------------------
    async function handleHistoryGet(ctx) {
        var items = await store.listHistory(ctx.account.id);
        return {
            consent: ctx.account.historyConsent
                ? { accepted: !!ctx.account.historyConsent.accepted, at: ctx.account.historyConsent.at || null }
                : { accepted: false, at: null },
            history: historyNotice(),
            items: items,
        };
    }

    async function handleHistoryConsent(ctx) {
        if (!config.historyEnabled) throw codedError(E.HISTORY_DISABLED, 403, 'lich su xem dang tat');
        var accepted = !!ctx.body.accepted;
        var acc = ctx.account;
        acc.historyConsent = { accepted: accepted, at: config.now() };
        await store.saveAccount(acc);
        if (!accepted) await store.clearHistory(acc.id);
        return { ok: true, consent: acc.historyConsent, history: historyNotice() };
    }

    async function handleHistoryAdd(ctx) {
        if (!config.historyEnabled) throw codedError(E.HISTORY_DISABLED, 403, 'lich su xem dang tat');
        if (!ctx.account.historyConsent || !ctx.account.historyConsent.accepted) {
            // Bắt buộc thông báo + đồng ý trước khi lưu
            throw codedError(E.HISTORY_CONSENT_REQUIRED, 403,
                'can dong y luu lich su xem truoc (xem thong bao trong lich su)');
        }
        var movieId = String(ctx.body.movieId || '');
        var episodeId = String(ctx.body.episodeId || '');
        var positionSec = Number(ctx.body.positionSec);
        if (!movieId || !episodeId || !Number.isFinite(positionSec) || positionSec < 0) {
            throw codedError(E.BAD_REQUEST, 400, 'du lieu lich su khong hop le');
        }
        var entry = {
            accountId: ctx.account.id,
            movieId: movieId,
            episodeId: episodeId,
            positionSec: positionSec,
            updatedAt: config.now(),
        };
        await store.putHistory(entry);
        return { ok: true, entry: entry };
    }

    async function handleHistoryClear(ctx) {
        await store.clearHistory(ctx.account.id);
        return { ok: true };
    }

    // ---- Handlers: catalog -------------------------------------------------
    function movieView(m, episodes) {
        var eps = episodes || [];
        var linkStatus = 'unlinked';
        if (eps.length) {
            if (eps.some(function (e) { return e.linkStatus === 'broken'; })) linkStatus = 'broken';
            else if (eps.every(function (e) { return e.linkStatus === 'linked'; })) linkStatus = 'linked';
            else linkStatus = 'partial';
        }
        return {
            id: m.id,
            title: m.title,
            slug: m.slug,
            description: m.description || '',
            posterUrl: m.posterUrl || null,
            categoryIds: m.categoryIds || [],
            episodeCount: eps.length,
            linkStatus: linkStatus,
            updatedAt: m.updatedAt,
        };
    }

    async function handleCategories(ctx) {
        return { items: await store.listCategories() };
    }

    async function handleMovies(ctx) {
        var q = ctx.url.searchParams.get('q') || '';
        var categoryId = ctx.url.searchParams.get('category') || '';
        var page = parseInt(ctx.url.searchParams.get('page') || '1', 10);
        var pageSize = parseInt(ctx.url.searchParams.get('pageSize') || '20', 10);
        var sort = ctx.url.searchParams.get('sort') === 'updated' ? 'updated' : 'title';
        var out = await store.listMovies({ q: q, categoryId: categoryId || null, page: page, pageSize: pageSize, sort: sort });
        var items = [];
        for (var i = 0; i < out.items.length; i++) {
            var eps = await store.listEpisodes(out.items[i].id);
            items.push(movieView(out.items[i], eps));
        }
        return { items: items, total: out.total, page: out.page, pageSize: out.pageSize };
    }

    async function handleMovieDetail(ctx) {
        var m = await store.findMovie(ctx.params.id);
        if (!m) throw codedError(E.NOT_FOUND, 404, 'khong tim thay phim');
        var eps = await store.listEpisodes(m.id);
        return { movie: movieView(m, eps) };
    }

    async function handleMovieEpisodes(ctx) {
        var m = await store.findMovie(ctx.params.id);
        if (!m) throw codedError(E.NOT_FOUND, 404, 'khong tim thay phim');
        var eps = await store.listEpisodes(m.id);
        return {
            movie: { id: m.id, title: m.title },
            items: eps.map(function (e) {
                return {
                    id: e.id,
                    movieId: e.movieId,
                    title: e.title,
                    epNumber: e.epNumber,
                    sourceType: e.sourceType,
                    linkStatus: e.linkStatus,
                    accessStatus: e.accessStatus,
                };
            }),
        };
    }

    async function handleEpisodeDetail(ctx) {
        var e = await store.findEpisode(ctx.params.id);
        if (!e) throw codedError(E.NOT_FOUND, 404, 'khong tim thay tap phim');
        var m = await store.findMovie(e.movieId);
        return {
            episode: {
                id: e.id, movieId: e.movieId, title: e.title, epNumber: e.epNumber,
                sourceType: e.sourceType, linkStatus: e.linkStatus, accessStatus: e.accessStatus,
            },
            movie: m ? { id: m.id, title: m.title } : null,
        };
    }

    // Phát phim: chỉ đường dẫn/URL nhúng hợp lệ từ module nguồn — lỗi nhất quán
    async function handlePlay(ctx) {
        var ep = await store.findEpisode(ctx.params.id);
        if (!ep) throw codedError(E.NOT_FOUND, 404, 'khong tim thay tap phim');
        if (ep.linkStatus === 'unlinked' || !ep.sourceRef) {
            throw codedError(E.SOURCE_UNAVAILABLE, 502, 'tap phim chua duoc lien ket voi nguon', { sourceCode: 'SOURCE_NOT_LINKED' });
        }
        var cacheKey = 'play:' + ep.id + ':' + ep.sourceRef;
        var cached = cacheGet(cacheKey);
        if (cached === null) {
            var resolved = sources.resolvePlayable(ep.sourceType, ep.sourceRef);
            if (!resolved.ok) {
                // Cập nhật trạng thái liên kết khi nguồn hỏng
                ep.linkStatus = 'broken';
                ep.accessStatus = 'unavailable';
                ep.updatedAt = config.now();
                await store.upsertEpisode(ep);
                log('warn', 'source resolve failed', { episodeId: ep.id, sourceCode: resolved.sourceCode });
                throw codedError(E.SOURCE_UNAVAILABLE, 502,
                    'nguon khong kha dung, thu lai sau', { sourceCode: resolved.sourceCode });
            }
            cached = resolved;
            cacheSet(cacheKey, resolved);
        }
        var m = await store.findMovie(ep.movieId);
        return {
            episodeId: ep.id,
            movieId: ep.movieId,
            title: ep.title,
            movie: m ? { id: m.id, title: m.title } : null,
            source: cached.source,
            playUrl: cached.playUrl,
            embedUrl: cached.embedUrl,
            access: cached.access,
            serverTime: new Date(config.now()).toISOString(),
        };
    }

    // ---- Handlers: admin ---------------------------------------------------
    async function handleAdminImport(ctx) {
        var body = ctx.body || {};
        var now = config.now();
        var summary = { categories: 0, movies: 0, episodes: 0, errors: [] };

        var cats = Array.isArray(body.categories) ? body.categories : [];
        for (var i = 0; i < cats.length; i++) {
            var c = cats[i] || {};
            var cname = String(c.name || '').trim();
            if (!cname) { summary.errors.push({ item: 'category#' + i, error: 'thieu ten danh muc' }); continue; }
            await store.upsertCategory({
                id: c.id || core.newId('cat_'),
                name: cname,
                slug: c.slug || core.slugify(cname) || core.newId('c'),
                position: Number(c.position) || 0,
            });
            summary.categories++;
        }

        var movies = Array.isArray(body.movies) ? body.movies : [];
        for (var j = 0; j < movies.length; j++) {
            var mv = movies[j] || {};
            var title = String(mv.title || '').trim();
            if (!title) { summary.errors.push({ item: 'movie#' + j, error: 'thieu ten phim' }); continue; }
            var movieId = mv.id || core.newId('mv_');
            var movie = {
                id: movieId,
                title: title,
                slug: mv.slug || core.slugify(title) || movieId,
                description: String(mv.description || ''),
                posterUrl: mv.posterUrl || null,
                categoryIds: Array.isArray(mv.categoryIds) ? mv.categoryIds : [],
                createdAt: now,
                updatedAt: now,
            };
            await store.upsertMovie(movie);
            summary.movies++;

            var eps = Array.isArray(mv.episodes) ? mv.episodes : [];
            for (var k = 0; k < eps.length; k++) {
                var ep = eps[k] || {};
                var epTitle = String(ep.title || ('Tap ' + (ep.epNumber || k + 1))).trim();
                var sourceType = String(ep.sourceType || 'facebook');
                var sourceRef = String(ep.sourceRef || '');
                var linkStatus = 'linked';
                var ref = null;
                try {
                    ref = sources.normalizeRef(sourceType, sourceRef);
                } catch (e) {
                    linkStatus = 'broken';
                    summary.errors.push({ item: 'movie#' + j + '/ep#' + k, error: e.message, sourceCode: e.sourceCode || 'SOURCE_INVALID_REF' });
                }
                await store.upsertEpisode({
                    id: ep.id || core.newId('ep_'),
                    movieId: movieId,
                    title: epTitle,
                    epNumber: Number(ep.epNumber) || (k + 1),
                    sourceType: sourceType,
                    sourceRef: ref ? ref.canonicalUrl : sourceRef,
                    linkStatus: sourceRef ? linkStatus : 'unlinked',
                    accessStatus: 'unknown',
                    accessCheckedAt: null,
                    createdAt: now,
                    updatedAt: now,
                });
                summary.episodes++;
            }
        }
        log('info', 'catalog import', { movies: summary.movies, episodes: summary.episodes, errors: summary.errors.length });
        return summary;
    }

    async function handleAdminCategory(ctx) {
        var b = ctx.body || {};
        var name = String(b.name || '').trim();
        if (!name) throw codedError(E.BAD_REQUEST, 400, 'thieu ten danh muc');
        return { category: await store.upsertCategory({
            id: b.id || core.newId('cat_'),
            name: name,
            slug: b.slug || core.slugify(name) || core.newId('c'),
            position: Number(b.position) || 0,
        }) };
    }

    async function handleAdminMovie(ctx) {
        var b = ctx.body || {};
        var title = String(b.title || '').trim();
        if (!title) throw codedError(E.BAD_REQUEST, 400, 'thieu ten phim');
        var now = config.now();
        var id = b.id || core.newId('mv_');
        var movie = await store.upsertMovie({
            id: id,
            title: title,
            slug: b.slug || core.slugify(title) || id,
            description: String(b.description || ''),
            posterUrl: b.posterUrl || null,
            categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds : [],
            createdAt: now,
            updatedAt: now,
        });
        return { movie: movie };
    }

    async function handleAdminEpisode(ctx) {
        var b = ctx.body || {};
        var movie = await store.findMovie(ctx.params.id);
        if (!movie) throw codedError(E.NOT_FOUND, 404, 'khong tim thay phim');
        var now = config.now();
        var sourceType = String(b.sourceType || 'facebook');
        var sourceRef = String(b.sourceRef || '');
        var linkStatus = sourceRef ? 'linked' : 'unlinked';
        if (sourceRef) sources.normalizeRef(sourceType, sourceRef); // ném lỗi nếu ref không hợp lệ
        var ep = await store.upsertEpisode({
            id: b.id || core.newId('ep_'),
            movieId: movie.id,
            title: String(b.title || '').trim() || 'Tap',
            epNumber: Number(b.epNumber) || 0,
            sourceType: sourceType,
            sourceRef: sourceRef,
            linkStatus: linkStatus,
            accessStatus: 'unknown',
            accessCheckedAt: null,
            createdAt: now,
            updatedAt: now,
        });
        return { episode: ep };
    }

    async function handleAdminLink(ctx) {
        var b = ctx.body || {};
        var ep = await store.findEpisode(ctx.params.id);
        if (!ep) throw codedError(E.NOT_FOUND, 404, 'khong tim thay tap phim');
        var sourceType = String(b.sourceType || ep.sourceType || 'facebook');
        var ref = sources.normalizeRef(sourceType, String(b.sourceRef || ''));
        ep.sourceType = sourceType;
        ep.sourceRef = ref.canonicalUrl;
        ep.linkStatus = 'linked';
        ep.accessStatus = 'unknown';
        ep.accessCheckedAt = null;
        ep.updatedAt = config.now();
        await store.upsertEpisode(ep);
        return { episode: ep };
    }

    // Xác minh trạng thái truy cập nguồn (cache — "cache dữ liệu nguồn")
    async function handleAdminSourceRefresh(ctx) {
        var movieId = ctx.body && ctx.body.movieId ? String(ctx.body.movieId) : null;
        var eps = movieId ? await store.listEpisodes(movieId) : [];
        if (!movieId) {
            // quét toàn bộ (đơn giản: theo từng phim)
            var movies = await store.listMovies({ page: 1, pageSize: 100 });
            for (var i = 0; i < movies.items.length; i++) {
                var list = await store.listEpisodes(movies.items[i].id);
                for (var j = 0; j < list.length; j++) eps.push(list[j]);
            }
        }
        var summary = { checked: 0, verified: 0, unavailable: 0, unlinked: 0 };
        for (var k = 0; k < eps.length; k++) {
            var ep = eps[k];
            if (!ep.sourceRef || ep.linkStatus === 'unlinked') { summary.unlinked++; continue; }
            summary.checked++;
            var r = await sources.verifyAccess(ep.sourceType, ep.sourceRef, { online: config.facebookVerifyOnline });
            if (r.ok && r.status === 'verified') {
                ep.accessStatus = 'verified';
                ep.linkStatus = 'linked';
                summary.verified++;
            } else if (r.status === 'unavailable') {
                ep.accessStatus = 'unavailable';
                ep.linkStatus = 'broken';
                summary.unavailable++;
            } else {
                ep.accessStatus = 'unknown';
            }
            ep.accessCheckedAt = config.now();
            ep.updatedAt = config.now();
            await store.upsertEpisode(ep);
            cacheDeleteSafe('play:' + ep.id + ':' + ep.sourceRef);
        }
        return summary;
    }
    function cacheDeleteSafe(key) { sourceCache.delete(key); }

    async function handleAdminStatus(ctx) {
        var stats = await store.stats();
        return {
            version: VERSION,
            uptimeSec: Math.floor(process.uptime()),
            serverTime: new Date(config.now()).toISOString(),
            store: { driver: config.storeDriver },
            vipList: vipList.state(),
            sourceCacheSize: sourceCache.size,
            historyEnabled: config.historyEnabled,
            data: stats,
        };
    }

    async function handleAdminAccounts(ctx) {
        var list = await store.listAccounts();
        return {
            items: list.map(function (a) {
                return {
                    id: a.id,
                    name: a.name,
                    type: a.type,
                    status: a.status,
                    deviceId: a.deviceId || null,
                    lastDeviceId: a.lastDeviceId || null,
                    createdAt: a.createdAt,
                    freeExpiresAt: a.freeExpiresAt || null,
                    historyConsent: a.historyConsent ? !!a.historyConsent.accepted : false,
                };
            }),
        };
    }

    async function handleAdminSessions(ctx) {
        var accountId = ctx.url.searchParams.get('account') || '';
        var list = await store.listSessions(accountId ? { accountId: accountId } : {});
        return {
            items: list.map(function (s) {
                return {
                    id: s.id,
                    accountId: s.accountId,
                    createdAt: s.createdAt,
                    expiresAt: s.expiresAt || null,
                    revokedAt: s.revokedAt || null,
                    lastSeenAt: s.lastSeenAt || null,
                    // KHÔNG bao giờ trả tokenHash/token
                };
            }),
        };
    }

    async function handleAdminSessionDelete(ctx) {
        var ok = await store.revokeSession(ctx.params.id, config.now());
        if (!ok) throw codedError(E.NOT_FOUND, 404, 'khong tim thay session');
        return { ok: true };
    }

    async function handleAdminAccountRevoke(ctx) {
        var acc = await store.getAccountById(ctx.params.id);
        if (!acc) throw codedError(E.NOT_FOUND, 404, 'khong tim thay tai khoan');
        acc.status = 'revoked';
        await store.saveAccount(acc);
        var n = await store.revokeSessionsByAccount(acc.id, config.now());
        return { ok: true, revokedSessions: n };
    }

    // ---- Bảng route --------------------------------------------------------
    var routes = [
        { method: 'GET', pattern: '/health', auth: 'none', handler: async function () {
            var ping = await store.ping().catch(function (e) { return { ok: false, error: e.message }; });
            return {
                ok: !!(ping && ping.ok),
                version: VERSION,
                store: { ok: !!(ping && ping.ok), driver: config.storeDriver, error: ping && ping.error || null },
                vipList: vipList.state(),
                serverTime: new Date(config.now()).toISOString(),
                uptimeSec: Math.floor(process.uptime()),
            };
        } },
        { method: 'POST', pattern: '/api/auth/register-free', auth: 'none', handler: handleRegisterFree },
        { method: 'POST', pattern: '/api/auth/restore', auth: 'none', handler: handleRestore },
        { method: 'POST', pattern: '/api/auth/login-vip', auth: 'none', handler: handleLoginVip },
        { method: 'GET', pattern: '/api/me', auth: 'user', handler: handleMe },
        { method: 'POST', pattern: '/api/auth/logout', auth: 'user', handler: handleLogout },
        { method: 'GET', pattern: '/api/history', auth: 'user', handler: handleHistoryGet },
        { method: 'POST', pattern: '/api/history', auth: 'user', handler: handleHistoryAdd },
        { method: 'DELETE', pattern: '/api/history', auth: 'user', handler: handleHistoryClear },
        { method: 'POST', pattern: '/api/history/consent', auth: 'user', handler: handleHistoryConsent },
        { method: 'GET', pattern: '/api/catalog/categories', auth: 'user', handler: handleCategories },
        { method: 'GET', pattern: '/api/catalog/movies', auth: 'user', handler: handleMovies },
        { method: 'GET', pattern: '/api/catalog/movies/:id', auth: 'user', handler: handleMovieDetail },
        { method: 'GET', pattern: '/api/catalog/movies/:id/episodes', auth: 'user', handler: handleMovieEpisodes },
        { method: 'GET', pattern: '/api/catalog/episodes/:id', auth: 'user', handler: handleEpisodeDetail },
        { method: 'GET', pattern: '/api/catalog/episodes/:id/play', auth: 'user', handler: handlePlay },
        { method: 'POST', pattern: '/api/admin/catalog/import', auth: 'admin', handler: handleAdminImport },
        { method: 'POST', pattern: '/api/admin/categories', auth: 'admin', handler: handleAdminCategory },
        { method: 'POST', pattern: '/api/admin/movies', auth: 'admin', handler: handleAdminMovie },
        { method: 'POST', pattern: '/api/admin/movies/:id/episodes', auth: 'admin', handler: handleAdminEpisode },
        { method: 'POST', pattern: '/api/admin/episodes/:id/link', auth: 'admin', handler: handleAdminLink },
        { method: 'POST', pattern: '/api/admin/source/refresh', auth: 'admin', handler: handleAdminSourceRefresh },
        { method: 'GET', pattern: '/api/admin/status', auth: 'admin', handler: handleAdminStatus },
        { method: 'GET', pattern: '/api/admin/accounts', auth: 'admin', handler: handleAdminAccounts },
        { method: 'GET', pattern: '/api/admin/sessions', auth: 'admin', handler: handleAdminSessions },
        { method: 'DELETE', pattern: '/api/admin/sessions/:id', auth: 'admin', handler: handleAdminSessionDelete },
        { method: 'POST', pattern: '/api/admin/accounts/:id/revoke', auth: 'admin', handler: handleAdminAccountRevoke },
    ].map(function (r) {
        r.parts = r.pattern.split('/').filter(Boolean);
        return r;
    });

    var server = http.createServer(async function (req, res) {
        var started = Date.now();
        var reqId = crypto.randomBytes(6).toString('hex');
        var url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch (e) {
            return fail(res, E.BAD_REQUEST, 400, 'URL khong hop le');
        }
        var ip = clientIp(req, config);
        res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');

        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Max-Age': '600' });
            return res.end();
        }

        var route = null;
        var params = null;
        for (var i = 0; i < routes.length; i++) {
            var m = matchRoute(routes[i], req.method, url.pathname);
            if (m) { route = routes[i]; params = m; break; }
        }
        if (!route) {
            // Path trùng route đã biết nhưng sai method → 405, ngược lại 404
            var pathKnown = routes.some(function (r) {
                return pathMatches(r.parts, url.pathname) !== null;
            });
            log('info', 'request', { reqId: reqId, method: req.method, path: url.pathname, status: pathKnown ? 405 : 404, ip: ip });
            return fail(res, pathKnown ? E.BAD_REQUEST : E.NOT_FOUND, pathKnown ? 405 : 404,
                pathKnown ? 'method khong ho tro' : 'khong tim thay endpoint');
        }

        try {
            var ctx = { req: req, res: res, url: url, params: params, body: {}, ip: ip, ua: String(req.headers['user-agent'] || '').slice(0, 200), now: config.now(), account: null, session: null };
            if (req.method === 'POST') {
                ctx.body = await readBody(req, config.maxBody);
            }
            if (route.auth === 'user') {
                var auth = await authenticate(req);
                ctx.account = auth.account;
                ctx.session = auth.session;
                ctx.now = auth.now;
            } else if (route.auth === 'admin') {
                requireAdmin(req);
            }
            var out = await route.handler(ctx);
            log('info', 'request', { reqId: reqId, method: req.method, path: url.pathname, status: 200, ms: Date.now() - started, ip: ip });
            return send(res, 200, out === undefined ? { ok: true } : out);
        } catch (e) {
            var status = e.httpStatus || 500;
            var code = e.code || E.INTERNAL;
            if (status >= 500) {
                log('error', 'request failed', { reqId: reqId, method: req.method, path: url.pathname, code: code, error: e.message, stack: (e.stack || '').split('\n')[1] || '' });
            } else {
                log('info', 'request', { reqId: reqId, method: req.method, path: url.pathname, status: status, code: code, ms: Date.now() - started, ip: ip });
            }
            if (status >= 500 && code === E.INTERNAL) {
                return fail(res, E.INTERNAL, 500, 'loi he thong');
            }
            var extra = {};
            if (e.retryAfterSec) extra.retryAfterSec = e.retryAfterSec;
            if (e.sourceCode) extra.sourceCode = e.sourceCode;
            return fail(res, code, status, e.message, Object.keys(extra).length ? extra : undefined);
        }
    });

    return { server: server, config: config, store: store, vipList: vipList, log: log, routes: routes };
}

// ---------------------------------------------------------------------------
// Khởi động (fail-closed: thiếu cấu hình/CSDL → không mở server)
// ---------------------------------------------------------------------------
async function startServer() {
    var config = loadConfig();
    var log = makeLogger();

    if (!config.adminToken) {
        log('warn', 'ADMIN_TOKEN chua duoc cau hinh — API admin se bi tat');
    }
    if (config.storeDriver === 'git') {
        var missing = [];
        if (!config.gitToken) missing.push('STORE_GIT_TOKEN');
        if (config.gitProvider === 'github' && (!config.gitOwner || !config.gitRepo)) missing.push('STORE_GIT_OWNER/STORE_GIT_REPO');
        if (config.gitProvider === 'gitlab' && !config.gitProjectId) missing.push('STORE_GIT_PROJECT_ID');
        if (missing.length) {
            log('error', 'thieu cau hinh store git', { missing: missing.join(', ') });
            process.exitCode = 1;
            return null;
        }
    }
    if (config.storeDriver === 'postgres' && !config.databaseUrl) {
        log('error', 'thieu DATABASE_URL cho driver postgres');
        process.exitCode = 1;
        return null;
    }

    var store;
    try {
        store = await storeLib.createStore(config);
    } catch (e) {
        log('error', 'khong khoi tao duoc CSDL — dung server (fail-closed)', { error: e.message });
        process.exitCode = 1;
        return null;
    }

    var app = createApp({ config: config, store: store, log: log });
    var ok = await app.vipList.refresh();
    if (!ok) {
        log('warn', 'chua nap duoc danh sach VIP — se tu choi cap quyen moi cho toi khi nap duoc');
    }

    app.server.listen(config.port, config.host, function () {
        log('info', 'Bin Media server dang lang nghe', { host: config.host, port: config.port, store: config.storeDriver, version: VERSION });
    });
    return app;
}

if (require.main === module) startServer();

module.exports = {
    createApp: createApp,
    loadConfig: loadConfig,
    startServer: startServer,
    createVipList: createVipList,
    VERSION: VERSION,
};
