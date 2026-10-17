'use strict';
// E2E: toàn bộ luồng Free/VIP/session/khóa/catalog theo đặc tả Bin Media.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const serverLib = require('../server');
const storeLib = require('../lib/store');

var ADMIN = 'test-admin-token';

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimedia-e2e-')), 'db.json');
}

async function startApp(opts) {
    opts = opts || {};
    var fakeNow = opts.now || Date.now();
    var config = serverLib.loadConfig(process.env, {
        storeDriver: 'json',
        dataFile: opts.dataFile || tmpFile(),
        vipSource: 'static',
        vipListStatic: JSON.stringify(opts.vipNames || ['vip_one', 'vip_two']),
        adminToken: ADMIN,
        trustProxy: false,
        now: function () { return fakeNow; },
    });
    var store = await storeLib.createStore(config);
    var app = serverLib.createApp({ config: config, store: store });
    await app.vipList.refresh();
    await new Promise(function (r) { app.server.listen(0, '127.0.0.1', r); });
    var url = 'http://127.0.0.1:' + app.server.address().port;
    return {
        url: url,
        config: config,
        dataFile: config.dataFile,
        advance: function (ms) { fakeNow += ms; },
        setNow: function (t) { fakeNow = t; },
        now: function () { return fakeNow; },
        close: async function () {
            await new Promise(function (r) { app.server.close(r); });
            await store.close();
        },
    };
}

async function api(t, method, p, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    if (opts.admin) headers['Authorization'] = 'Bearer ' + ADMIN;
    if (opts.rawAdminToken !== undefined) headers['Authorization'] = 'Bearer ' + opts.rawAdminToken;
    var res = await fetch(t.url + p, {
        method: method,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var json = null;
    try { json = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, json: json };
}

var DEV_A = 'Aaaa1111Bbbb2222Cccc';
var DEV_B = 'Dddd3333Eeee4444Ffff';

// ---------------------------------------------------------------------------
// Đăng ký Free
// ---------------------------------------------------------------------------
test('register-free: thành công, 48 giờ, session hoạt động', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Khach Hang Mot', deviceId: DEV_A } });
        assert.strictEqual(r.status, 200);
        assert.ok(r.json.token, 'phải trả session token');
        assert.strictEqual(r.json.account.type, 'free');
        assert.strictEqual(r.json.account.freeValid, true);
        assert.strictEqual(r.json.account.remainingFreeSec, 48 * 3600);
        assert.ok(r.json.history.notice, 'phải có thông báo lịch sử xem');

        var me = await api(t, 'GET', '/api/me', { token: r.json.token });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json.account.name, 'Khach Hang Mot');
    } finally { await t.close(); }
});

test('register-free: token chỉ lưu HASH trong dữ liệu', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Khach Hai', deviceId: DEV_A } });
        var text = fs.readFileSync(t.dataFile, 'utf8');
        assert.ok(!text.includes(r.json.token), 'token thô không được nằm trong CSDL');
    } finally { await t.close(); }
});

test('register-free: chống trùng thiết bị và trùng tên', async function () {
    var t = await startApp();
    try {
        var r1 = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Mot', deviceId: DEV_A } });
        assert.strictEqual(r1.status, 200);

        var r2 = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Hai', deviceId: DEV_A } });
        assert.strictEqual(r2.status, 409);
        assert.strictEqual(r2.json.error.code, 'DEVICE_REGISTERED');

        var r3 = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Mot', deviceId: DEV_B } });
        assert.strictEqual(r3.status, 409);
        assert.strictEqual(r3.json.error.code, 'NAME_TAKEN');
    } finally { await t.close(); }
});

test('register-free: đồng thời nhiều request → chỉ 1 thành công (nguyên tử)', async function () {
    var t = await startApp();
    try {
        var rs = await Promise.all([1, 2, 3, 4].map(function (i) {
            return api(t, 'POST', '/api/auth/register-free', { body: { name: 'Ten ' + i, deviceId: DEV_A } });
        }));
        var ok = rs.filter(function (x) { return x.status === 200; });
        var dup = rs.filter(function (x) { return x.status === 409 && x.json.error.code === 'DEVICE_REGISTERED'; });
        assert.strictEqual(ok.length, 1);
        assert.strictEqual(dup.length, 3);
    } finally { await t.close(); }
});

test('register-free: không nhận tên nằm trong danh sách VIP (không hé lộ danh sách)', async function () {
    var t = await startApp({ vipNames: ['vip_one'] });
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.error.code, 'NAME_TAKEN');
        assert.ok(!JSON.stringify(r.json).includes('vip_two'), 'không lộ tên VIP khác');
    } finally { await t.close(); }
});

