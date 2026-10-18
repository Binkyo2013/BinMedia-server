'use strict';
// ============================================================================
// Bin Media — store: tầng lưu trữ bền vững
//
// Driver:
//   - 'postgres' : PostgreSQL (khuyến nghị trên Render) — bảng riêng, UNIQUE
//                  ràng buộc đăng ký Free nguyên tử theo đặc tả.
//   - 'json'     : file JSON nguyên tử (ghi tmp + rename) — dev/test.
//   - 'git'      : file JSON trong repo GitHub/GitLab riêng (Contents API) —
//                  bền vững trên Render khi chưa có DB (theo pattern cũ của repo).
//
// Mọi giá trị thời gian do SERVER sinh (Date.now hoặc config.now khi test).
// Client không bao giờ quyết định được thời hạn Free hay trạng thái VIP.
// ============================================================================
const fs = require('fs');
const path = require('path');
const https = require('https');

const core = require('./authcore');
const E = core.E;
const codedError = core.codedError;

// ---------------------------------------------------------------------------
// Persistence cho DocumentStore: file local hoặc file trên git
// ---------------------------------------------------------------------------
function emptyDoc() {
    return {
        version: 1,
        accounts: {},       // id → account
        vipBindings: {},
        freeDevices: {},    // deviceId → { accountId, registeredAt }
        sessions: {},       // id → session (tokenHash, không bao giờ lưu token thô)
        loginAttempts: {},  // key → gate { fails, count, windowStart, lockedUntil, lastAt }
        categories: {},     // id → { id, name, slug, position }
        movies: {},         // id → movie
        episodes: {},       // id → episode
        watchHistory: {},   // accountId → { episodeId → entry }
        meta: { createdAt: 0, updatedAt: 0 },
    };
}

function normalizeDoc(raw) {
    var doc = emptyDoc();
    if (!raw || typeof raw !== 'object') return doc;
    var keys = ['vipBindings', 'accounts', 'freeDevices', 'sessions', 'loginAttempts', 'categories', 'movies', 'episodes', 'watchHistory'];
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (raw[k] && typeof raw[k] === 'object') doc[k] = raw[k];
    }
    if (raw.meta && typeof raw.meta === 'object') doc.meta = Object.assign(doc.meta, raw.meta);
    return doc;
}

function FilePersistence(file) {
    this.file = file;
}
FilePersistence.prototype.load = async function () {
    try {
        var text = await fs.promises.readFile(this.file, 'utf8');
        return normalizeDoc(JSON.parse(text));
    } catch (e) {
        if (e.code === 'ENOENT') return emptyDoc();
        if (e instanceof SyntaxError) throw codedError(E.INTERNAL, 500, 'file du lieu hong: ' + this.file);
        throw e;
    }
};
FilePersistence.prototype.save = async function (doc) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    var tmp = this.file + '.tmp.' + process.pid;
    await fs.promises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.file);
};
FilePersistence.prototype.ping = async function () {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.access(path.dirname(this.file));
};

// File JSON trên GitHub/GitLab (Contents/Files API) — đọc/ghi qua HTTPS.
function GitPersistence(opts) {
    this.provider = opts.provider || 'github';        // 'github' | 'gitlab'
    this.token = opts.token || '';
    this.owner = opts.owner || '';                    // github
    this.repo = opts.repo || '';                      // github
    this.projectId = opts.projectId || '';            // gitlab
    this.filePath = opts.filePath || 'bimedia-db.json';
    this.branch = opts.branch || 'main';
    this.apiUrl = opts.apiUrl || (this.provider === 'gitlab' ? 'https://gitlab.com/api/v4' : 'https://api.github.com');
    this.sha = null;       // github: content sha; gitlab: last_commit_id
    this.exists = false;
}

GitPersistence.prototype._headers = function (extra) {
    var h = Object.assign({
        'User-Agent': 'binmedia-server/0.2',
        'Accept': 'application/vnd.github+json',
    }, extra || {});
    if (this.token) {
        h['Authorization'] = (this.provider === 'gitlab' ? 'PRIVATE-TOKEN ' : 'Bearer ') + this.token;
    }
    return h;
};

