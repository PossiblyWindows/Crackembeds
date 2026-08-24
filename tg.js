const { Telegraf } = require('telegraf');
const { CurlSession } = require('curl-cffi');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// ---------- Configuration ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '7886961410', 10);
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'a46c50a0ccb1bafe2b15665df7fad7e1';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const POW_TIMEOUT = 30;

if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    process.exit(1);
}

// ---------- Logging ----------
const logger = {
    info: (...args) => console.log(new Date().toISOString(), ...args),
    error: (...args) => console.error(new Date().toISOString(), ...args),
};

// ---------- TTL Cache ----------
class TTLCache {
    constructor(defaultTtl = 300) {
        this.cache = new Map();
        this.defaultTtl = defaultTtl;
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.defaultTtl * 1000) {
            this.cache.delete(key);
            return null;
        }
        return entry.value;
    }
    set(key, value, ttl = this.defaultTtl) {
        this.cache.set(key, { value, timestamp: Date.now() });
    }
}
const streamCache = new TTLCache(120);

// ---------- User Activity Log ----------
const userActivityLog = new Map();
function logUserActivity(ctx, type, text) {
    const user = ctx.from;
    if (!user) return;
    const userId = user.id;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = { timestamp, type, text };
    if (!userActivityLog.has(userId)) {
        userActivityLog.set(userId, {
            info: {
                user_id: userId,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                full_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown',
            },
            activities: [],
        });
    }
    const userData = userActivityLog.get(userId);
    userData.activities.push(entry);
    if (userData.activities.length > 200) {
        userData.activities = userData.activities.slice(-200);
    }
}

// ---------- Simple Concurrency Limiter ----------
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array(Math.min(limit, items.length)).fill().map(async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) break;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

// ---------- HTTP Client Wrapper (curl-cffi) ----------
class CffiClient {
    constructor(options = {}) {
        this.session = new CurlSession({
            impersonate: options.impersonate || 'chrome120',
            timeout: options.timeout || 20000,
        });
        this.defaultHeaders = options.headers || {};
    }

    _buildUrl(url, params) {
        if (!params) return url;
        const u = new URL(url);
        for (const [key, value] of Object.entries(params)) {
            u.searchParams.set(key, value);
        }
        return u.toString();
    }

    async request(method, url, config = {}) {
        const headers = { ...this.defaultHeaders, ...config.headers };
        const finalUrl = this._buildUrl(url, config.params);

        const options = {
            url: finalUrl,
            headers,
            timeout: config.timeout || 20000,
            allowRedirects: true,
            maxRedirects: 5,
        };

        if (method === 'GET') {
            if (config.responseType === 'arraybuffer') {
                const res = await this.session.get(finalUrl, options);
                return {
                    data: res.dataRaw,
                    text: res.text,
                    status: res.status,
                    statusCode: res.statusCode,
                    headers: res.headers,
                    request: { url: finalUrl },
                };
            } else {
                const res = await this.session.get(finalUrl, options);
                return {
                    data: res.data,
                    text: res.text,
                    status: res.status,
                    statusCode: res.statusCode,
                    headers: res.headers,
                    request: { url: finalUrl },
                };
            }
        } else if (method === 'POST') {
            const data = config.data;
            if (typeof data === 'object' && data !== null) {
                options.headers['Content-Type'] = 'application/json';
                options.data = JSON.stringify(data);
            } else {
                options.data = data;
            }
            const res = await this.session.post(finalUrl, options);
            return {
                data: res.data,
                text: res.text,
                status: res.status,
                statusCode: res.statusCode,
                headers: res.headers,
                request: { url: finalUrl },
            };
        }
    }

    get(url, config = {}) { return this.request('GET', url, config); }
    post(url, config = {}) { return this.request('POST', url, config); }
}

