import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPlaybackRequestHeaders, credentialsFrom, isRecoverableSessionError, loadCredentials, parseUrl, persistRotatedSession, resolvePlayback, resolvePlaybackWithRecovery, runTvnzWorkflow, TvnzProvider } from '../src/providers/tvnz-provider.mjs';

test('TVNZ URL adapter maps episode and sport URLs without protocol logic', () => {
    assert.deepEqual(parseUrl('https://www.tvnz.co.nz/shows/example-show/episodes/s2-e4'), {
        kind: 'episode',
        slug: 'example-show/episodes/s2-e4',
        series: 'example-show',
        contentTypeId: 'vod',
        catalogType: 'tvepisode'
    });
    assert.deepEqual(parseUrl('https://www.tvnz.co.nz/sport/foo/bar/live-match'), {
        kind: 'sport', contentTypeId: 'sport', catalogType: 'sport', contentId: 'live-match'
    });
});

test('TVNZ adapter delegates catalog and playback to the shared client', async () => {
    const calls = [];
    const client = {
        series: { getEpisode: async (slug) => { calls.push(['episode', slug]); return { id: 'cms-uuid', slug: 'catalog-slug', raw: { nu: 'raw-slug' } }; } },
        playback: { authorize: async (...args) => { calls.push(['authorize', ...args]); return { contentUrl: 'manifest', licenseUrl: 'license' }; } }
    };

    const result = await resolvePlayback(client, 'https://www.tvnz.co.nz/shows/example/episodes/s1-e2');
    assert.deepEqual(calls, [
        ['episode', 'example/episodes/s1-e2'],
        ['authorize', 'catalog-slug', 'vod', 'tvepisode']
    ]);
    assert.equal(result.contentUrl, 'manifest');
});

test('recoverable session errors are narrowly identified', () => {
    assert.equal(isRecoverableSessionError(new Error('Evergent refresh failed: Authentication Failed')), true);
    assert.equal(isRecoverableSessionError(new Error('session revoked eV2767')), true);
    assert.equal(isRecoverableSessionError(new Error('manifest returned 404')), false);
});

test('resolvePlaybackWithRecovery logs in once and retries a revoked session', async () => {
    const calls = [];
    let attempts = 0;
    const client = {
        setSession: (session) => calls.push(['session', session]),
        series: { getEpisode: async () => ({ slug: 'catalog-slug' }) },
        playback: {
            authorize: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('Evergent refresh failed: Authentication Failed');
                return { contentUrl: 'manifest', licenseUrl: 'license' };
            }
        }
    };

    const result = await resolvePlaybackWithRecovery(client, 'https://www.tvnz.co.nz/shows/example/episodes/s1-e2', {
        email: 'user@example.test',
        emailLogin: async (options) => {
            calls.push(['login', options]);
            return { accessToken: 'fresh-a', refreshToken: 'fresh-r', deviceref: 'fresh-d' };
        }
    });

    assert.equal(result.licenseUrl, 'license');
    assert.equal(attempts, 2);
    assert.deepEqual(calls, [
        ['login', { email: 'user@example.test' }],
        ['session', { accessToken: 'fresh-a', refreshToken: 'fresh-r', deviceref: 'fresh-d' }]
    ]);
});

test('resolvePlaybackWithRecovery does not login without an account email', async () => {
    let attempts = 0;
    const client = {
        series: { getEpisode: async () => ({ slug: 'catalog-slug' }) },
        playback: { authorize: async () => { attempts += 1; throw new Error('Authentication Failed'); } }
    };

    await assert.rejects(
        resolvePlaybackWithRecovery(client, 'https://www.tvnz.co.nz/shows/example/episodes/s1-e2'),
        /Authentication Failed/
    );
    assert.equal(attempts, 1);
});

