'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createVipList, loadConfig } = require('../server');
const silent = () => {};

test('VIP source boot failure recovers on demand; TTL refresh single-flight; malformed/empty input never grants', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-vip-'));
    let now = 0;
    const file = path.join(dir, 'list.txt');
    const config = loadConfig({}, { vipSource: 'file', vipListFile: file, vipListTtlMs: 100, now: () => now });
    const list = createVipList(config, silent);
    const original = fs.promises.readFile;
    let reads = 0;
    fs.promises.readFile = async function (...args) { reads++; return original.apply(this, args); };
    try {
        assert.equal(await list.refresh(), false);
        assert.equal(list.state().error, 'VIP_SOURCE_UNAVAILABLE');
        assert.ok(!JSON.stringify(list.state()).includes(dir));
        await fs.promises.writeFile(file, '["Example VIP"]');
        assert.equal((await list.check('example vip')).known, false, 'retry throttled');
        now = 100;
        const recovered = await Promise.all(Array.from({ length: 20 }, () => list.check('example vip')));
        assert.ok(recovered.every(r => r.member));
        assert.equal(reads, 2, 'one initial failure and one concurrent refresh');
        await fs.promises.writeFile(file, '["Other VIP"]');
        now = 199;
        assert.equal((await list.check('example vip')).member, true);
        now = 200;
        assert.equal((await list.check('example vip')).member, false);
        assert.equal(reads, 3);
        await fs.promises.unlink(file);
        now = 300;
        assert.equal((await list.check('other vip')).known, false, 'no stale authorization');
        now = 1000000;
        assert.equal((await list.check('other vip')).known, false);
        await fs.promises.writeFile(file, '["Other VIP", {}]');
        now += 100;
        assert.equal((await list.check('other vip')).known, false);
        await fs.promises.writeFile(file, '[]');
        now += 100;
        assert.deepEqual(await list.check('other vip'), { known: true, member: false, stale: false });
    } finally {
        fs.promises.readFile = original;
        fs.rmSync(dir, { recursive: true });
    }
});

test('GitLab uses encoded Files API and decodes base64; blob/raw VIP_SOURCE are rejected, never fetched', async () => {
    const original = https.request;
    let requests = 0;
    let responseText = JSON.stringify({ encoding: 'base64', content: Buffer.from('["Example VIP"]').toString('base64') });
    https.request = (options, cb) => {
        requests++;
        assert.equal(options.hostname, 'gitlab.com');
        assert.equal(options.path, '/api/v4/projects/example%2Fproject/repository/files/Member.txt?ref=main');
        assert.equal(options.headers['PRIVATE-TOKEN'], undefined);
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.end = () => queueMicrotask(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            cb(res); res.emit('data', responseText); res.emit('end');
        });
        return req;
    };
    try {
        const config = loadConfig({}, { vipSource: 'gitlab', gitlabProjectId: 'example/project', gitlabVipPath: 'Member.txt' });
        const list = createVipList(config, silent);
        assert.equal(await list.refresh(), true);
        assert.equal((await list.check('example vip')).member, true);
        responseText = '<html>not file content</html>';
        assert.equal(await list.refresh(), false);
        assert.equal((await list.check('example vip')).known, false);
        responseText = JSON.stringify({ encoding: 'base64', content: 'not-valid-base64!' });
        assert.equal(await list.refresh(), false);
        const before = requests;
        for (const mode of ['blob', 'raw']) {
            const bad = createVipList(loadConfig({}, { vipSource: `https://gitlab.com/example/project/-/${mode}/main/Member.txt` }), silent);
            assert.equal(await bad.refresh(), false);
            assert.equal(bad.state().source, 'unsupported');
        }
        assert.equal(requests, before);
    } finally { https.request = original; }
});

test('VIP TTL and session duration must be positive finite integer values', () => {
    assert.throws(() => createVipList(loadConfig({}, { vipListTtlMs: NaN }), silent));
    assert.throws(() => loadConfig({}, { vipSessionTtlMs: 0 }));
});