// ---------- Curl-based client (for Mapple) ----------
class CurlCommandClient {
    constructor(headers = {}) {
        this.headers = headers;
        this.cookieFile = path.join(os.tmpdir(), `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
    }

    _buildArgs(method, url, data, extraHeaders = {}) {
        const args = ['-s', '-L', '-c', this.cookieFile, '-b', this.cookieFile];
        const allHeaders = { ...this.headers, ...extraHeaders };
        for (const [key, value] of Object.entries(allHeaders)) {
            args.push('-H', `${key}: ${value}`);
        }
        if (method === 'POST') {
            args.push('-X', 'POST');
            if (data) {
                args.push('-H', 'Content-Type: application/json');
                args.push('-d', typeof data === 'string' ? data : JSON.stringify(data));
            }
        }
        args.push(url);
        return args;
    }

    async get(url, config = {}) {
        const args = this._buildArgs('GET', url, null, config.headers || {});
        const { stdout } = await execFileAsync('curl', args, { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
        return { text: stdout, data: this._parseJson(stdout), status: 200, request: { url } };
    }

    async post(url, config = {}) {
        const args = this._buildArgs('POST', url, config.data, config.headers || {});
        const { stdout } = await execFileAsync('curl', args, { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
        return { text: stdout, data: this._parseJson(stdout), status: 200, request: { url } };
    }

    _parseJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    cleanup() {
        fs.unlink(this.cookieFile).catch(() => {});
    }
}

// ---------- URL Helpers ----------
function urlJoin(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return relative;
    }
}

// ---------- HLS Helpers ----------
function isMasterPlaylist(content) {
    return content.includes('#EXT-X-STREAM-INF');
}

async function fetchHlsVariants(url, headers = {}, client) {
    try {
        const resp = await client.get(url, { headers, timeout: 15000 });
        const content = resp.text || resp.data;
        if (!isMasterPlaylist(content)) return [];
        const variants = [];
        let current = {};
        for (const line of content.split(/\r?\n/)) {
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
                current = { quality: res ? `${res[1]}x${res[2]}` : 'Unknown', url: null };
            } else if (line && !line.startsWith('#')) {
                current.url = urlJoin(resp.request?.url || url, line.trim());
                variants.push(current);
                current = {};
            }
        }
        return variants;
    } catch {
        return [];
    }
}

function getQualityFromUrl(url) {
    const m = url.match(/(\d{3,4})p/);
    if (m) return `${m[1]}p`;
    const res = url.match(/RESOLUTION=(\d+)x(\d+)/);
    if (res) return `${res[1]}x${res[2]}`;
    return 'Unknown';
}

// ---------- Base Extractor ----------
class BaseExtractor {
    constructor() {
        this.logs = [];
    }
    log(message, level = 'info') {
        this.logs.push(`[${level.toUpperCase()}] ${message}`);
        logger.info(message);
    }
}

// ---------- VidAPI Extractor ----------
class VidAPIExtractor extends BaseExtractor {
    constructor() {
        super();
        this.baseUrl = 'https://streamdata.vaplayer.ru/api.php';
        this.client = new CffiClient({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0',
                'Accept': 'application/json',
                'Origin': 'https://vaplayer.ru',
                'Referer': 'https://nextgencloudfabric.com/',
            },
        });
    }

    async extract(tmdbId, mediaType, season = 1, episode = 1, progress, isCancelled) {
        this.log(`VidAPI: requesting streams for ${mediaType} ${tmdbId}`);
        if (progress) await progress('Fetching VidAPI streams...');
        const params = { tmdb: tmdbId, type: mediaType };
        if (mediaType === 'tv') {
            params.season = season;
            params.episode = episode;
        }
        try {
            const resp = await this.client.get(this.baseUrl, { params });
            const data = resp.data;
            if (data.status_code !== '200') throw new Error(data.error || 'Unknown error');
            const streamUrls = data.data?.stream_urls || [];
            if (!streamUrls.length) throw new Error('No streams');
            this.log(`VidAPI: got ${streamUrls.length} stream(s)`);
            if (progress) await progress(`Received ${streamUrls.length} stream URLs. Fetching master playlists...`);

            const headers = { 'Referer': 'https://nextgencloudfabric.com/', 'Origin': 'https://vaplayer.ru' };
            const allVariants = [];

            for (const url of streamUrls) {
                if (isCancelled && isCancelled()) throw new Error('Cancelled');
                if (progress) await progress(`Fetching variants from ${url.slice(0, 50)}...`);
                const variants = await fetchHlsVariants(url, headers, this.client);
                if (isCancelled && isCancelled()) throw new Error('Cancelled');
                allVariants.push(...variants);
            }

            if (allVariants.length) {
                allVariants.sort((a, b) => {
                    const getWidth = q => { const m = q.match(/(\d+)x(\d+)/); return m ? parseInt(m[1]) : 0; };
                    return getWidth(b.quality) - getWidth(a.quality);
                });
                if (progress) await progress(`Found ${allVariants.length} total variants.`);
                return {
                    raw_stream_url: allVariants[0].url,
                    quality: allVariants[0].quality,
                    variants: allVariants,
                    subtitles: data.data?.default_subs || [],
                    source: 'VidAPI',
                };
            } else {
                const variants = streamUrls.map(url => ({ quality: getQualityFromUrl(url), url }));
                if (progress) await progress('No master playlists found. Using direct URLs...');
                return {
                    raw_stream_url: variants[0].url,
                    quality: variants[0].quality,
                    variants,
                    subtitles: data.data?.default_subs || [],
                    source: 'VidAPI',
                };
            }
        } catch (e) {
            this.log(`VidAPI error: ${e.message}`, 'error');
            return { error: e.message };
        }
    }
}

// ---------- VidSrc Extractor ----------
class VidSrcExtractor extends BaseExtractor {
    constructor() {
        super();
        this.client = new CffiClient({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://vsembed.ru/',
                'Accept': 'application/json',
            },
        });
        this.tokenUrl = 'https://capricornconclave.site/generate.php';
        this.token = null;
        this.tokenExpiry = 0;
    }

    async getToken() {
        const now = Date.now() / 1000;
        if (this.token && this.tokenExpiry > now + 60) return this.token;
        try {
            const resp = await this.client.get(this.tokenUrl);
            const token = resp.text.trim();
            if (!token) throw new Error('Empty token');
            let exp = now + 300;
            try {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
                if (payload.exp) exp = payload.exp;
            } catch {}
            this.token = token;
            this.tokenExpiry = exp;
            return token;
        } catch (e) {
            throw new Error(`Token fetch failed: ${e.message}`);
        }
    }

    appendToken(url, token) {
        return url.includes('?') ? `${url}&token=${token}` : `${url}?token=${token}`;
    }

    async _getDecryptedUrls(wasmUrl, encB64) {
        const resp = await this.client.get(wasmUrl, { responseType: 'arraybuffer' });
        const wasmBuffer = resp.data;
        const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
        const exports = instance.exports;
        if (!exports.alloc || !exports.decrypt || !exports.memory) {
            throw new Error('WASM exports missing');
        }
        const cipherBytes = Buffer.from(encB64, 'base64');
        const cipherLen = cipherBytes.length;
        const ptr = exports.alloc(cipherLen);
        const memView = new Uint8Array(exports.memory.buffer);
        memView.set(cipherBytes, ptr);
        const outLen = exports.decrypt(ptr, cipherLen);
        const resultView = new Uint8Array(exports.memory.buffer, ptr + 12, outLen);
        const decryptedText = Buffer.from(resultView).toString('utf-8');
        return decryptedText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    }

    async extract(tmdbId, mediaType, season = 1, episode = 1, progress, isCancelled) {
        this.log(`VidSrc: fetching ${mediaType} ${tmdbId}`);
        if (progress) await progress('Fetching VidSrc streams...');
        try {
            const base = mediaType === 'tv'
                ? `https://data.vidsrcme.ru/api.php?type=tv&tmdb=${tmdbId}&season=${season}&episode=${episode}&stream_urls`
                : `https://data.vidsrcme.ru/api.php?type=movie&tmdb=${tmdbId}&stream_urls`;
            const resp = await this.client.get(base);
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
            const data = resp.data;
            if (data.status_code !== '200' && !data.success) throw new Error(`API returned status ${data.status_code}`);
            let streamUrls = data.data?.stream_urls;
            if (!streamUrls) throw new Error('No stream_urls field');

            if (!Array.isArray(streamUrls)) {
                const wasmUrl = data.vs?.wasm_url;
                if (!wasmUrl) throw new Error('Missing WASM URL');
                if (progress) await progress('Decrypting VidSrc URLs...');
                const decryptedUrls = await this._getDecryptedUrls(wasmUrl, streamUrls);
                if (!decryptedUrls.length) throw new Error('No URLs after decryption');
                streamUrls = decryptedUrls;
                if (progress) await progress(`Decrypted ${streamUrls.length} URLs.`);
            }

            // Sort by quality from URL pattern (fallback)
            const qualityScore = u => { const m = u.match(/(\d{3,4})p/); return m ? parseInt(m[1]) : 0; };
            const sorted = [...streamUrls].sort((a, b) => qualityScore(b) - qualityScore(a));

            if (progress) await progress('Getting access token...');
            const token = await this.getToken();
            if (isCancelled && isCancelled()) throw new Error('Cancelled');

            if (progress) await progress('Resolving final stream URLs...');
            const variants = [];
            const limit = 3; // concurrency for resolving
            const mapper = async (url) => {
                const tokenUrl = this.appendToken(url, token);
                // Follow redirects to get final URL
                let finalUrl = tokenUrl;
                try {
                    const resp = await this.client.get(tokenUrl, { headers: { 'Referer': 'https://vsembed.ru/' } });
                    if (resp.request?.url) {
                        finalUrl = resp.request.url;
                    }
                    // Try to get actual quality if final URL is a master playlist
                    let quality = getQualityFromUrl(finalUrl); // fallback
                    if (isMasterPlaylist(resp.text)) {
                        const lines = resp.text.split(/\r?\n/);
                        for (const line of lines) {
                            if (line.startsWith('#EXT-X-STREAM-INF')) {
                                const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
                                if (res) {
                                    quality = `${res[1]}x${res[2]}`;
                                    break;
                                }
                            }
                        }
                    }
                    return { quality, url: finalUrl };
                } catch (e) {
                    // If request fails, fall back to the token URL and guessed quality
                    return { quality: getQualityFromUrl(tokenUrl), url: tokenUrl };
                }
            };

            // Process with limited concurrency
            const results = await mapLimit(sorted, limit, async (url) => mapper(url));
            variants.push(...results);

            if (!variants.length) throw new Error('No valid variants');

            // Sort by resolution width
            variants.sort((a, b) => {
                const getWidth = q => { const m = q.match(/(\d+)x(\d+)/); return m ? parseInt(m[1]) : 0; };
                return getWidth(b.quality) - getWidth(a.quality);
            });

            if (progress) await progress(`Prepared ${variants.length} final stream URLs.`);
            return {
                raw_stream_url: variants[0].url,
                quality: variants[0].quality,
                variants,
                subtitles: [],
                source: 'VidSrc',
            };
        } catch (e) {
            this.log(`VidSrc error: ${e.message}`, 'error');
            return { error: e.message };
        }
    }
}

