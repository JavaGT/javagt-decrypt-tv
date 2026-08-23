import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectManifestUrl } from '../src/n3u8dl-node/index.mjs';

test('manifest inspection passes request headers to the manifest fetch', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return new Response('<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" height="720" /></AdaptationSet></Period></MPD>', {
            status: 200,
            headers: { 'content-type': 'application/dash+xml' }
        });
    };
    try {
        const report = await inspectManifestUrl('https://media.example/manifest.mpd', {
            requestHeaders: { Authorization: 'Bearer test' }
        });
        assert.equal(typeof report.manifestType, 'string');
        assert.equal(request.options.headers.Authorization, 'Bearer test');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