GitPersistence.prototype._request = function (method, url, body) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var u = new URL(url);
        var payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
        var req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: method,
            headers: self._headers(payload ? {
                'Content-Type': 'application/json',
                'Content-Length': String(payload.length),
            } : {}),
        }, function (res) {
            var buf = '';
            res.on('data', function (c) { if (buf.length < 8 * 1024 * 1024) buf += c; });
            res.on('end', function () {
                resolve({ status: res.statusCode, body: buf, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
};

GitPersistence.prototype._getMeta = function () {
    if (this.provider === 'gitlab') {
        return this.apiUrl + '/projects/' + encodeURIComponent(this.projectId) +
            '/repository/files/' + encodeURIComponent(this.filePath) + '?ref=' + encodeURIComponent(this.branch);
    }
    return this.apiUrl + '/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo) +
        '/contents/' + encodeURIComponent(this.filePath) + '?ref=' + encodeURIComponent(this.branch);
};

GitPersistence.prototype._putMeta = function () {
    if (this.provider === 'gitlab') {
        return this.apiUrl + '/projects/' + encodeURIComponent(this.projectId) +
            '/repository/files/' + encodeURIComponent(this.filePath);
    }
    return this.apiUrl + '/repos/' + encodeURIComponent(this.owner) + '/' + encodeURIComponent(this.repo) +
        '/contents/' + encodeURIComponent(this.filePath);
};

GitPersistence.prototype.load = async function () {
    var res = await this._request('GET', this._getMeta());
    if (res.status === 404) {
        this.exists = false;
        this.sha = null;
        return emptyDoc();
    }
    if (res.status < 200 || res.status >= 300) {
        throw codedError(E.INTERNAL, 500, 'khong doc duoc store git: HTTP ' + res.status);
    }
    var data;
    try { data = JSON.parse(res.body); } catch (e) {
        throw codedError(E.INTERNAL, 500, 'store git: response khong phai JSON');
    }
    if (!data.content) throw codedError(E.INTERNAL, 500, 'store git: thieu content');
    this.exists = true;
    this.sha = this.provider === 'gitlab' ? data.last_commit_id : data.sha;
    var text = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
    try {
        return normalizeDoc(JSON.parse(text));
    } catch (e) {
        throw codedError(E.INTERNAL, 500, 'store git: JSON trong file hong');
    }
};

GitPersistence.prototype.save = async function (doc) {
    var content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64');
    var message = 'Bin Media: cap nhat du lieu';
    for (var attempt = 0; attempt < 3; attempt++) {
        var body, url, method;
        if (this.provider === 'gitlab') {
            url = this._putMeta();
            if (this.exists) {
                method = 'PUT';
                body = { branch: this.branch, content: content, commit_message: message, last_commit_id: this.sha || undefined };
            } else {
                method = 'POST';
                body = { branch: this.branch, content: content, commit_message: message };
            }
        } else {
            url = this._putMeta();
            method = 'PUT';
            body = { message: message, content: content, sha: this.sha || undefined, branch: this.branch };
        }
        var res = await this._request(method, url, body);
        if (res.status === 409 || res.status === 400) {
            // Conflict → đọc lại sha mới rồi ghi lại (một writer duy nhất: doc của ta là mới nhất)
            var fresh = await this.load();
            void fresh;
            continue;
        }
        if (res.status < 200 || res.status >= 300) {
            throw codedError(E.INTERNAL, 500, 'khong ghi duoc store git: HTTP ' + res.status);
        }
        this.exists = true;
        try {
            var out = JSON.parse(res.body);
            this.sha = this.provider === 'gitlab' ? (out.commit_id || this.sha) : ((out.content && out.content.sha) || this.sha);
        } catch (e) { /* sha cũ giữ nguyên */ }
        return;
    }
    throw codedError(E.INTERNAL, 500, 'store git: conflict qua nhieu lan');
};

GitPersistence.prototype.ping = async function () {
    await this.load();
};

// ---------------------------------------------------------------------------
// DocumentStore: mô hình dữ liệu trong bộ nhớ + persist nguyên tử (mutex)
// ---------------------------------------------------------------------------
function DocumentStore(persistence, config) {
    this.pers = persistence;
    this.config = config || {};
    this.doc = emptyDoc();
    this._q = Promise.resolve();
}

DocumentStore.prototype._locked = function (fn) {
    var run = this._q.then(function () { return fn(); }, function () { return fn(); });
    this._q = run.then(function () {}, function () {});
    return run;
};

DocumentStore.prototype.init = async function () {
    this.doc = await this.pers.load();
    if (!this.doc.meta.createdAt) {
        this.doc.meta.createdAt = this.config.now ? this.config.now() : Date.now();
        await this.pers.save(this.doc);
    }
};

DocumentStore.prototype.close = async function () {};

DocumentStore.prototype.ping = async function () {
    await this.pers.ping();
    return { ok: true, driver: this.config.driverName || 'json' };
};

DocumentStore.prototype._persist = async function () {
    this.doc.meta.updatedAt = this.config.now ? this.config.now() : Date.now();
    await this.pers.save(this.doc);
};

function findByKey(obj, prop, value) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
        if (obj[keys[i]] && obj[keys[i]][prop] === value) return obj[keys[i]];
    }
    return null;
}

DocumentStore.prototype.registerFree = function (p) {
    var self = this;
    return this._locked(async function () {
        if (self.doc.freeDevices[p.deviceId]) {
            throw codedError(E.DEVICE_REGISTERED, 409, 'thiet bi nay da co tai khoan Free');
        }
        if (findByKey(self.doc.accounts, 'nameKey', p.nameKey)) {
            throw codedError(E.NAME_TAKEN, 409, 'ten tai khoan da duoc su dung');
        }
        var account = {
            id: p.accountId,
            name: p.name,
            nameKey: p.nameKey,
            type: 'free',
            deviceId: p.deviceId,
            lastDeviceId: p.deviceId,
            createdAt: p.now,
            freeExpiresAt: p.freeExpiresAt,
            historyConsent: null,
            status: 'active',
            updatedAt: p.now,
        };
        self.doc.accounts[account.id] = account;
        self.doc.freeDevices[p.deviceId] = { accountId: account.id, registeredAt: p.now };
        await self._persist();
        return account;
    });
};

// Serialize first claim; publish only after persistence succeeds.
DocumentStore.prototype.claimVipDevice = function (p) {
    var self = this;
    return this._locked(async function () {
        var next = JSON.parse(JSON.stringify(self.doc));
        var acc = findByKey(next.accounts, 'nameKey', p.nameKey);
        if (acc && acc.status !== 'active') throw codedError(E.VIP_INACTIVE, 403, 'tai khoan khong con hieu luc');
        if (!acc) {
            acc = { id: p.accountId, name: p.name, nameKey: p.nameKey, type: 'vip',
                deviceId: null, createdAt: p.now, status: 'active', historyConsent: null };
        }
        var binding = next.vipBindings[acc.id];
        if (binding && binding.deviceId !== p.deviceId) {
            throw codedError(E.VIP_DEVICE_MISMATCH, 403, 'tai khoan VIP da lien ket voi thiet bi khac');
        }
        next.vipBindings[acc.id] = binding || { deviceId: p.deviceId, boundAt: p.now };
        acc.type = 'vip';
        // Preserve the old Free device record and expiry for audit.
        acc.lastDeviceId = p.deviceId;
        acc.updatedAt = p.now;
        next.accounts[acc.id] = acc;
        await self.pers.save(next);
        self.doc = next;
        return acc;
    });
};
DocumentStore.prototype.getVipDevice = async function (accountId) {
    return this.doc.vipBindings[accountId] || null;
};

DocumentStore.prototype.getAccountById = async function (id) {
    return this.doc.accounts[id] || null;
};
DocumentStore.prototype.getAccountByNameKey = async function (nk) {
    return findByKey(this.doc.accounts, 'nameKey', nk);
};
DocumentStore.prototype.getFreeDevice = async function (deviceId) {
    var d = this.doc.freeDevices[deviceId];
    return d ? Object.assign({ deviceId: deviceId }, d) : null;
};
DocumentStore.prototype.saveAccount = async function (account) {
    var self = this;
    return this._locked(async function () {
        account.updatedAt = self.config.now ? self.config.now() : Date.now();
        self.doc.accounts[account.id] = account;
        await self._persist();
        return account;
    });
};
DocumentStore.prototype.listAccounts = async function () {
    return Object.values(this.doc.accounts);
};

DocumentStore.prototype.createSession = async function (s) {
    var self = this;
    return this._locked(async function () {
        self.doc.sessions[s.id] = s;
        await self._persist();
        return s;
    });
};
DocumentStore.prototype.findSessionByTokenHash = async function (hash) {
    return findByKey(this.doc.sessions, 'tokenHash', hash);
};
DocumentStore.prototype.getSession = async function (id) {
    return this.doc.sessions[id] || null;
};
DocumentStore.prototype.revokeSession = async function (id, now) {
    var self = this;
    return this._locked(async function () {
        var s = self.doc.sessions[id];
        if (!s) return false;
        s.revokedAt = now;
        await self._persist();
        return true;
    });
};
DocumentStore.prototype.revokeSessionsByAccount = async function (accountId, now) {
    var self = this;
    return this._locked(async function () {
        var ids = Object.keys(self.doc.sessions);
        var n = 0;
        for (var i = 0; i < ids.length; i++) {
            var s = self.doc.sessions[ids[i]];
            if (s.accountId === accountId && !s.revokedAt) {
                s.revokedAt = now;
                n++;
            }
        }
        if (n) await self._persist();
        return n;
    });
};
DocumentStore.prototype.listSessions = async function (filter) {
    var out = [];
    var ids = Object.keys(this.doc.sessions);
    for (var i = 0; i < ids.length; i++) {
        var s = this.doc.sessions[ids[i]];
        if (filter && filter.accountId && s.accountId !== filter.accountId) continue;
        out.push(s);
    }
    return out;
};
DocumentStore.prototype.touchSession = async function (id, at) {
    var s = this.doc.sessions[id];
    if (s && (!s.lastSeenAt || at - s.lastSeenAt > 60000)) {
        s.lastSeenAt = at;
        await this._persist();
    }
};

DocumentStore.prototype.getAttempt = async function (key) {
    return this.doc.loginAttempts[key] || core.newGate();
};
DocumentStore.prototype.saveAttempt = async function (key, gate) {
    var self = this;
    return this._locked(async function () {
        self.doc.loginAttempts[key] = gate;
        await self._persist();
        return gate;
    });
};
DocumentStore.prototype.clearAttempt = async function (key) {
    var self = this;
    return this._locked(async function () {
        delete self.doc.loginAttempts[key];
        await self._persist();
    });
};

DocumentStore.prototype.listCategories = async function () {
    return Object.values(this.doc.categories).sort(function (a, b) { return a.position - b.position; });
};
DocumentStore.prototype.upsertCategory = async function (cat) {
    var self = this;
    return this._locked(async function () {
        var prev = self.doc.categories[cat.id] || {};
        var next = Object.assign({}, prev, cat);
        self.doc.categories[cat.id] = next;
        await self._persist();
        return next;
    });
};

DocumentStore.prototype._movieMatches = function (m, q, categoryId) {
    if (categoryId && (m.categoryIds || []).indexOf(categoryId) === -1) return false;
    if (q) {
        var hay = ((m.title || '') + ' ' + (m.description || '')).toLowerCase();
        if (hay.indexOf(String(q).toLowerCase()) === -1) return false;
    }
    return true;
};

DocumentStore.prototype.listMovies = async function (opts) {
    opts = opts || {};
    var all = Object.values(this.doc.movies).filter(function (m) {
        return this._movieMatches(m, opts.q, opts.categoryId);
    }.bind(this));
    all.sort(function (a, b) {
        if (opts.sort === 'updated') return (b.updatedAt || 0) - (a.updatedAt || 0);
        return String(a.title || '').localeCompare(String(b.title || ''));
    });
    var total = all.length;
    var page = Math.max(1, opts.page || 1);
    var pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    return { items: all.slice((page - 1) * pageSize, page * pageSize), total: total, page: page, pageSize: pageSize };
};
DocumentStore.prototype.findMovie = async function (idOrSlug) {
    return this.doc.movies[idOrSlug] || findByKey(this.doc.movies, 'slug', idOrSlug) || null;
};
DocumentStore.prototype.upsertMovie = async function (movie) {
    var self = this;
    return this._locked(async function () {
        var prev = self.doc.movies[movie.id] || {};
        var next = Object.assign({}, prev, movie);
        if (!next.categoryIds) next.categoryIds = prev.categoryIds || [];
        self.doc.movies[movie.id] = next;
        await self._persist();
        return next;
    });
};
DocumentStore.prototype.listEpisodes = async function (movieId) {
    var out = Object.values(this.doc.episodes).filter(function (e) { return e.movieId === movieId; });
    out.sort(function (a, b) { return (a.epNumber || 0) - (b.epNumber || 0); });
    return out;
};
DocumentStore.prototype.findEpisode = async function (id) {
    return this.doc.episodes[id] || null;
};
DocumentStore.prototype.upsertEpisode = async function (ep) {
    var self = this;
    return this._locked(async function () {
        var prev = self.doc.episodes[ep.id] || {};
        var next = Object.assign({}, prev, ep);
        self.doc.episodes[ep.id] = next;
        await self._persist();
        return next;
    });
};

DocumentStore.prototype.listHistory = async function (accountId) {
    var m = this.doc.watchHistory[accountId] || {};
    return Object.values(m).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
};
DocumentStore.prototype.putHistory = async function (entry) {
    var self = this;
    return this._locked(async function () {
        if (!self.doc.watchHistory[entry.accountId]) self.doc.watchHistory[entry.accountId] = {};
        self.doc.watchHistory[entry.accountId][entry.episodeId] = entry;
        await self._persist();
        return entry;
    });
};
DocumentStore.prototype.clearHistory = async function (accountId) {
    var self = this;
    return this._locked(async function () {
        delete self.doc.watchHistory[accountId];
        await self._persist();
    });
};

DocumentStore.prototype.stats = async function () {
    return {
        accounts: Object.keys(this.doc.accounts).length,
        freeDevices: Object.keys(this.doc.freeDevices).length,
        sessions: Object.keys(this.doc.sessions).length,
        movies: Object.keys(this.doc.movies).length,
        episodes: Object.keys(this.doc.episodes).length,
        categories: Object.keys(this.doc.categories).length,
        updatedAt: this.doc.meta.updatedAt,
    };
};

// ---------------------------------------------------------------------------
// PostgresStore — bảng riêng theo schema.sql (ràng buộc UNIQUE = nguyên tử)
// ---------------------------------------------------------------------------
function PostgresStore(pool, config) {
    this.pool = pool;
    this.config = config || {};
}

PostgresStore.prototype.init = async function () {
    if (this.config.autoMigrate !== false) {
        var schemaPath = path.join(__dirname, '..', 'schema.sql');
        var sql = await fs.promises.readFile(schemaPath, 'utf8');
        await this.pool.query(sql);
    }
};
PostgresStore.prototype.close = async function () {
    await this.pool.end();
};
PostgresStore.prototype.ping = async function () {
    await this.pool.query('SELECT 1');
    return { ok: true, driver: 'postgres' };
};

function rowToAccount(r) {
    return {
        id: r.id,
        name: r.name,
        nameKey: r.name_key,
        type: r.type,
        deviceId: r.device_id,
        lastDeviceId: r.last_device_id,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
        freeExpiresAt: r.free_expires_at ? new Date(r.free_expires_at).getTime() : null,
        historyConsent: r.history_consent ? { accepted: true, at: r.history_consent_at ? new Date(r.history_consent_at).getTime() : 0 } : null,
        status: r.status,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    };
}

function rowToSession(r) {
    return {
        id: r.id,
        tokenHash: r.token_hash,
        deviceId: r.device_id,
        accountId: r.account_id,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
        expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
        revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).getTime() : null,
        ip: r.ip,
        ua: r.ua,
    };
}

PostgresStore.prototype.registerFree = async function (p) {
    var client = await this.pool.connect();
    try {
        await client.query('BEGIN');
        var acc = await client.query(
            'INSERT INTO accounts (id, name, name_key, type, device_id, last_device_id, created_at, free_expires_at, status, updated_at)' +
            ' VALUES ($1,$2,$3,\'free\',$4,$4,to_timestamp($5::numeric/1000.0),to_timestamp($6::numeric/1000.0),\'active\',to_timestamp($5::numeric/1000.0))' +
            ' RETURNING *',
            [p.accountId, p.name, p.nameKey, p.deviceId, p.now, p.freeExpiresAt]
        );
        var ins = await client.query(
            'INSERT INTO free_devices (device_id, account_id, registered_at) VALUES ($1,$2,to_timestamp($3::numeric/1000.0))' +
            ' ON CONFLICT (device_id) DO NOTHING RETURNING device_id',
            [p.deviceId, p.accountId, p.now]
        );
        if (ins.rowCount === 0) {
            await client.query('ROLLBACK');
            throw codedError(E.DEVICE_REGISTERED, 409, 'thiet bi nay da co tai khoan Free');
        }
        await client.query('COMMIT');
        return rowToAccount(acc.rows[0]);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
        if (e && e.code === '23505') {
            if (String(e.constraint || '').indexOf('name_key') !== -1) {
                throw codedError(E.NAME_TAKEN, 409, 'ten tai khoan da duoc su dung');
            }
            if (String(e.constraint || '').indexOf('device') !== -1) {
                throw codedError(E.DEVICE_REGISTERED, 409, 'thiet bi nay da co tai khoan Free');
            }
            throw codedError(E.NAME_TAKEN, 409, 'ten tai khoan da duoc su dung');
        }
        throw e;
    } finally {
        client.release();
    }
};

// Unique name insert + row lock serializes both new and existing claims across servers.
PostgresStore.prototype.claimVipDevice = async function (p) {
    var client = await this.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            "INSERT INTO accounts (id,name,name_key,type,created_at,status,updated_at) VALUES ($1,$2,$3,'vip',to_timestamp($4::numeric/1000.0),'active',to_timestamp($4::numeric/1000.0)) ON CONFLICT (name_key) DO NOTHING",
            [p.accountId, p.name, p.nameKey, p.now]);
        var r = await client.query('SELECT * FROM accounts WHERE name_key=$1 FOR UPDATE', [p.nameKey]);
        var acc = r.rows[0];
        if (acc.status !== 'active') throw codedError(E.VIP_INACTIVE, 403, 'tai khoan khong con hieu luc');
        await client.query('INSERT INTO vip_device_bindings (account_id,device_id,bound_at) VALUES ($1,$2,to_timestamp($3::numeric/1000.0)) ON CONFLICT (account_id) DO NOTHING', [acc.id, p.deviceId, p.now]);
        var binding = await client.query('SELECT device_id FROM vip_device_bindings WHERE account_id=$1', [acc.id]);
        if (binding.rows[0].device_id !== p.deviceId) {
            throw codedError(E.VIP_DEVICE_MISMATCH, 403, 'tai khoan VIP da lien ket voi thiet bi khac');
        }
        r = await client.query("UPDATE accounts SET type='vip',last_device_id=$2,updated_at=to_timestamp($3::numeric/1000.0) WHERE id=$1 RETURNING *", [acc.id, p.deviceId, p.now]);
        await client.query('COMMIT');
        return rowToAccount(r.rows[0]);
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection may be down */ }
        throw e;
    } finally { client.release(); }
};
PostgresStore.prototype.getVipDevice = async function (accountId) {
    var r = await this.pool.query('SELECT device_id, bound_at FROM vip_device_bindings WHERE account_id=$1', [accountId]);
    return r.rows[0] ? { deviceId: r.rows[0].device_id, boundAt: new Date(r.rows[0].bound_at).getTime() } : null;
};