// ---------- VidEasy Extractor ----------
class VidEasyExtractor extends BaseExtractor {
    constructor() {
        super();
        this.client = new CffiClient({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://player.videasy.to/',
                'Origin': 'https://player.videasy.to',
            },
        });
        this.seedCache = new Map();
        this.sourcesConfig = [
            { name: 'Yoru', path: '/vsrc/sources-with-title', filter: null },
            { name: 'Cypher', path: '/downloader2/sources-with-title', filter: null },
            { name: 'Breach', path: '/m4uhd/sources-with-title', filter: null },
            { name: 'Neon', path: '/cdn/sources-with-title', filter: null },
            { name: 'Vyse', path: '/hdmovie/sources-with-title', filter: 'English' },
            { name: 'Killjoy', path: '/meine/sources-with-title', filter: null },
            { name: 'Fade', path: '/hdmovie/sources-with-title', filter: 'Hindi' },
            { name: 'Omen', path: '/lamovie/sources-with-title', filter: null },
            { name: 'Raze', path: '/superflix/sources-with-title', filter: null },
        ];
    }

    u32(val) { return val >>> 0; }
    imul(a, b) {
        const ah = (a >>> 16) & 0xffff, al = a & 0xffff;
        const bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) >>> 0;
    }
    rotl(val, shift) {
        shift &= 31;
        if (shift === 0) return this.u32(val);
        return this.u32(((val << shift) | (val >>> (32 - shift))));
    }
    bTransform(val) {
        val = this.u32(val);
        val = this.u32(val ^ (val >>> 16));
        val = this.u32(this.imul(val, 2246822507));
        val = this.u32(val ^ (val >>> 13));
        val = this.u32(this.imul(val, 3266489909));
        val = this.u32(val ^ (val >>> 16));
        return this.u32(val);
    }
    isEvenParity(e) { return !(((e * (e + 1)) & 1)); }

    decryptPayload(cipherB64, seed, mediaId) {
        let s = cipherB64.trim().replace(/^"|"$/g, '').replace(/-/g, '+').replace(/_/g, '/');
        s += '='.repeat((4 - s.length % 4) % 4);
        const rawCipher = Buffer.from(s, 'base64');
        const cipherLen = rawCipher.length;
        if (cipherLen < 4) throw new Error('Cipher too short');
        let t = 2166136261;
        for (const char of seed) t = this.u32(this.imul(t ^ char.charCodeAt(0), 16777619));
        t = this.bTransform(t);
        const mediaIdVal = /^\d+$/.test(String(mediaId)) ? parseInt(mediaId) : 0;
        const mediaB = this.bTransform(this.u32(mediaIdVal ^ 2654435769));
        t = this.bTransform(this.u32(t ^ mediaB));

        const G_TABLE = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580];
        const state = new Array(61).fill(null);
        for (let e = 0; e < 8; e++) {
            if (this.isEvenParity(e)) {
                const idx = t % 61;
                t = this.rotl(this.u32(t + 2654435769), 7 + (7 & e));
                state[idx] = this.u32(t ^ this.bTransform(t));
                t = this.bTransform(this.u32(t + idx));
            } else {
                state[e] = G_TABLE[15 & e];
            }
        }
        let acc = this.bTransform(2779096485 ^ t);
        const keystream = Buffer.alloc(cipherLen);
        let offset = 0, counter = 0;
        while (offset < cipherLen) {
            const n = acc % 61;
            const idx = n;
            let sVal;
            let iFlag;
            if (state[idx] !== null) {
                const d = state[idx];
                iFlag = 0xFFFFFFFF;
                sVal = this.u32(d ^ this.imul(2654435769, counter + 1));
            } else {
                iFlag = 0;
                sVal = this.u32(this.imul(2654435769, counter + 1));
            }
            const lVal = this.u32(this.u32(acc ^ sVal) | this.u32(acc & sVal & iFlag));
            const shifted = this.rotl(this.u32(lVal + acc), 31 & n);
            const shifted2 = this.rotl(acc, 31 & this.imul(n, 7));
            acc = this.bTransform(this.u32(this.u32(shifted ^ shifted2) + 2654435769));
            state[idx] = acc;
            const word = acc;
            keystream[offset] = word & 0xff;
            if (offset + 1 < cipherLen) keystream[offset + 1] = (word >>> 8) & 0xff;
            if (offset + 2 < cipherLen) keystream[offset + 2] = (word >>> 16) & 0xff;
            if (offset + 3 < cipherLen) keystream[offset + 3] = (word >>> 24) & 0xff;
            offset += 4;
            counter++;
        }
        const decrypted = Buffer.alloc(cipherLen);
        for (let i = 0; i < cipherLen; i++) decrypted[i] = rawCipher[i] ^ keystream[i];
        if (decrypted.slice(0, 4).toString() !== 'mvm1') {
            throw new Error('Bad seed');
        }
        return decrypted.slice(4).toString('utf-8');
    }

    async getSeed(tmdbId) {
        const cached = this.seedCache.get(tmdbId);
        if (cached && cached.expires > Date.now()) return cached.seed;
        const resp = await this.client.get(`https://api.speedracelight.com/seed?mediaId=${tmdbId}`);
        const seed = resp.data.seed;
        if (!seed) throw new Error('No seed');
        this.seedCache.set(tmdbId, { seed, expires: Date.now() + 30000 });
        return seed;
    }

    async fetchSource(sourceConf, params, tmdbId, progress, isCancelled) {
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
        if (progress) await progress(`Fetching ${sourceConf.name}...`);
        const url = `https://api.speedracelight.com${sourceConf.path}`;
        const seed = await this.getSeed(tmdbId);
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
        if (progress) await progress(`Decrypting ${sourceConf.name} payload...`);
        const resp = await this.client.get(url, { params: { ...params, enc: '2', seed } });
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
        const ciphertext = resp.text;
        try {
            const decryptedJson = this.decryptPayload(ciphertext, seed, tmdbId);
            const data = JSON.parse(decryptedJson);
            let sources = data.sources || [];
            const subtitles = data.subtitles || [];
            if (sourceConf.filter) {
                const filtered = sources.filter(s => s.quality === sourceConf.filter);
                if (filtered.length) sources = filtered;
            }
            if (progress) await progress(`${sourceConf.name}: found ${sources.length} sources.`);
            return { sources, subtitles, sourceName: sourceConf.name };
        } catch (e) {
            try {
                const data = JSON.parse(ciphertext);
                let sources = data.sources || [];
                const subtitles = data.subtitles || [];
                if (sourceConf.filter) {
                    const filtered = sources.filter(s => s.quality === sourceConf.filter);
                    if (filtered.length) sources = filtered;
                }
                if (progress) await progress(`${sourceConf.name}: unencrypted response, ${sources.length} sources.`);
                return { sources, subtitles, sourceName: sourceConf.name };
            } catch (e2) {
                throw e;
            }
        }
    }

    async extract(tmdbId, title, year, imdbId, mediaType, season = 1, episode = 1, progress, isCancelled) {
        this.log(`VidEasy: extracting for ${mediaType} ${tmdbId}`);
        if (progress) await progress('Fetching VidEasy streams...');
        const params = {
            title,
            mediaType,
            year,
            episodeId: String(episode),
            seasonId: String(season),
            tmdbId,
            imdbId,
        };
        let best = null;
        let bestQuality = -1;
        for (const sourceConf of this.sourcesConfig) {
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
            try {
                const result = await this.fetchSource(sourceConf, params, tmdbId, progress, isCancelled);
                if (result.sources.length) {
                    if (progress) await progress(`Collecting variants from ${result.sourceName}...`);
                    const variants = result.sources.map(src => ({
                        quality: getQualityFromUrl(src.url),
                        url: src.url,
                    }));
                    for (const v of variants) {
                        const m = v.quality.match(/(\d+)x(\d+)/);
                        const width = m ? parseInt(m[1]) : 0;
                        if (width > bestQuality || (width === 0 && bestQuality === -1)) {
                            bestQuality = width;
                            best = {
                                raw_stream_url: v.url,
                                quality: v.quality,
                                variants,
                                subtitles: result.subtitles,
                                source: 'VidEasy',
                            };
                        }
                    }
                }
            } catch (e) {
                this.log(`${sourceConf.name} error: ${e.message}`, 'error');
                if (progress) await progress(`${sourceConf.name} failed: ${e.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
        }
        if (best) {
            if (progress) await progress('VidEasy extraction complete.');
            return best;
        }
        return { error: 'No suitable source' };
    }
}

// ---------- Mapple Extractor ----------
class MappleStreamFetcher extends BaseExtractor {
    constructor() {
        super();
        this.baseUrl = 'https://mapple.club';
        this.client = new CurlCommandClient({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': this.baseUrl + '/',
            'Origin': this.baseUrl,
        });
        this.requestToken = null;
        this.sources = ['mapple','s25','s2','s19','s13','s26','s4','s24','s6','s15','s7','s8','s3','s16','s12','s5','s1','s10'];
    }

    async fetchRequestToken(mediaId, mediaType) {
        const url = `${this.baseUrl}/watch/${mediaType}/${mediaId}`;
        const resp = await this.client.get(url);
        const html = resp.text;
        const patterns = [
            /window\.__REQUEST_TOKEN__\s*=\s*["']([^"']+)["']/,
            /__REQUEST_TOKEN__\s*=\s*["']([^"']+)["']/,
        ];
        for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
                this.requestToken = m[1];
                logger.info(`Mapple: extracted requestToken: ${this.requestToken}`);
                return m[1];
            }
        }
        const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = scriptRegex.exec(html)) !== null) {
            const m = match[1].match(/__REQUEST_TOKEN__\s*=\s*["']([^"']+)["']/);
            if (m) {
                this.requestToken = m[1];
                logger.info(`Mapple: extracted requestToken (from script): ${this.requestToken}`);
                return m[1];
            }
        }
        logger.error(`Mapple: Could not find request token. HTML snippet: ${html.slice(0, 500)}`);
        throw new Error('No request token found');
    }

    // Async Proof-of-Work solver with cancellation support
    async solvePoW(challenge, difficulty, isCancelled, maxIter = 50_000_000) {
        const start = Date.now();
        let nonce = 0;
        const fullBytes = Math.floor(difficulty / 8);
        const rem = difficulty % 8;
        const chunkSize = 100000; // yield every 100k iterations

        while (nonce <= maxIter) {
            if (isCancelled && isCancelled()) return null;
            if (Date.now() - start > POW_TIMEOUT * 1000) return null;

            const end = Math.min(nonce + chunkSize, maxIter);
            for (; nonce < end; nonce++) {
                const data = crypto.createHash('sha256').update(challenge + nonce).digest();
                let ok = true;
                for (let i = 0; i < fullBytes; i++) {
                    if (data[i] !== 0) { ok = false; break; }
                }
                if (ok && rem) {
                    const mask = 0xff << (8 - rem);
                    if ((data[fullBytes] & mask) !== 0) ok = false;
                }
                if (ok) return nonce;
            }
            // Yield to event loop to allow cancel
            await new Promise(resolve => setImmediate(resolve));
        }
        return null;
    }

    async getStreamToken(mediaId, mediaType, progress, isCancelled) {
        const checkCancelled = () => {
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
        };

        checkCancelled();
        if (!this.requestToken) {
            if (progress) await progress('Extracting request token...');
            await this.fetchRequestToken(mediaId, mediaType);
            checkCancelled();
            if (progress) await progress('Request token obtained.');
        }

        const url = `${this.baseUrl}/api/playback-init`;
        let payload = { mediaId, mediaType, requestToken: this.requestToken };
        logger.info(`Mapple: playback-init payload: ${JSON.stringify(payload)}`);
        if (progress) await progress('Requesting stream token...');
        let resp = await this.client.post(url, { data: payload });
        checkCancelled();
        logger.info(`Mapple: playback-init response: ${resp.text}`);
        let data = resp.data;

        if (data?.success) {
            if (data.requiresPow && data.pow) {
                if (progress) await progress(`Solving PoW (difficulty ${data.pow.difficulty})...`);
                const nonce = await this.solvePoW(data.pow.challenge, data.pow.difficulty, isCancelled);
                checkCancelled();
                if (nonce === null) {
                    if (isCancelled && isCancelled()) throw new Error('Cancelled');
                    throw new Error('PoW timeout');
                }
                payload.pow = { challengeId: data.pow.challengeId, nonce: String(nonce) };
                logger.info(`Mapple: submitting PoW nonce: ${nonce}`);
                if (progress) await progress(`PoW solved with nonce ${nonce}. Submitting...`);
                resp = await this.client.post(url, { data: payload });
                checkCancelled();
                logger.info(`Mapple: PoW response: ${resp.text}`);
                data = resp.data;
                if (data.success && data.token) {
                    if (progress) await progress('Stream token received.');
                    return data.token;
                }
                throw new Error(data.error || 'PoW verification failed');
            } else if (data.token) {
                if (progress) await progress('Stream token received.');
                return data.token;
            } else {
                throw new Error('Unexpected success without token');
            }
        } else {
            throw new Error(data?.error || 'playback-init error');
        }
    }

    async getEncryptedUrl(mediaId, mediaType, tvSlug = '', source = 'mapple', progress, isCancelled) {
        const checkCancelled = () => {
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
        };
        checkCancelled();
        if (!this.requestToken) {
            await this.fetchRequestToken(mediaId, mediaType);
            checkCancelled();
        }
        const url = `${this.baseUrl}/api/encrypt`;
        const payload = {
            data: { mediaId, mediaType, tv_slug: tvSlug, source },
            endpoint: 'stream-encrypted',
            requestToken: this.requestToken,
        };
        if (progress) await progress(`Requesting encrypted URL from source: ${source}`);
        const resp = await this.client.post(url, { data: payload });
        checkCancelled();
        logger.info(`Mapple: encrypt response: ${resp.text}`);
        const data = resp.data;
        if (!data.url) throw new Error('No URL in encrypt response');
        return { url: data.url };
    }

    async getStreamUrl(encryptedUrl, streamToken, progress, isCancelled) {
        const checkCancelled = () => {
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
        };
        checkCancelled();
        const sep = encryptedUrl.includes('?') ? '&' : '?';
        const fullUrl = `${this.baseUrl}${encryptedUrl}${sep}requestToken=${this.requestToken}&token=${streamToken}`;
        if (progress) await progress('Decrypting stream URL...');
        const resp = await this.client.get(fullUrl);
        checkCancelled();
        const data = resp.data;
        if (data?.success && data.data?.stream_url) {
            if (progress) await progress('Stream URL decrypted.');
            return { success: true, stream_url: data.data.stream_url, source: data.data.source };
        }
        return { success: false, error: data?.error || 'Unknown error' };
    }

    async extract(mediaId, mediaType, season = 1, episode = 1, progress, isCancelled) {
        const checkCancelled = () => {
            if (isCancelled && isCancelled()) throw new Error('Cancelled');
        };
        this.log(`Mapple: starting extraction for ${mediaType} ${mediaId}`);
        if (progress) await progress('Starting Mapple extraction...');
        checkCancelled();

        try {
            this.requestToken = null;
            const streamToken = await this.getStreamToken(mediaId, mediaType, progress, isCancelled);
            checkCancelled();
            const tvSlug = mediaType === 'tv' ? `${season}-${episode}` : '';
            for (const source of this.sources) {
                checkCancelled();
                try {
                    if (progress) await progress(`Trying source: ${source}`);
                    checkCancelled();
                    const enc = await this.getEncryptedUrl(mediaId, mediaType, tvSlug, source, progress, isCancelled);
                    checkCancelled();
                    const res = await this.getStreamUrl(enc.url, streamToken, progress, isCancelled);
                    checkCancelled();
                    if (res.success) {
                        const rawUrl = res.stream_url;
                        const headers = { 'Referer': 'https://mapple.club/', 'Origin': 'https://mapple.club' };
                        if (progress) await progress('Fetching HLS variants...');
                        checkCancelled();
                        const variants = await fetchHlsVariants(rawUrl, headers, this.client);
                        checkCancelled();
                        if (variants.length) {
                            variants.sort((a, b) => {
                                const getWidth = q => { const m = q.match(/(\d+)x(\d+)/); return m ? parseInt(m[1]) : 0; };
                                return getWidth(b.quality) - getWidth(a.quality);
                            });
                            if (progress) await progress(`Found ${variants.length} variants.`);
                            return {
                                raw_stream_url: variants[0].url,
                                quality: variants[0].quality,
                                variants,
                                subtitles: [],
                                source: 'Mapple',
                            };
                        }
                        if (progress) await progress('No master playlist. Using single URL.');
                        return {
                            raw_stream_url: rawUrl,
                            quality: getQualityFromUrl(rawUrl),
                            variants: [{ quality: getQualityFromUrl(rawUrl), url: rawUrl }],
                            subtitles: [],
                            source: 'Mapple',
                        };
                    }
                } catch (e) {
                    this.log(`Source ${source} error: ${e.message}`, 'error');
                    if (progress) await progress(`Source ${source} failed: ${e.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
                checkCancelled();
            }
            return { error: 'No working source' };
        } catch (e) {
            this.log(`Mapple fatal error: ${e.message}`, 'error');
            if (progress) await progress(`Mapple failed: ${e.message}`);
            return { error: e.message };
        } finally {
            this.client.cleanup();
        }
    }
}

// ---------- Metadata ----------
async function getMetadata(tmdbId, mediaType) {
    try {
        if (mediaType === 'tv') {
            const url = `https://db.speedracelight.com/3/tv/${tmdbId}?append_to_response=external_ids`;
            const client = new CffiClient();
            const resp = await client.get(url);
            const data = resp.data;
            return {
                title: data.name || '',
                year: (data.first_air_date || '').slice(0, 4),
                imdbId: data.external_ids?.imdb_id || '',
            };
        } else {
            const url = `${TMDB_BASE}/movie/${tmdbId}`;
            const client = new CffiClient();
            const resp = await client.get(url, { params: { api_key: TMDB_API_KEY } });
            const data = resp.data;
            return {
                title: data.title || '',
                year: (data.release_date || '').slice(0, 4),
                imdbId: data.imdb_id || '',
            };
        }
    } catch {
        return { title: '', year: '', imdbId: '' };
    }
}

// ---------- Bot Setup ----------
const bot = new Telegraf(BOT_TOKEN);
let totalRequests = 0;
const pendingParams = new Map();
const cancelFlags = new Map(); // chatId -> true if cancelled

async function editProgress(ctx, chatId, messageId, text, extra = {}) {
    try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, text, extra);
    } catch (e) {
        // ignore
    }
}

