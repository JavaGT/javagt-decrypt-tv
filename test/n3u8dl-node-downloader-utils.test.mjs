import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    createRetryConfig,
    toSafeName,
    mergeManifestQueryParams,
    applyManifestQueryParams,
    ensureDir,
    runPool,
    resolveExecutable
} from '../src/n3u8dl-node/lib/downloader-utils.mjs';

test('createRetryConfig preserves timeout retries and headers', () => {
    const config = createRetryConfig({
        timeoutMs: 123,
        retries: 4,
        headers: { Accept: 'application/json' }
    });

    assert.deepEqual(config, {
        timeoutMs: 123,
        retries: 4,
        headers: { Accept: 'application/json' }
    });
});

test('toSafeName sanitizes filesystem-unsafe names', () => {
    assert.equal(toSafeName('..bad:/name*'), 'bad.name.');
});

test('mergeManifestQueryParams preserves target query and copies missing params', () => {
    const result = mergeManifestQueryParams(
        'https://example.com/media.m3u8?existing=1',
        'https://example.com/manifest.m3u8?token=abc&existing=2'
    );

    assert.equal(result, 'https://example.com/media.m3u8?existing=1&token=abc');
});

test('applyManifestQueryParams clones init and segment urls', () => {
    const track = {
        initializationUrl: 'https://example.com/init.mp4?foo=1',
        segmentUrls: ['https://example.com/seg1.m4s'],
        segments: [{ url: 'https://example.com/seg2.m4s' }]
    };

    const result = applyManifestQueryParams(track, 'https://example.com/manifest.mpd?token=abc');

    assert.equal(result.initializationUrl.includes('token=abc'), true);
    assert.equal(result.segmentUrls[0].includes('token=abc'), true);
    assert.equal(result.segments[0].url.includes('token=abc'), true);
    assert.notEqual(result, track);
});

test('ensureDir creates nested directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n3u8dl-node-'));
    const nested = path.join(dir, 'a', 'b', 'c');

    ensureDir(nested);

    assert.equal(fs.existsSync(nested), true);
});

test('runPool processes all items', async () => {
    const seen = [];
    await runPool([1, 2, 3], 2, async (item) => {
        seen.push(item);
    });

    assert.deepEqual(seen.sort(), [1, 2, 3]);
});

test('resolveExecutable prefers candidate over fallback', () => {
    assert.equal(resolveExecutable('/custom/mp4decrypt', 'mp4decrypt'), '/custom/mp4decrypt');
    assert.equal(resolveExecutable('', 'mp4decrypt'), 'mp4decrypt');
});