PostgresStore.prototype.getAccountById = async function (id) {
    var r = await this.pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
    return r.rows[0] ? rowToAccount(r.rows[0]) : null;
};
PostgresStore.prototype.getAccountByNameKey = async function (nk) {
    var r = await this.pool.query('SELECT * FROM accounts WHERE name_key = $1', [nk]);
    return r.rows[0] ? rowToAccount(r.rows[0]) : null;
};
PostgresStore.prototype.getFreeDevice = async function (deviceId) {
    var r = await this.pool.query('SELECT device_id, account_id, registered_at FROM free_devices WHERE device_id = $1', [deviceId]);
    if (!r.rows[0]) return null;
    return {
        deviceId: r.rows[0].device_id,
        accountId: r.rows[0].account_id,
        registeredAt: r.rows[0].registered_at ? new Date(r.rows[0].registered_at).getTime() : 0,
    };
};
PostgresStore.prototype.saveAccount = async function (account) {
    var r = await this.pool.query(
        'INSERT INTO accounts (id,name,name_key,type,device_id,last_device_id,created_at,free_expires_at,history_consent,history_consent_at,status,updated_at)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7::numeric/1000.0),CASE WHEN $8::numeric IS NULL THEN NULL ELSE to_timestamp($8::numeric/1000.0) END,$9,CASE WHEN $10::numeric IS NULL THEN NULL ELSE to_timestamp($10::numeric/1000.0) END,$11,to_timestamp($12::numeric/1000.0))' +
        ' ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, name_key=EXCLUDED.name_key, type=EXCLUDED.type,' +
        ' device_id=EXCLUDED.device_id, last_device_id=EXCLUDED.last_device_id,' +
        ' free_expires_at=EXCLUDED.free_expires_at, history_consent=EXCLUDED.history_consent,' +
        ' history_consent_at=EXCLUDED.history_consent_at, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at' +
        ' RETURNING *',
        [
            account.id, account.name, account.nameKey, account.type, account.deviceId || null,
            account.lastDeviceId || null, account.createdAt || Date.now(),
            account.freeExpiresAt || null,
            account.historyConsent && account.historyConsent.accepted ? true : false,
            account.historyConsent ? account.historyConsent.at || null : null,
            account.status || 'active', account.updatedAt || Date.now(),
        ]
    );
    return rowToAccount(r.rows[0]);
};
PostgresStore.prototype.listAccounts = async function () {
    var r = await this.pool.query('SELECT * FROM accounts ORDER BY created_at DESC');
    return r.rows.map(rowToAccount);
};