test('TVNZ inspect auto-recovers a discovered session using TVNZ_EMAIL', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvnz-recovery-'));
    const sessionPath = path.join(directory, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify({
        accessToken: 'old-a', refreshToken: 'old-r', deviceref: 'old-d', extra: 'kept'
    }));

    const previousEmail = process.env.TVNZ_EMAIL;
    const previousSessionFile = process.env.TVNZ_SESSION_FILE;
    const previousFetch = globalThis.fetch;
    let authorizeAttempts = 0;
    let loginOptions;
    const client = {
        auth: { playbackHeaders: () => ({}) },
        setSession: () => {},
        playback: {
            authorize: async () => {
                authorizeAttempts += 1;
                if (authorizeAttempts === 1) throw new Error('Evergent refresh failed: Authentication Failed');
                return { contentUrl: 'manifest', licenseUrl: 'license' };
            },
            resolveManifest: async () => 'https://manifest.test/file.mpd'
        }
    };
    const provider = new TvnzProvider({
        emailLogin: async (options) => {
            loginOptions = options;
            return { accessToken: 'fresh-a', refreshToken: 'fresh-r', deviceref: 'fresh-d' };
        }
    });

    process.env.TVNZ_EMAIL = 'user@example.test';
    process.env.TVNZ_SESSION_FILE = sessionPath;
    globalThis.fetch = async () => new Response('<MPD type="static"></MPD>', { status: 200 });
    try {
        await provider.inspect('https://www.tvnz.co.nz/sport/foo/bar/live-match', { client, options: {} });
        assert.deepEqual(loginOptions, { email: 'user@example.test', sessionPath });
        assert.equal(authorizeAttempts, 2);
        assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')), {
            accessToken: 'fresh-a', refreshToken: 'fresh-r', deviceref: 'fresh-d', extra: 'kept'
        });
        assert.equal((await fs.stat(sessionPath)).mode & 0o777, 0o600);
    } finally {
        if (previousEmail === undefined) delete process.env.TVNZ_EMAIL;
        else process.env.TVNZ_EMAIL = previousEmail;
        if (previousSessionFile === undefined) delete process.env.TVNZ_SESSION_FILE;
        else process.env.TVNZ_SESSION_FILE = previousSessionFile;
        globalThis.fetch = previousFetch;
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('TVNZ movie URLs delegate to getMovie and authorize the movie content ID', async () => {
    const calls = [];
    const client = {
        series: { getMovie: async (slug) => { calls.push(['movie', slug]); return { slug: 'movie-slug', raw: { nu: 'raw-movie' } }; } },
        playback: { authorize: async (...args) => { calls.push(['authorize', ...args]); return {}; } }
    };

    await resolvePlayback(client, 'https://www.tvnz.co.nz/shows/example/movie/s1-e2');
    assert.deepEqual(calls, [
        ['movie', 'example/movie/s1-e2'],
        ['authorize', 'movie-slug', 'movie', 'movie']
    ]);
});

test('TVNZ adapter falls back to raw CMS nu for playback contentId', async () => {
    const calls = [];
    const client = {
        series: { getEpisode: async () => ({ id: 'cms-uuid', raw: { nu: 'raw-slug' } }) },
        playback: { authorize: async (...args) => { calls.push(args); return {}; } }
    };

    await resolvePlayback(client, 'https://www.tvnz.co.nz/shows/example/episodes/s1-e2');
    assert.deepEqual(calls, [['raw-slug', 'vod', 'tvepisode']]);
});

test('TVNZ adapter loads credentials from a session file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvnz-session-'));
    const sessionPath = path.join(directory, 'session.json');
    const session = { accessToken: 'access', refreshToken: 'refresh', deviceref: 'device', contactId: 'contact' };
    await fs.writeFile(sessionPath, JSON.stringify(session));

    assert.deepEqual(credentialsFrom({ credentials: sessionPath }, {}), session);
});

test('loadCredentials reports the backing session file', () => {
    const inline = { accessToken: 'a', refreshToken: 'r', deviceref: 'd' };
    assert.deepEqual(loadCredentials({ credentials: inline }, {}).sessionFile, null);
    assert.deepEqual(loadCredentials({}, { accessToken: 'a' }), { credentials: { accessToken: 'a' }, sessionFile: null });
});