test('register-free: tên/thiết bị không hợp lệ → 400', async function () {
    var t = await startApp();
    try {
        var r1 = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'x', deviceId: DEV_A } });
        assert.strictEqual(r1.status, 400);
        assert.strictEqual(r1.json.error.code, 'NAME_INVALID');
        var r2 = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Ten Hop Le', deviceId: 'ngan' } });
        assert.strictEqual(r2.status, 400);
        assert.strictEqual(r2.json.error.code, 'DEVICE_INVALID');
    } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// Thời hạn Free 48 giờ — SERVER là nguồn sự thật
// ---------------------------------------------------------------------------
test('free hết hạn sau 48h: /api/me trả FREE_EXPIRED, restore cũng vậy', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Han Ngan', deviceId: DEV_A } });
        assert.strictEqual(r.status, 200);

        t.advance(47 * 3600 * 1000); // còn 1 giờ
        var me1 = await api(t, 'GET', '/api/me', { token: r.json.token });
        assert.strictEqual(me1.status, 200);

        t.advance(2 * 3600 * 1000); // vượt mốc 48 giờ
        var me2 = await api(t, 'GET', '/api/me', { token: r.json.token });
        assert.strictEqual(me2.status, 403);
        assert.strictEqual(me2.json.error.code, 'FREE_EXPIRED');

        var restore = await api(t, 'POST', '/api/auth/restore', { body: { deviceId: DEV_A } });
        assert.strictEqual(restore.status, 403);
        assert.strictEqual(restore.json.error.code, 'FREE_EXPIRED');
    } finally { await t.close(); }
});

test('restore: thiết bị đã đăng ký lấy lại session khi còn hạn', async function () {
    var t = await startApp();
    try {
        await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Khoi Phuc', deviceId: DEV_A } });
        var r = await api(t, 'POST', '/api/auth/restore', { body: { deviceId: DEV_A } });
        assert.strictEqual(r.status, 200);
        assert.ok(r.json.token);
        assert.strictEqual(r.json.account.name, 'Khoi Phuc');

        var unknown = await api(t, 'POST', '/api/auth/restore', { body: { deviceId: DEV_B } });
        assert.strictEqual(unknown.status, 404);
        assert.strictEqual(unknown.json.error.code, 'NO_ACCOUNT');
    } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// Đăng nhập VIP qua danh sách GitLab (static trong test)
// ---------------------------------------------------------------------------
test('login-vip: đúng tên → session VIP, sai tên → VIP_INVALID', async function () {
    var t = await startApp({ vipNames: ['vip_one'] });
    try {
        var bad = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'khong_ton_tai' } });
        assert.strictEqual(bad.status, 401);
        assert.strictEqual(bad.json.error.code, 'VIP_INVALID');

        var ok = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json.account.type, 'vip');
        assert.strictEqual(ok.json.account.freeExpiresAt, null, 'VIP không giới hạn thời gian');

        var me = await api(t, 'GET', '/api/me', { token: ok.json.token });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json.account.type, 'vip');
    } finally { await t.close(); }
});

test('login-vip: 5 lần sai liên tiếp → 429 AUTH_LOCKED 300 giây, đúng tên vẫn bị chặn', async function () {
    var t = await startApp({ vipNames: ['vip_one'] });
    try {
        for (var i = 0; i < 5; i++) {
            var r = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'sai_' + i, deviceId: DEV_A } });
            assert.strictEqual(r.status, 401);
        }
        var locked = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(locked.status, 429);
        assert.strictEqual(locked.json.error.code, 'AUTH_LOCKED');
        assert.strictEqual(locked.json.error.retryAfterSec, 300);
        assert.ok(!JSON.stringify(locked.json).includes('vip_one'), 'không hé lộ tên VIP');

        // Trong thời gian khóa: kể cả tên đúng cũng không cấp quyền mới
        t.advance(299 * 1000);
        var still = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(still.status, 429);

        // Sau 300 giây → cho phép thử lại theo chính sách
        t.advance(2 * 1000);
        var ok = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(ok.status, 200);
    } finally { await t.close(); }
});

test('login-vip: khóa KHÔNG bị xóa bằng cách khởi động lại server', async function () {
    var t = await startApp({ vipNames: ['vip_one'] });
    var dataFile = t.dataFile;
    try {
        for (var i = 0; i < 5; i++) {
            await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'sai_' + i, deviceId: DEV_A } });
        }
        var before = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(before.status, 429);
    } finally { await t.close(); }

    // "Khởi động lại server" — instance mới, cùng file dữ liệu
    var t2 = await startApp({ vipNames: ['vip_one'], dataFile: dataFile });
    try {
        var after = await api(t2, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        assert.strictEqual(after.status, 429, 'khóa phải sống qua restart');
        assert.strictEqual(after.json.error.code, 'AUTH_LOCKED');
    } finally { await t2.close(); }
});

