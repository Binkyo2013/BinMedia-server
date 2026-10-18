'use strict';
// Opt-in integration suite. Use a disposable LOCAL PostgreSQL database only.
// Each run owns a random schema; never point BINMEDIA_TEST_DATABASE_URL at production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { PostgresStore } = require('../lib/store');
const { loadConfig, createApp } = require('../server');
const core = require('../lib/authcore');
const dbUrl = process.env.BINMEDIA_TEST_DATABASE_URL;
const A = 'test_device_A_0123456789';
const B = 'test_device_B_0123456789';

test('PostgreSQL integration: additive migration, durable atomic bindings, sessions, failure isolation', { skip: !dbUrl }, async t => {
    const parsed = new URL(dbUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'integration suite only accepts local test DB');
    const schemaName = 'bm_test_' + crypto.randomBytes(8).toString('hex');
    const admin = new Pool({ connectionString: dbUrl });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ connectionString: dbUrl, max: 8, options: `-c search_path=${schemaName}` });
    const store = new PostgresStore(pool);
    const now = Date.now();
    let app;
    try {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
        // Simulate deployment over the original schema with existing Free and VIP rows.
        await pool.query(sql.split('-- Additive VIP binding migration.')[0]);
        const freeParams = { accountId: 'old_free', name: 'Old Free', nameKey: 'old free', deviceId: A, now, freeExpiresAt: now + 48 * 3600000 };
        await store.registerFree(freeParams);
        await store.saveAccount({ id: 'old_vip', name: 'Old VIP', nameKey: 'old vip', type: 'vip', lastDeviceId: B, status: 'active', createdAt: now });
        await pool.query("INSERT INTO sessions (id,token_hash,account_id) VALUES ('legacy_session',$1,'old_vip')", [core.hashToken('legacy-test-token')]);
        const oldFree = await store.getAccountById('old_free');
        await t.test('migration is repeatable, preserves existing records, never backfills unverified lastDeviceId', async () => {
            await store.init();
            await store.init();
            assert.deepEqual(await store.getAccountById('old_free'), oldFree);
            assert.equal((await store.getAccountById('old_vip')).lastDeviceId, B);
            assert.equal(await store.getVipDevice('old_vip'), null);
            assert.equal((await store.getSession('legacy_session')).deviceId, null);
        });
        const params = (name, deviceId) => ({ accountId: core.newId('test_'), name, nameKey: name.toLowerCase(), deviceId, now });
        let acc;
        await t.test('concurrent new claims across connections choose exactly one device/account', async () => {
            const results = await Promise.allSettled([A, B].map(d => store.claimVipDevice(params('Race VIP', d))));
            assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
            assert.equal(results.find(r => r.status === 'rejected').reason.code, 'VIP_DEVICE_MISMATCH');
            acc = results.find(r => r.status === 'fulfilled').value;
            const rows = await pool.query("SELECT * FROM accounts WHERE name_key='race vip'");
            assert.equal(rows.rowCount, 1);
            const binding = await store.getVipDevice(acc.id);
            assert.ok([A, B].includes(binding.deviceId));
            const wrong = binding.deviceId === A ? B : A;
            await assert.rejects(store.claimVipDevice(params('Race VIP', wrong)), { code: 'VIP_DEVICE_MISMATCH' });
            assert.equal((await store.claimVipDevice(params('Race VIP', binding.deviceId))).id, acc.id);
        });
        await t.test('many same-device requests and multiple VIP accounts do not collide with Free', async () => {
            const results = await Promise.all(Array.from({ length: 12 }, () => store.claimVipDevice(params('Shared VIP', A))));
            assert.equal(new Set(results.map(r => r.id)).size, 1);
            await store.claimVipDevice(params('Second VIP', A));
            assert.deepEqual(await store.getAccountById('old_free'), oldFree);
            assert.equal((await store.getFreeDevice(A)).accountId, 'old_free');
            const count = await pool.query('SELECT count(*)::int AS n FROM vip_device_bindings WHERE device_id=$1', [A]);
            assert.ok(count.rows[0].n >= 2);
        });
        await t.test('constraint failure rolls back account creation; FK and account uniqueness enforced', async () => {
            await assert.rejects(store.claimVipDevice(params('Rollback VIP', 'short')), { code: '23514' });
            assert.equal(await store.getAccountByNameKey('rollback vip'), null);
            await assert.rejects(pool.query("INSERT INTO vip_device_bindings(account_id,device_id) VALUES ('missing',$1)", [A]), { code: '23503' });
            await assert.rejects(pool.query('INSERT INTO vip_device_bindings(account_id,device_id) VALUES ($1,$2)', [acc.id, A]), { code: '23505' });
        });
        await t.test('legacy VIP first claim and revoked status do not overwrite ownership', async () => {
            const existing = await store.claimVipDevice(params('Old VIP', A));
            assert.equal(existing.id, 'old_vip');
            assert.equal((await store.getVipDevice(existing.id)).deviceId, A);
            await pool.query("UPDATE accounts SET status='revoked' WHERE id='old_vip'");
            await assert.rejects(store.claimVipDevice(params('Old VIP', A)), { code: 'VIP_INACTIVE' });
        });
        let fakeNow = now;
        const config = loadConfig({}, { storeDriver: 'postgres', vipSource: 'static', vipListStatic: '["Shared VIP","Second VIP"]', now: () => fakeNow });
        app = createApp({ config, store, log: () => {} });
        await app.vipList.refresh();
        await new Promise(r => app.server.listen(0, '127.0.0.1', r));
        const base = 'http://127.0.0.1:' + app.server.address().port;
        const api = async (method, route, body, token, device) => {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            if (device) headers['X-Device-ID'] = device;
            const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
            return { status: response.status, body: await response.json() };
        };
        let token;
        await t.test('HTTP login persists hashed session/device; reopen validates token and binding', async () => {
            const login = await api('POST', '/api/auth/login-vip', { name: 'Shared VIP', deviceId: A });
            assert.equal(login.status, 200);
            token = login.body.token;
            const stored = await store.findSessionByTokenHash(core.hashToken(token));
            assert.equal(stored.deviceId, A);
            assert.equal(stored.expiresAt, login.body.session.expiresAt);
            assert.ok(!JSON.stringify(stored).includes(token));
            assert.equal((await api('GET', '/api/me', null, token, A)).status, 200);
            assert.equal((await api('GET', '/api/me', null, token, B)).body.error.code, 'VIP_DEVICE_MISMATCH');
            const another = new PostgresStore(pool, { autoMigrate: false });
            assert.equal((await another.getVipDevice(stored.accountId)).deviceId, A);
            assert.equal((await another.findSessionByTokenHash(core.hashToken(token))).id, stored.id);
        });
        await t.test('existing session loses VIP after refresh; session record remains intact', async () => {
            config.vipListStatic = '[]';
            fakeNow += config.vipListTtlMs;
            assert.equal((await api('GET', '/api/me', null, token, A)).body.error.code, 'VIP_INACTIVE');
            assert.ok(await store.findSessionByTokenHash(core.hashToken(token)));
        });
        await t.test('five invalid VIP logins lock for 300s and survive a new store instance', async () => {
            config.vipListStatic = '["Second VIP"]';
            fakeNow += config.vipListTtlMs;
            for (let i = 0; i < 5; i++) {
                assert.equal((await api('POST', '/api/auth/login-vip', { name: 'Invalid Example', deviceId: A })).status, 401);
            }
            const blocked = await api('POST', '/api/auth/login-vip', { name: 'Second VIP', deviceId: A });
            assert.equal(blocked.body.error.code, 'AUTH_LOCKED');
            assert.equal(blocked.body.error.retryAfterSec, 300);
            const freshStore = new PostgresStore(pool, { autoMigrate: false });
            assert.ok((await freshStore.getAttempt('vipfail:device:' + A)).lockedUntil > fakeNow);
            fakeNow += 300000;
            assert.equal((await api('POST', '/api/auth/login-vip', { name: 'Second VIP', deviceId: A })).status, 200);
        });
        await t.test('unavailable PostgreSQL grants no login or session access; health hides DB details', async () => {
            await pool.end();
            const login = await api('POST', '/api/auth/login-vip', { name: 'Shared VIP', deviceId: A });
            assert.equal(login.status, 500);
            assert.equal(login.body.token, undefined);
            assert.equal(login.body.error.code, 'INTERNAL');
            assert.equal((await api('GET', '/api/me', null, token, A)).status, 500);
            const health = await api('GET', '/health');
            assert.equal(health.body.store.ok, false);
            assert.equal(health.body.store.error, 'STORE_UNAVAILABLE');
        });
    } finally {
        if (app) await new Promise(r => app.server.close(r));
        if (!pool.ended) await pool.end();
        await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
        await admin.end();
    }
});