PostgresStore.prototype.createSession = async function (s) {
    await this.pool.query(
        'INSERT INTO sessions (id, token_hash, account_id, created_at, expires_at, ip, ua, device_id) VALUES ($1,$2,$3,to_timestamp($4::numeric/1000.0),CASE WHEN $5::numeric IS NULL THEN NULL ELSE to_timestamp($5::numeric/1000.0) END,$6,$7,$8)',
        [s.id, s.tokenHash, s.accountId, s.createdAt, s.expiresAt || null, s.ip || null, s.ua || null, s.deviceId || null]
    );
    return s;
};
PostgresStore.prototype.findSessionByTokenHash = async function (hash) {
    var r = await this.pool.query('SELECT * FROM sessions WHERE token_hash = $1', [hash]);
    return r.rows[0] ? rowToSession(r.rows[0]) : null;
};
PostgresStore.prototype.getSession = async function (id) {
    var r = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    return r.rows[0] ? rowToSession(r.rows[0]) : null;
};
PostgresStore.prototype.revokeSession = async function (id, now) {
    var r = await this.pool.query('UPDATE sessions SET revoked_at = to_timestamp($2::numeric/1000.0) WHERE id = $1 AND revoked_at IS NULL', [id, now]);
    return r.rowCount > 0;
};
PostgresStore.prototype.revokeSessionsByAccount = async function (accountId, now) {
    var r = await this.pool.query('UPDATE sessions SET revoked_at = to_timestamp($2::numeric/1000.0) WHERE account_id = $1 AND revoked_at IS NULL', [accountId, now]);
    return r.rowCount;
};
PostgresStore.prototype.listSessions = async function (filter) {
    var r = filter && filter.accountId
        ? await this.pool.query('SELECT * FROM sessions WHERE account_id = $1 ORDER BY created_at DESC', [filter.accountId])
        : await this.pool.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 500');
    return r.rows.map(rowToSession);
};
PostgresStore.prototype.touchSession = async function (id, at) {
    await this.pool.query('UPDATE sessions SET last_seen_at = to_timestamp($2::numeric/1000.0) WHERE id = $1', [id, at]);
};