// ---------- Handlers ----------
bot.start(ctx => {
    logUserActivity(ctx, 'command', '/start');
    return ctx.reply(
        '👋 Hi! Send /get <tmdb_id> [movie|tv] [season] [episode] to fetch streams.\n' +
        'Example: /get 1147301 movie\n' +
        'For TV: /get 12345 tv 1 2'
    );
});

bot.help(ctx => {
    logUserActivity(ctx, 'command', '/help');
    return ctx.reply('Send /get <tmdb_id> [movie|tv] [season] [episode] to fetch streams.');
});

bot.command('get', async ctx => {
    logUserActivity(ctx, 'command', '/get ' + ctx.message.text.split(' ').slice(1).join(' '));
    totalRequests++;
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Please provide a TMDB ID.');
    const tmdbId = args[0];
    const mediaType = args.length > 1 ? args[1].toLowerCase() : 'movie';
    const season = args.length > 2 && mediaType === 'tv' ? parseInt(args[2]) : 1;
    const episode = args.length > 3 && mediaType === 'tv' ? parseInt(args[3]) : 1;
    if (!['movie', 'tv'].includes(mediaType)) return ctx.reply("Media type must be 'movie' or 'tv'.");

    pendingParams.set(ctx.chat.id, { tmdbId, mediaType, season, episode, statusMsgId: null });
    cancelFlags.delete(ctx.chat.id); // reset cancellation flag

    const keyboard = [
        [
            { text: 'VidAPI', callback_data: 'provider:vidapi' },
            { text: 'VidSrc', callback_data: 'provider:vidsrc' },
        ],
        [
            { text: 'VidEasy', callback_data: 'provider:videasy' },
            { text: 'Mapple', callback_data: 'provider:mapple' },
        ],
    ];
    return ctx.reply('Select provider:', { reply_markup: { inline_keyboard: keyboard } });
});