test('login-vip: lỗi không bao giờ trả danh sách tên VIP', async function () {
    var t = await startApp({ vipNames: ['vip_one', 'vip_two'] });
    try {
        var r = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'sai_ten' } });
        var text = JSON.stringify(r.json);
        assert.ok(!text.includes('vip_one') && !text.includes('vip_two'));
    } finally { await t.close(); }
});

test('VIP bị gỡ khỏi danh sách → session không còn quyền (VIP_INACTIVE)', async function () {
    var t = await startApp({ vipNames: ['vip_one'] });
    var dataFile = t.dataFile;
    var token;
    try {
        var r = await api(t, 'POST', '/api/auth/login-vip', { body: { name: 'vip_one', deviceId: DEV_A } });
        token = r.json.token;
    } finally { await t.close(); }

    var t2 = await startApp({ vipNames: [], dataFile: dataFile });
    try {
        var me = await api(t2, 'GET', '/api/me', { token: token });
        assert.strictEqual(me.status, 403);
        assert.strictEqual(me.json.error.code, 'VIP_INACTIVE');
    } finally { await t2.close(); }
});

// ---------------------------------------------------------------------------
// Session: thu hồi, đăng xuất
// ---------------------------------------------------------------------------
test('session: đăng xuất → session bị thu hồi, không dùng lại được', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Dang Xuat', deviceId: DEV_A } });
        var token = r.json.token;
        var out = await api(t, 'POST', '/api/auth/logout', { token: token });
        assert.strictEqual(out.status, 200);
        var me = await api(t, 'GET', '/api/me', { token: token });
        assert.strictEqual(me.status, 401);
        assert.strictEqual(me.json.error.code, 'SESSION_REVOKED');
    } finally { await t.close(); }
});

test('session: admin thu hồi → 401 SESSION_REVOKED; không có token → SESSION_REQUIRED', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Bi Thu Hoi', deviceId: DEV_A } });
        var sid = r.json.session.id;

        var noAuth = await api(t, 'GET', '/api/me');
        assert.strictEqual(noAuth.status, 401);
        assert.strictEqual(noAuth.json.error.code, 'SESSION_REQUIRED');

        var del = await api(t, 'DELETE', '/api/admin/sessions/' + sid, { admin: true });
        assert.strictEqual(del.status, 200);

        var me = await api(t, 'GET', '/api/me', { token: r.json.token });
        assert.strictEqual(me.status, 401);
        assert.strictEqual(me.json.error.code, 'SESSION_REVOKED');
    } finally { await t.close(); }
});

test('admin: sai token → 403, thiếu cấu hình token không lộ nội dung', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'GET', '/api/admin/status', { rawAdminToken: 'sai-token' });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.error.code, 'ADMIN_FORBIDDEN');
    } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// Lịch sử xem: thông báo + đồng ý trước khi ghi
// ---------------------------------------------------------------------------
test('lịch sử xem: bắt buộc đồng ý sau khi được thông báo', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Lich Su', deviceId: DEV_A } });
        var token = r.json.token;

        // Thông báo phải được trả về kèm session
        assert.ok(r.json.history.notice.includes('lịch sử xem'));

        // Chưa đồng ý → không lưu được
        var add = await api(t, 'POST', '/api/history', { token: token, body: { movieId: 'mv1', episodeId: 'ep1', positionSec: 30 } });
        assert.strictEqual(add.status, 403);
        assert.strictEqual(add.json.error.code, 'HISTORY_CONSENT_REQUIRED');

        // Đồng ý → lưu được
        var consent = await api(t, 'POST', '/api/history/consent', { token: token, body: { accepted: true } });
        assert.strictEqual(consent.status, 200);
        var add2 = await api(t, 'POST', '/api/history', { token: token, body: { movieId: 'mv1', episodeId: 'ep1', positionSec: 30 } });
        assert.strictEqual(add2.status, 200);

        var list = await api(t, 'GET', '/api/history', { token: token });
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.json.items.length, 1);

        // Xóa lịch sử
        var clear = await api(t, 'DELETE', '/api/history', { token: token });
        assert.strictEqual(clear.status, 200);
        var list2 = await api(t, 'GET', '/api/history', { token: token });
        assert.strictEqual(list2.json.items.length, 0);
    } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// Catalog + nguồn Facebook
