'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storeLib = require('../lib/store');
const core = require('../lib/authcore');

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bimedia-')), 'db.json');
}

test('registerFree: 1 thiết bị = 1 tài khoản Free, tên là duy nhất', async function () {
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: tmpFile() });
    var now = Date.now();
    var acc = await store.registerFree({ accountId: 'a1', name: 'Ten Mot', nameKey: 'ten mot', deviceId: 'd'.repeat(16), now: now, freeExpiresAt: now + 1000 });
    assert.strictEqual(acc.type, 'free');

    await assert.rejects(
        store.registerFree({ accountId: 'a2', name: 'Ten Hai', nameKey: 'ten hai', deviceId: 'd'.repeat(16), now: now, freeExpiresAt: now + 1000 }),
        function (e) { return e.code === core.E.DEVICE_REGISTERED; },
        'đăng ký lần 2 với cùng thiết bị phải bị chặn'
    );
    await assert.rejects(
        store.registerFree({ accountId: 'a3', name: 'Ten Mot', nameKey: 'ten mot', deviceId: 'e'.repeat(16), now: now, freeExpiresAt: now + 1000 }),
        function (e) { return e.code === core.E.NAME_TAKEN; },
        'trùng tên phải bị chặn'
    );
});

test('registerFree: đồng thời nhiều request → chỉ 1 thành công (nguyên tử)', async function () {
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: tmpFile() });
    var now = Date.now();
    var deviceId = 'f'.repeat(16);
    var attempts = [1, 2, 3, 4, 5].map(function (i) {
        return store.registerFree({ accountId: 'a' + i, name: 'Ten ' + i, nameKey: 'ten ' + i, deviceId: deviceId, now: now, freeExpiresAt: now + 1000 })
            .then(function () { return 'ok'; })
            .catch(function (e) { return e.code; });
    });
    var results = await Promise.all(attempts);
    assert.strictEqual(results.filter(function (r) { return r === 'ok'; }).length, 1);
    assert.strictEqual(results.filter(function (r) { return r === core.E.DEVICE_REGISTERED; }).length, 4);
});

test('session: chỉ lưu hash, không lưu token thô', async function () {
    var file = tmpFile();
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: file });
    var token = core.newSessionToken();
    await store.createSession({
        id: 'ses_1', tokenHash: core.hashToken(token), accountId: 'a1',
        createdAt: Date.now(), expiresAt: null, revokedAt: null, lastSeenAt: null, ip: null, ua: null,
    });
    var text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(token), 'token thô không được nằm trong dữ liệu');
    assert.ok(text.includes(core.hashToken(token)), 'hash phải được lưu');
    var found = await store.findSessionByTokenHash(core.hashToken(token));
    assert.strictEqual(found.id, 'ses_1');
    assert.strictEqual(await store.findSessionByTokenHash('khong-co'), null);
});

test('loginAttempts: sống qua "restart" (không xóa khóa bằng cách khởi động lại)', async function () {
    var file = tmpFile();
    var s1 = await storeLib.createStore({ storeDriver: 'json', dataFile: file });
    var g = core.newGate();
    core.gateFail(g, Date.now(), { failLimit: 5, lockMs: 300000 });
    core.gateFail(g, Date.now(), { failLimit: 5, lockMs: 300000 });
    core.gateFail(g, Date.now(), { failLimit: 5, lockMs: 300000 });
    core.gateFail(g, Date.now(), { failLimit: 5, lockMs: 300000 });
    core.gateFail(g, Date.now(), { failLimit: 5, lockMs: 300000 }); // → khóa
    await s1.saveAttempt('vipfail:ip:1.2.3.4', g);

    // "khởi động lại server": store mới trên cùng file
    var s2 = await storeLib.createStore({ storeDriver: 'json', dataFile: file });
    var g2 = await s2.getAttempt('vipfail:ip:1.2.3.4');
    assert.strictEqual(g2.fails, 5);
    assert.ok(g2.lockedUntil > Date.now(), 'khóa còn hiệu lực sau restart');
});

test('revokeSession & revokeSessionsByAccount', async function () {
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: tmpFile() });
    var now = Date.now();
    await store.createSession({ id: 's1', tokenHash: 'h1', accountId: 'acc', createdAt: now, expiresAt: null, revokedAt: null, lastSeenAt: null });
    await store.createSession({ id: 's2', tokenHash: 'h2', accountId: 'acc', createdAt: now, expiresAt: null, revokedAt: null, lastSeenAt: null });
    assert.ok(await store.revokeSession('s1', now));
    assert.ok((await store.getSession('s1')).revokedAt);
    var n = await store.revokeSessionsByAccount('acc', now);
    assert.strictEqual(n, 1); // s2 — s1 đã thu hồi rồi
    assert.ok((await store.getSession('s2')).revokedAt);
});

test('watch history: upsert theo tập, xóa theo tài khoản', async function () {
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: tmpFile() });
    await store.putHistory({ accountId: 'acc', movieId: 'mv', episodeId: 'ep1', positionSec: 10, updatedAt: 1 });
    await store.putHistory({ accountId: 'acc', movieId: 'mv', episodeId: 'ep1', positionSec: 99, updatedAt: 2 });
    var items = await store.listHistory('acc');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].positionSec, 99);
    await store.clearHistory('acc');
    assert.strictEqual((await store.listHistory('acc')).length, 0);
});

test('catalog: tìm phim theo slug hoặc id, lọc theo danh mục', async function () {
    var store = await storeLib.createStore({ storeDriver: 'json', dataFile: tmpFile() });
    await store.upsertMovie({ id: 'mv1', title: 'Phim Hay', slug: 'phim-hay', categoryIds: ['c1'], createdAt: 1, updatedAt: 1 });
    await store.upsertMovie({ id: 'mv2', title: 'Phim Kac', slug: 'phim-kac', categoryIds: ['c2'], createdAt: 1, updatedAt: 1 });
    assert.strictEqual((await store.findMovie('mv1')).title, 'Phim Hay');
    assert.strictEqual((await store.findMovie('phim-hay')).id, 'mv1');
    var out = await store.listMovies({ categoryId: 'c1' });
    assert.strictEqual(out.total, 1);
    var q = await store.listMovies({ q: 'hay' });
    assert.strictEqual(q.total, 1);
});