bot.action(/^provider:(.+)$/, async ctx => {
    // Answer immediately to avoid expiration
    ctx.answerCbQuery().catch(() => {});
    const provider = ctx.match[1];
    const chatId = ctx.chat.id;

    // Clear any stale cancel flag before starting new extraction
    cancelFlags.delete(chatId);

    const params = pendingParams.get(chatId);
    if (!params) {
        return ctx.editMessageText('Session expired. Please /get again.').catch(() => {});
    }

    // Cancel button markup
    const cancelMarkup = {
        reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: `cancel:${chatId}` }]]
        }
    };

    let messageId = params.statusMsgId;
    if (messageId) {
        try {
            await ctx.telegram.editMessageText(chatId, messageId, undefined, `🔄 Fetching from ${provider}...`, cancelMarkup);
        } catch (e) {
            messageId = null;
        }
    }
    if (!messageId) {
        try {
            const statusMsg = await ctx.reply(`🔄 Fetching from ${provider}...`, cancelMarkup);
            messageId = statusMsg.message_id;
            params.statusMsgId = messageId;
            pendingParams.set(chatId, params);
        } catch (e) {
            return;
        }
    }

    // Set up cancellation check
    const isCancelled = () => cancelFlags.get(chatId) === true;

    const progress = async (text) => {
        if (isCancelled()) throw new Error('Cancelled');
        await editProgress(ctx, chatId, messageId, `🔄 ${text}`, cancelMarkup);
    };

    try {
        let result;
        if (provider === 'vidapi') {
            const extractor = new VidAPIExtractor();
            result = await extractor.extract(params.tmdbId, params.mediaType, params.season, params.episode, progress, isCancelled);
        } else if (provider === 'vidsrc') {
            const extractor = new VidSrcExtractor();
            result = await extractor.extract(params.tmdbId, params.mediaType, params.season, params.episode, progress, isCancelled);
        } else if (provider === 'videasy') {
            await progress('Fetching metadata...');
            const meta = await getMetadata(params.tmdbId, params.mediaType);
            const extractor = new VidEasyExtractor();
            result = await extractor.extract(params.tmdbId, meta.title, meta.year, meta.imdbId, params.mediaType, params.season, params.episode, progress, isCancelled);
        } else if (provider === 'mapple') {
            const extractor = new MappleStreamFetcher();
            result = await extractor.extract(parseInt(params.tmdbId), params.mediaType, params.season, params.episode, progress, isCancelled);
        } else {
            await editProgress(ctx, chatId, messageId, 'Unknown provider.');
            return;
        }

        if (result?.error) {
            await editProgress(ctx, chatId, messageId, `❌ ${result.error}`);
            return;
        }

        const rawUrl = result.raw_stream_url;
        const variants = result.variants || [];
        const subtitles = result.subtitles || [];
        const quality = result.quality || 'Unknown';

        // Prepare result message: short text + inline keyboard buttons for each quality
        let msgText = `✅ Provider: ${provider}\nQuality: ${quality}\n`;
        if (subtitles.length) msgText += `Subtitles: ${subtitles.length} track(s)\n`;

        const buttons = [];
        // Add variant buttons (max 50 to avoid Telegram limits)
        for (const v of variants.slice(0, 50)) {
            buttons.push([{ text: v.quality, url: v.url }]);
        }
        // Also add a direct URL button if we have a raw URL (maybe duplicate)
        if (rawUrl) {
            buttons.push([{ text: 'Direct URL', url: rawUrl }]);
        }

        const resultMarkup = {
            reply_markup: {
                inline_keyboard: buttons
            }
        };

        // Edit the status message to final result, removing cancel button and adding quality buttons
        await ctx.telegram.editMessageText(chatId, messageId, undefined, msgText, resultMarkup);
    } catch (e) {
        logger.error('Provider error:', e);
        if (e.message === 'Cancelled') {
            // Do nothing; cancel handler already updated the message
        } else {
            await ctx.telegram.editMessageText(chatId, messageId, undefined, `❌ Error: ${e.message}`);
        }
    } finally {
        cancelFlags.delete(chatId); // clean up flag
    }
});

