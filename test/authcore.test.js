'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../lib/authcore');

test('normalizeName: hợp lệ, trim, gộp khoảng trắng', function () {
    assert.strictEqual(core.normalizeName('  Nguyen  Van A '), 'Nguyen Van A');
    assert.strictEqual(core.normalizeName('phimhay01'), 'phimhay01');
    assert.strictEqual(core.normalizeName('Tên Tiếng Việt'), 'Tên Tiếng Việt');
});

test('normalizeName: từ chối tên không hợp lệ', function () {
    assert.strictEqual(core.normalizeName(''), null);
    assert.strictEqual(core.normalizeName('a'), null);            // quá ngắn
    assert.strictEqual(core.normalizeName('x'.repeat(41)), null); // quá dài
    assert.strictEqual(core.normalizeName('ten<script>'), null);
    assert.strictEqual(core.normalizeName('ten@hack'), null);
    assert.strictEqual(core.normalizeName(123), null);
});

test('nameKey: không phân biệt hoa/thường', function () {
    assert.strictEqual(core.nameKey('VipOne'), core.nameKey('vipone'));
});

test('deviceId: chỉ chấp nhận mã ngẫu nhiên đủ dài', function () {
    assert.ok(core.isValidDeviceId('a'.repeat(16)));
    assert.ok(core.isValidDeviceId('Abc_123-def-XYZ_abc123'));
    assert.ok(!core.isValidDeviceId('short'));
    assert.ok(!core.isValidDeviceId('device with spaces'));
    assert.ok(!core.isValidDeviceId('invalid!chars!!!!!!!!'));
});

test('slugify: bỏ dấu tiếng Việt', function () {
    assert.strictEqual(core.slugify('Phim Đẫm Máu 2'), 'phim-dam-mau-2');
    assert.strictEqual(core.slugify('  Tiếng Sét Ái Tình '), 'tieng-set-ai-tinh');
});

test('token: sinh ngẫu nhiên, hash SHA-256 64 hex', function () {
    var t1 = core.newSessionToken();
    var t2 = core.newSessionToken();
    assert.notStrictEqual(t1, t2);
    var h = core.hashToken(t1);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(h, t1); // không lưu token thô
    assert.strictEqual(h, core.hashToken(t1));
});

test('gate fail: 5 lần sai liên tiếp → khóa 300 giây', function () {
    var now = 1000000;
    var g = core.newGate();
    var policy = { failLimit: 5, lockMs: 300000 };
    for (var i = 0; i < 4; i++) {
        var r = core.gateFail(g, now + i, policy);
        assert.strictEqual(r, null, 'chưa được khóa ở lần ' + (i + 1));
    }
    var r5 = core.gateFail(g, now + 4, policy);
    assert.ok(r5, 'lần sai thứ 5 phải khóa');
    assert.strictEqual(r5.retryAfterSec, 300);
    var locked = core.gateLocked(g, now + 5, policy);
    assert.ok(locked, 'đang trong thời gian khóa');
    assert.strictEqual(locked.retryAfterSec, 300);

    // Hết 300 giây (tính từ lúc khóa) → cho phép thử lại, bộ đếm reset
    assert.strictEqual(core.gateLocked(g, now + 4 + 300000, policy), null);
    assert.strictEqual(g.fails, 0);
});

test('gate fail: thành công reset bộ đếm (5 lần sai LIÊN TIẾP)', function () {
    var now = 2000000;
    var g = core.newGate();
    var policy = { failLimit: 5, lockMs: 300000 };
    for (var i = 0; i < 3; i++) core.gateFail(g, now + i, policy);
    core.gateSuccess(g);
    for (var j = 0; j < 3; j++) {
        assert.strictEqual(core.gateFail(g, now + 100 + j, policy), null);
    }
    assert.strictEqual(g.fails, 3);
});

test('gate rate: vượt quá số lần trong cửa sổ → khóa', function () {
    var now = 3000000;
    var g = core.newGate();
    var policy = { max: 3, windowMs: 60000, lockMs: 10000 };
    assert.strictEqual(core.gateHit(g, now, policy), null);
    assert.strictEqual(core.gateHit(g, now + 1, policy), null);
    assert.strictEqual(core.gateHit(g, now + 2, policy), null);
    var r = core.gateHit(g, now + 3, policy);
    assert.ok(r);
    assert.strictEqual(r.retryAfterSec, 10);
});

test('timingSafeEqualStr', function () {
    assert.ok(core.timingSafeEqualStr('abc', 'abc'));
    assert.ok(!core.timingSafeEqualStr('abc', 'abd'));
    assert.ok(!core.timingSafeEqualStr('abc', 'abcd'));
});