// ---------------------------------------------------------------------------
test('catalog: import metadata, tìm kiếm, phát qua module nguồn', async function () {
    var t = await startApp();
    try {
        var reg = await api(t, 'POST', '/api/auth/register-free', { body: { name: 'Khach Xem', deviceId: DEV_A } });
        var token = reg.json.token;

        var imp = await api(t, 'POST', '/api/admin/catalog/import', {
            admin: true,
            body: {
                categories: [{ id: 'cat1', name: 'Hành Động', position: 1 }],
                movies: [{
                    id: 'mv1',
                    title: 'Phim Thử Nghiệm',
                    categoryIds: ['cat1'],
                    episodes: [
                        { id: 'ep1', title: 'Tập 1', epNumber: 1, sourceType: 'facebook', sourceRef: 'https://www.facebook.com/watch/?v=123456789012345' },
                        { id: 'ep2', title: 'Tập 2', epNumber: 2, sourceType: 'facebook', sourceRef: 'https://example.com/khong-phai-fb' },
                    ],
                }],
            },
        });
        assert.strictEqual(imp.status, 200);
        assert.strictEqual(imp.json.movies, 1);
        assert.strictEqual(imp.json.episodes, 2);
        assert.strictEqual(imp.json.errors.length, 1, 'ref lỗi phải được ghi nhận');

        var cats = await api(t, 'GET', '/api/catalog/categories', { token: token });
        assert.strictEqual(cats.json.items.length, 1);

        var movies = await api(t, 'GET', '/api/catalog/movies?q=' + encodeURIComponent('thử nghiệm'), { token: token });
        assert.strictEqual(movies.json.total, 1);
        assert.strictEqual(movies.json.items[0].linkStatus, 'broken', 'có tập lỗi liên kết → phim báo broken');

        var play = await api(t, 'GET', '/api/catalog/episodes/ep1/play', { token: token });
        assert.strictEqual(play.status, 200);
        assert.strictEqual(play.json.source, 'facebook');
        assert.ok(play.json.embedUrl.startsWith('https://www.facebook.com/plugins/video.php?href='));
        assert.ok(play.json.playUrl.includes('facebook.com'));

        // Tập liên kết URL không hợp lệ → lỗi nguồn nhất quán
        var play2 = await api(t, 'GET', '/api/catalog/episodes/ep2/play', { token: token });
        assert.strictEqual(play2.status, 502);
        assert.strictEqual(play2.json.error.code, 'SOURCE_UNAVAILABLE');
    } finally { await t.close(); }
});

test('catalog: cần session để xem nội dung', async function () {
    var t = await startApp();
    try {
        var r = await api(t, 'GET', '/api/catalog/movies');
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json.error.code, 'SESSION_REQUIRED');
    } finally { await t.close(); }
});

test('admin: link tập phim với nguồn Facebook hợp lệ', async function () {
    var t = await startApp();
    try {
        await api(t, 'POST', '/api/admin/catalog/import', {
            admin: true,
            body: { movies: [{ id: 'mv9', title: 'Phim Chín', episodes: [] }] },
        });
        var ep = await api(t, 'POST', '/api/admin/movies/mv9/episodes', {
            admin: true,
            body: { title: 'Tập đặc biệt', epNumber: 0, sourceType: 'facebook', sourceRef: '' },
        });
        assert.strictEqual(ep.status, 200);
        assert.strictEqual(ep.json.episode.linkStatus, 'unlinked');

        var link = await api(t, 'POST', '/api/admin/episodes/' + ep.json.episode.id + '/link', {
            admin: true,
            body: { sourceType: 'facebook', sourceRef: 'https://www.facebook.com/somepage/videos/555666777888999/' },
        });
        assert.strictEqual(link.status, 200);
        assert.strictEqual(link.json.episode.linkStatus, 'linked');
        assert.strictEqual(link.json.episode.sourceRef, 'https://www.facebook.com/somepage/videos/555666777888999');
    } finally { await t.close(); }
});

test('admin: từ chối link ref không phải nội dung Facebook công khai', async function () {
    var t = await startApp();
    try {
        await api(t, 'POST', '/api/admin/catalog/import', { admin: true, body: { movies: [{ id: 'mv8', title: 'Phim Tám', episodes: [] }] } });
        var ep = await api(t, 'POST', '/api/admin/movies/mv8/episodes', { admin: true, body: { title: 'T1', epNumber: 1 } });
        var link = await api(t, 'POST', '/api/admin/episodes/' + ep.json.episode.id + '/link', {
            admin: true,
            body: { sourceType: 'facebook', sourceRef: 'https://www.facebook.com/groups/1/posts/2' },
        });
        assert.strictEqual(link.status, 502);
        assert.strictEqual(link.json.error.code, 'SOURCE_UNAVAILABLE');
    } finally { await t.close(); }
});

test('/health và /api/admin/status: giám sát hệ thống', async function () {
    var t = await startApp();
    try {
        var h = await api(t, 'GET', '/health');
        assert.strictEqual(h.status, 200);
        assert.strictEqual(h.json.ok, true);
        assert.ok(h.json.store.ok);
        assert.ok(h.json.vipList.count >= 1);

        var s = await api(t, 'GET', '/api/admin/status', { admin: true });
        assert.strictEqual(s.status, 200);
        assert.strictEqual(s.json.version, serverLib.VERSION);
        assert.ok(s.json.data);
    } finally { await t.close(); }
});