// Cancel button handler
bot.action(/^cancel:(.+)$/, async ctx => {
    const chatId = parseInt(ctx.match[1]);
    cancelFlags.set(chatId, true);   // signal cancellation
    logger.info(`Cancel pressed for chat ${chatId}`);
    await ctx.answerCbQuery('Cancelling...').catch(() => {});
    try {
        await ctx.editMessageText('❌ Cancelled');
    } catch (e) {
        // ignore
    }
});

bot.command('admin', async ctx => {
    logUserActivity(ctx, 'command', '/admin');
    if (ctx.from.id !== ADMIN_USER_ID) return ctx.reply('⛔ Not authorized.');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length && /^\d+$/.test(args[0])) {
        const uid = parseInt(args[0]);
        const data = userActivityLog.get(uid);
        if (!data) return ctx.reply('No data for this user.');
        const info = data.info;
        const acts = data.activities;
        let msg = `User ID: ${info.user_id}\n`;
        msg += `Username: @${info.username || 'N/A'}\n`;
        msg += `Name: ${info.full_name}\n`;
        msg += `Activities: ${acts.length}\n`;
        msg += 'Last 20:\n';
        for (const a of acts.slice(-20)) msg += `[${a.timestamp}] ${a.type}: ${a.text.slice(0, 80)}\n`;
        return ctx.reply(msg);
    } else {
        const totalUsers = userActivityLog.size;
        const totalActs = [...userActivityLog.values()].reduce((sum, d) => sum + d.activities.length, 0);
        let msg = `🛠 Admin Panel\n`;
        msg += `Users: ${totalUsers}\n`;
        msg += `Total activities: ${totalActs}\n`;
        msg += `Stream requests: ${totalRequests}\n`;
        msg += 'Users:\n';
        for (const [uid, data] of userActivityLog.entries()) {
            msg += `  ${uid} - @${data.info.username || 'N/A'} (${data.info.full_name})\n`;
        }
        return ctx.reply(msg);
    }
});

bot.on('text', () => {});

// ---------- Main ----------
bot.launch().then(() => {
    logger.info('Bot started');
}).catch(err => {
    logger.error('Bot launch failed:', err);
    process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
