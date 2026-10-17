'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fb = require('../sources/facebook');
const sources = require('../sources');

test('facebook.normalizeRef: chấp nhận URL video công khai', function () {
    var r1 = fb.normalizeRef('https://www.facebook.com/watch/?v=123456789012345');
    assert.strictEqual(r1.videoId, '123456789012345');
    var r2 = fb.normalizeRef('https://www.facebook.com/somepage/videos/123456789012345/');
    assert.strictEqual(r2.videoId, '123456789012345');
    var r3 = fb.normalizeRef('https://fb.watch/abc123_XYZ/');
    assert.strictEqual(r3.code, 'abc123_XYZ');
});

test('facebook.normalizeRef: từ chối URL không phải video công khai', function () {
    var bad = [
        '',
        'javascript:alert(1)',
        'https://example.com/video/123',
        'https://www.facebook.com/groups/123456/posts/789',     // bài viết nhóm — không phải video whitelist
        'https://www.facebook.com/login?next=/videos/123456',   // không vượt login wall
        'https://www.facebook.com/me',                          // trang cá nhân
        'x'.repeat(600),
    ];
    for (var i = 0; i < bad.length; i++) {
        assert.throws(function () { fb.normalizeRef(bad[i]); }, function (e) {
            return e.code === 'SOURCE_UNAVAILABLE' && e.sourceCode === 'SOURCE_INVALID_REF';
        }, 'phải từ chối: ' + bad[i]);
    }
});

test('facebook.resolvePlayable: trả URL nhúng plugin chính thức', function () {
    var r = fb.resolvePlayable('https://www.facebook.com/watch/?v=123456789012345');
    assert.ok(r.ok);
    assert.strictEqual(r.source, 'facebook');
    assert.strictEqual(r.playUrl, 'https://www.facebook.com/watch/?v=123456789012345');
    assert.ok(r.embedUrl.startsWith('https://www.facebook.com/plugins/video.php?href='));
    assert.ok(r.embedUrl.includes(encodeURIComponent('https://www.facebook.com/watch/?v=123456789012345')));
});

test('facebook.resolvePlayable: ref lỗi → ok:false với code nhất quán', function () {
    var r = fb.resolvePlayable('https://example.com/not-fb');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SOURCE_UNAVAILABLE');
    assert.strictEqual(r.sourceCode, 'SOURCE_INVALID_REF');
});

test('facebook.verifyAccess: offline → unknown, ref lỗi → unavailable', async function () {
    var off = await fb.verifyAccess('https://www.facebook.com/watch/?v=123456789012345', { online: false });
    assert.deepStrictEqual({ ok: off.ok, status: off.status }, { ok: true, status: 'unknown' });
    var bad = await fb.verifyAccess('https://example.com/x', { online: true });
    assert.deepStrictEqual({ ok: bad.ok, status: bad.status }, { ok: false, status: 'unavailable' });
});

test('registry: nguồn không tồn tại → SOURCE_UNKNOWN', function () {
    var r = sources.resolvePlayable('tiktok', 'https://tiktok.com/x');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SOURCE_UNKNOWN');
    assert.throws(function () { sources.normalizeRef('tiktok', 'x'); }, function (e) {
        return e.code === 'SOURCE_UNKNOWN';
    });
});
