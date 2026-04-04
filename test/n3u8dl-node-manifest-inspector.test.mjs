import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDefaultSelection,
    normalizeInspectionInput,
    mapMpdTracks,
    mapHlsMasterTracks,
    mapHlsMediaTracks
} from '../src/n3u8dl-node/lib/manifest-inspector.mjs';

test('normalizeInspectionInput merges string input and options', () => {
    const result = normalizeInspectionInput('https://example.com/manifest.mpd', {
        selectVideo: 'bestvideo',
        timeoutMs: 1234
    });

    assert.equal(result.inputUrl, 'https://example.com/manifest.mpd');
    assert.equal(result.selectVideo, 'bestvideo');
    assert.equal(result.timeoutMs, 1234);
});

test('buildDefaultSelection picks first video and audio and all subtitles', () => {
    const result = buildDefaultSelection({
        video: [{ id: 'v1' }, { id: 'v2' }],
        audio: [{ id: 'a1' }],
        subtitles: [{ id: 's1' }, { id: 's2' }]
    });

    assert.deepEqual(result, {
        videoIds: ['v1'],
        audioIds: ['a1'],
        subtitleIds: ['s1', 's2']
    });
});

test('mapMpdTracks maps video audio and subtitle tracks', () => {
    const result = mapMpdTracks({
        representations: {
            video: [{ id: 'v1', bandwidth: 1000, width: 640, height: 360, codecs: 'avc1', language: 'en', baseUrl: 'v/', segmentUrls: ['a', 'b'], initializationUrl: 'init' }],
            audio: [{ id: 'a1', bandwidth: 128000, codecs: 'mp4a', language: 'en', baseUrl: 'a/', segmentUrls: ['c'], initializationUrl: 'a-init' }],
            subtitle: [{ id: 's1', language: 'en', mimeType: 'text/vtt', subtitleUrl: 'sub.vtt', baseUrl: 's/' }]
        }
    });

    assert.equal(result.video[0].kind, 'video');
    assert.equal(result.audio[0].kind, 'audio');
    assert.equal(result.subtitles[0].kind, 'subtitle');
    assert.equal(result.video[0].segmentCount, 2);
    assert.equal(result.audio[0].segmentCount, 1);
});

test('mapHlsMasterTracks maps variants and audios', () => {
    const result = mapHlsMasterTracks({
        variants: [{ id: 'v1', bandwidth: 2000, width: 1280, height: 720, codecs: 'avc1', language: 'en', uri: 'video.m3u8', audioGroupId: 'audio' }],
        audios: [{ id: 'a1', language: 'en', codecs: 'mp4a', uri: 'audio.m3u8', groupId: 'audio' }]
    });

    assert.equal(result.video[0].playbackType, 'playlist');
    assert.equal(result.audio[0].playbackType, 'playlist');
    assert.equal(result.subtitles.length, 0);
});

test('mapHlsMediaTracks creates a single playable track', () => {
    const result = mapHlsMediaTracks({
        initializationUrl: 'init.mp4',
        segments: [{ url: 'seg1.ts' }, { url: 'seg2.ts' }]
    }, 'https://example.com/media.m3u8');

    assert.equal(result.video[0].id, 'video');
    assert.equal(result.video[0].segmentCount, 2);
    assert.equal(result.video[0].uri, 'https://example.com/media.m3u8');
});
