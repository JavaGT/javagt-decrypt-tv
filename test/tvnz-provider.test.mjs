import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPlaybackRequestHeaders, credentialsFrom, loadCredentials, parseUrl, persistRotatedSession, resolvePlayback, runTvnzWorkflow, TvnzProvider } from '../src/providers/tvnz-provider.mjs';

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