test('persistRotatedSession merges rotated tokens into the file atomically', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvnz-rotate-'));
    try {
        const sessionPath = path.join(directory, 'local_storage.json');
        await fs.writeFile(sessionPath, JSON.stringify({ accessToken: 'old', refreshToken: 'old-r', deviceref: 'dev', extra: 'kept' }));

        const changed = persistRotatedSession(sessionPath, { accessToken: 'new', refreshToken: 'new-r', deviceref: 'dev', contactId: 'c1' });
        assert.equal(changed, true);

        const written = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
        assert.equal(written.accessToken, 'new');
        assert.equal(written.refreshToken, 'new-r');
        assert.equal(written.extra, 'kept'); // unrelated fields preserved
        assert.equal(written.contactId, 'c1');
        assert.equal((await fs.readdir(directory)).some((f) => f.includes('.rotate-')), false); // no tmp leftovers

        // Unchanged session is a no-op.
        assert.equal(persistRotatedSession(sessionPath, JSON.parse(await fs.readFile(sessionPath, 'utf8'))), false);
        // No file / no session are safe no-ops.
        assert.equal(persistRotatedSession(null, { accessToken: 'x' }), false);
        assert.equal(persistRotatedSession(sessionPath, null), false);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('persistRotatedSession creates a private session file when none exists', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tvnz-new-session-'));
    try {
        const sessionPath = path.join(directory, 'nested', 'session.json');
        assert.equal(persistRotatedSession(sessionPath, {
            accessToken: 'access', refreshToken: 'refresh', deviceref: 'device'
        }), true);
        const stat = await fs.stat(sessionPath);
        assert.equal(stat.mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')), {
            accessToken: 'access', refreshToken: 'refresh', deviceref: 'device'
        });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('explicit credentials win over ambient TVNZ_EMAIL', async () => {
    let emailCalled = false;
    const client = {
        setSession() {},
        series: { getEpisode: async () => ({ slug: 'catalog-slug' }) },
        playback: {
            authorize: async () => ({ contentUrl: 'm', licenseUrl: 'l' }),
            resolveManifest: async () => 'm'
        }
    };
    process.env.TVNZ_EMAIL = 'someone@example.com';
    try {
        await runTvnzWorkflow('https://www.tvnz.co.nz/shows/example/episodes/s1-e1', {
            client,
            credentials: { accessToken: 'a', refreshToken: 'r', deviceref: 'd' },
            emailLogin: async () => { emailCalled = true; return {}; },
            options: {},
            retention: { addEvent() {}, writeJson() {}, writeRunManifest() {}, writeSummary() {}, writeOutputFiles() {} }
        });
    } catch {
        // Media fetch against the fake manifest URL fails; that's fine —
        // what matters is that the login flow never ran.
    } finally {
        delete process.env.TVNZ_EMAIL;
    }
    assert.equal(emailCalled, false);
});

test('TVNZ playback requests combine browser and shared-client playback headers', () => {
    const headers = buildPlaybackRequestHeaders({
        auth: { playbackHeaders: () => ({ 'x-authorization': 'Bearer ovat', Authorization: 'Bearer oauth' }) }
    });

    assert.equal(headers['x-authorization'], 'Bearer ovat');
    assert.equal(headers.Authorization, 'Bearer oauth');
    assert.equal(headers.Origin, 'https://www.tvnz.co.nz');
});

test('TVNZ SSAI resolution receives shared playback headers', async () => {
    let resolveOptions;
    const client = {
        auth: { playbackHeaders: () => ({ 'x-authorization': 'Bearer ovat' }) },
        setSession: () => {},
        playback: {
            authorize: async () => ({ contentUrl: 'manifest', licenseUrl: 'license', mtSessionUrl: 'ssai' }),
            resolveManifest: async (playback, options) => {
                resolveOptions = options;
                return playback.contentUrl;
            }
        }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" height="720" /></AdaptationSet></Period></MPD>', { status: 200 });
    try {
        await new TvnzProvider().inspect('https://www.tvnz.co.nz/sport/foo/bar/live-match', {
            client,
            credentials: { accessToken: 'access' }
        });
        assert.equal(resolveOptions.headers['x-authorization'], 'Bearer ovat');
        assert.equal(resolveOptions.headers.Origin, 'https://www.tvnz.co.nz');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('TVNZ inspect uses automated email login and the configured session path', async () => {
    let loginOptions;
    let session;
    const client = {
        setSession: (value) => { session = value; },
        playback: {
            authorize: async () => ({ contentUrl: 'manifest', licenseUrl: 'license' }),
            resolveManifest: async (playback) => playback.contentUrl
        }
    };
    const provider = new TvnzProvider({
        emailLogin: async (options) => {
            loginOptions = options;
            return { accessToken: 'access', refreshToken: 'refresh', deviceref: 'device' };
        }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<MPD type="static"></MPD>', { status: 200 });
    try {
        await provider.inspect('https://www.tvnz.co.nz/sport/foo/bar/live-match', {
            client,
            options: { email: 'user@example.test', sessionPath: './custom-session.json' }
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.deepEqual(loginOptions, { email: 'user@example.test', sessionPath: './custom-session.json' });
    assert.equal(session.accessToken, 'access');
});