function rowToGate(r) {
    return {
        fails: r.fails,
        count: r.count,
        windowStart: r.window_start ? new Date(r.window_start).getTime() : 0,
        lockedUntil: r.locked_until ? new Date(r.locked_until).getTime() : 0,
        lastAt: r.last_fail_at ? new Date(r.last_fail_at).getTime() : 0,
    };
}
PostgresStore.prototype.getAttempt = async function (key) {
    var r = await this.pool.query('SELECT * FROM login_attempts WHERE key = $1', [key]);
    return r.rows[0] ? rowToGate(r.rows[0]) : core.newGate();
};
PostgresStore.prototype.saveAttempt = async function (key, gate) {
    await this.pool.query(
        'INSERT INTO login_attempts (key, fails, count, window_start, locked_until, last_fail_at)' +
        ' VALUES ($1,$2,$3,CASE WHEN $4::numeric IS NULL OR $4::numeric = 0 THEN NULL ELSE to_timestamp($4::numeric/1000.0) END,CASE WHEN $5::numeric IS NULL OR $5::numeric = 0 THEN NULL ELSE to_timestamp($5::numeric/1000.0) END,CASE WHEN $6::numeric IS NULL OR $6::numeric = 0 THEN NULL ELSE to_timestamp($6::numeric/1000.0) END)' +
        ' ON CONFLICT (key) DO UPDATE SET fails=EXCLUDED.fails, count=EXCLUDED.count, window_start=EXCLUDED.window_start, locked_until=EXCLUDED.locked_until, last_fail_at=EXCLUDED.last_fail_at',
        [key, gate.fails, gate.count, gate.windowStart || 0, gate.lockedUntil || 0, gate.lastAt || 0]
    );
    return gate;
};
PostgresStore.prototype.clearAttempt = async function (key) {
    await this.pool.query('DELETE FROM login_attempts WHERE key = $1', [key]);
};

