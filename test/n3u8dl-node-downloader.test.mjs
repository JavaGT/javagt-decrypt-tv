import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    createDownloaderContext,
    obtainMediaData
} from '../src/n3u8dl-node/index.mjs';

test('obtainMediaData passes request headers to initialization and segment fetches', async () => {
    const originalFetch = globalThis.fetch;
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n3u8dl-node-download-'));
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    try {
        const context = createDownloaderContext({ saveDir: outputDir, saveName: 'fixture' });
        const result = await obtainMediaData({
            inputUrl: 'https://media.example/manifest.mpd',
            requestHeaders: { Authorization: 'Bearer test' },
            retries: 1,
            timeoutMs: 1000,
            threadCount: 1
        }, {
            context,
            resolved: {
                manifestType: 'mpd',
                selectedTracks: {
                    video: {
                        id: 'video',
                        initializationUrl: 'https://media.example/init.mp4',
                        segmentUrls: ['https://media.example/segment-1.m4s']
                    },
                    audio: null,
                    subtitles: []
                }
            }
        });

        assert.equal(result.encryptedPaths.videoPath, path.join(context.workDir, 'video.mp4'));
        assert.deepEqual(requests.map(({ options }) => options.headers.Authorization), [
            'Bearer test',
            'Bearer test'
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
});