PostgresStore.prototype.listCategories = async function () {
    var r = await this.pool.query('SELECT * FROM categories ORDER BY position ASC, name ASC');
    return r.rows.map(function (c) { return { id: c.id, name: c.name, slug: c.slug, position: c.position }; });
};
PostgresStore.prototype.upsertCategory = async function (cat) {
    var r = await this.pool.query(
        'INSERT INTO categories (id, name, slug, position) VALUES ($1,$2,$3,$4)' +
        ' ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, slug=EXCLUDED.slug, position=EXCLUDED.position RETURNING *',
        [cat.id, cat.name, cat.slug, cat.position || 0]
    );
    var c = r.rows[0];
    return { id: c.id, name: c.name, slug: c.slug, position: c.position };
};

PostgresStore.prototype.listMovies = async function (opts) {
    opts = opts || {};
    var page = Math.max(1, opts.page || 1);
    var pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    var q = opts.q ? '%' + String(opts.q) + '%' : null;
    var where = 'WHERE ($1::text IS NULL OR m.title ILIKE $1 OR m.description ILIKE $1)' +
        ' AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM movie_categories mc WHERE mc.movie_id = m.id AND mc.category_id = $2))';
    var totalR = await this.pool.query('SELECT count(*)::int AS n FROM movies m ' + where, [q, opts.categoryId || null]);
    var order = opts.sort === 'updated' ? 'm.updated_at DESC' : 'm.title ASC';
    var r = await this.pool.query(
        'SELECT m.* FROM movies m ' + where + ' ORDER BY ' + order + ' LIMIT $3 OFFSET $4',
        [q, opts.categoryId || null, pageSize, (page - 1) * pageSize]
    );
    var items = [];
    for (var i = 0; i < r.rows.length; i++) {
        var m = await this._movieFromRow(r.rows[i]);
        items.push(m);
    }
    return { items: items, total: totalR.rows[0].n, page: page, pageSize: pageSize };
};
PostgresStore.prototype._movieFromRow = async function (r) {
    var cats = await this.pool.query('SELECT category_id FROM movie_categories WHERE movie_id = $1', [r.id]);
    return {
        id: r.id,
        title: r.title,
        slug: r.slug,
        description: r.description,
        posterUrl: r.poster_url,
        categoryIds: cats.rows.map(function (c) { return c.category_id; }),
        createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    };
};
PostgresStore.prototype.findMovie = async function (idOrSlug) {
    var r = await this.pool.query('SELECT * FROM movies WHERE id = $1 OR slug = $2 LIMIT 1', [idOrSlug, idOrSlug]);
    return r.rows[0] ? this._movieFromRow(r.rows[0]) : null;
};
PostgresStore.prototype.upsertMovie = async function (movie) {
    var now = movie.updatedAt || Date.now();
    var r = await this.pool.query(
        'INSERT INTO movies (id, title, slug, description, poster_url, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,to_timestamp($6::numeric/1000.0),to_timestamp($7::numeric/1000.0))' +
        ' ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, slug=EXCLUDED.slug, description=EXCLUDED.description, poster_url=EXCLUDED.poster_url, updated_at=EXCLUDED.updated_at RETURNING *',
        [movie.id, movie.title, movie.slug, movie.description || null, movie.posterUrl || null, movie.createdAt || now, now]
    );
    await this.pool.query('DELETE FROM movie_categories WHERE movie_id = $1', [movie.id]);
    var ids = movie.categoryIds || [];
    for (var i = 0; i < ids.length; i++) {
        await this.pool.query('INSERT INTO movie_categories (movie_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [movie.id, ids[i]]);
    }
    return this._movieFromRow(r.rows[0]);
};
PostgresStore.prototype.listEpisodes = async function (movieId) {
    var r = await this.pool.query('SELECT * FROM episodes WHERE movie_id = $1 ORDER BY ep_number ASC', [movieId]);
    return r.rows.map(rowToEpisode);
};
PostgresStore.prototype.findEpisode = async function (id) {
    var r = await this.pool.query('SELECT * FROM episodes WHERE id = $1', [id]);
    return r.rows[0] ? rowToEpisode(r.rows[0]) : null;
};
function rowToEpisode(r) {
    return {
        id: r.id,
        movieId: r.movie_id,
        title: r.title,
        epNumber: r.ep_number,
        sourceType: r.source_type,
        sourceRef: r.source_ref,
        linkStatus: r.link_status,
        accessStatus: r.access_status,
        accessCheckedAt: r.access_checked_at ? new Date(r.access_checked_at).getTime() : null,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    };
}
PostgresStore.prototype.upsertEpisode = async function (ep) {
    var now = ep.updatedAt || Date.now();
    var r = await this.pool.query(
        'INSERT INTO episodes (id, movie_id, title, ep_number, source_type, source_ref, link_status, access_status, access_checked_at, created_at, updated_at)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::numeric IS NULL THEN NULL ELSE to_timestamp($9::numeric/1000.0) END,to_timestamp($10::numeric/1000.0),to_timestamp($11::numeric/1000.0))' +
        ' ON CONFLICT (id) DO UPDATE SET movie_id=EXCLUDED.movie_id, title=EXCLUDED.title, ep_number=EXCLUDED.ep_number,' +
        ' source_type=EXCLUDED.source_type, source_ref=EXCLUDED.source_ref, link_status=EXCLUDED.link_status,' +
        ' access_status=EXCLUDED.access_status, access_checked_at=EXCLUDED.access_checked_at, updated_at=EXCLUDED.updated_at RETURNING *',
        [
            ep.id, ep.movieId, ep.title, ep.epNumber || 0, ep.sourceType || 'facebook', ep.sourceRef,
            ep.linkStatus || 'linked', ep.accessStatus || 'unknown', ep.accessCheckedAt || null,
            ep.createdAt || now, now,
        ]
    );
    return rowToEpisode(r.rows[0]);
};

PostgresStore.prototype.listHistory = async function (accountId) {
    var r = await this.pool.query('SELECT * FROM watch_history WHERE account_id = $1 ORDER BY updated_at DESC', [accountId]);
    return r.rows.map(function (h) {
        return {
            accountId: h.account_id,
            movieId: h.movie_id,
            episodeId: h.episode_id,
            positionSec: h.position_sec,
            updatedAt: h.updated_at ? new Date(h.updated_at).getTime() : 0,
        };
    });
};
PostgresStore.prototype.putHistory = async function (entry) {
    await this.pool.query(
        'INSERT INTO watch_history (account_id, movie_id, episode_id, position_sec, updated_at) VALUES ($1,$2,$3,$4,to_timestamp($5::numeric/1000.0))' +
        ' ON CONFLICT (account_id, episode_id) DO UPDATE SET movie_id=EXCLUDED.movie_id, position_sec=EXCLUDED.position_sec, updated_at=EXCLUDED.updated_at',
        [entry.accountId, entry.movieId, entry.episodeId, entry.positionSec || 0, entry.updatedAt || Date.now()]
    );
    return entry;
};
PostgresStore.prototype.clearHistory = async function (accountId) {
    await this.pool.query('DELETE FROM watch_history WHERE account_id = $1', [accountId]);
};

PostgresStore.prototype.stats = async function () {
    var r = await this.pool.query(
        'SELECT' +
        ' (SELECT count(*) FROM accounts) AS accounts,' +
        ' (SELECT count(*) FROM free_devices) AS "freeDevices",' +
        ' (SELECT count(*) FROM sessions) AS sessions,' +
        ' (SELECT count(*) FROM movies) AS movies,' +
        ' (SELECT count(*) FROM episodes) AS episodes,' +
        ' (SELECT count(*) FROM categories) AS categories'
    );
    var row = r.rows[0];
    return {
        accounts: row.accounts, freeDevices: row.freeDevices, sessions: row.sessions,
        movies: row.movies, episodes: row.episodes, categories: row.categories,
        updatedAt: Date.now(),
    };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
async function createStore(config) {
    var driver = String(config.storeDriver || 'json').toLowerCase();
    if (driver === 'postgres') {
        var pg;
        try {
            pg = require('pg');
        } catch (e) {
            throw codedError(E.INTERNAL, 500, 'can dat package "pg" de dung driver postgres (npm install)');
        }
        if (!config.databaseUrl) {
            throw codedError(E.INTERNAL, 500, 'thieu DATABASE_URL cho driver postgres');
        }
        var pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, ssl: config.databaseSsl === false ? undefined : { rejectUnauthorized: false } });
        var store = new PostgresStore(pool, { autoMigrate: config.autoMigrate !== false });
        await store.init();
        return store;
    }
    if (driver === 'git') {
        var pers = new GitPersistence({
            provider: config.gitProvider,
            token: config.gitToken,
            owner: config.gitOwner,
            repo: config.gitRepo,
            projectId: config.gitProjectId,
            filePath: config.gitPath,
            branch: config.gitBranch,
            apiUrl: config.gitApiUrl,
        });
        var s = new DocumentStore(pers, { now: config.now, driverName: 'git' });
        await s.init();
        return s;
    }
    var fp = new FilePersistence(config.dataFile || path.join(process.cwd(), 'data', 'bimedia.json'));
    var ds = new DocumentStore(fp, { now: config.now, driverName: 'json' });
    await ds.init();
    return ds;
}

module.exports = {
    createStore: createStore,
    DocumentStore: DocumentStore,
    FilePersistence: FilePersistence,
    GitPersistence: GitPersistence,
    PostgresStore: PostgresStore,
    emptyDoc: emptyDoc,
};
