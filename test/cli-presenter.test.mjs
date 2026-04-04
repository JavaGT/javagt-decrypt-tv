import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCell, trackSummary, presentTracks } from '../src/adapters/cli-presenter.mjs';

test('formatCell - pads value shorter than width', () => {
    const result = formatCell('ID', 10);
    assert.equal(result, 'ID        ');
    assert.equal(result.length, 10);
});

test('formatCell - returns exact value if equals width', () => {
    const result = formatCell('ABCDEF', 6);
    assert.equal(result, 'ABCDEF');
    assert.equal(result.length, 6);
});

test('formatCell - truncates value longer than width', () => {
    const result = formatCell('ABCDEFGHIJ', 6);
    assert.equal(result, 'ABCDEF');
    assert.equal(result.length, 6);
});

test('formatCell - handles null/undefined as empty string', () => {
    const resultNull = formatCell(null, 5);
    const resultUndef = formatCell(undefined, 5);
    assert.equal(resultNull, '     ');
    assert.equal(resultUndef, '     ');
    assert.equal(resultNull.length, 5);
});

test('formatCell - converts non-string values to string', () => {
    const result = formatCell(123, 6);
    assert.equal(result.includes('123'), true);
});

test('trackSummary - extracts all fields from full track object', () => {
    const track = {
        id: 'v1',
        kind: 'video',
        label: 'HD',
        width: 1920,
        height: 1080,
        bitrate: 5000000,
        language: 'en',
        codecs: 'h264',
        default: true
    };
    const summary = trackSummary(track);
    assert.equal(summary.id, 'v1');
    assert.equal(summary.kind, 'video');
    assert.equal(summary.label, 'HD');
    assert.equal(summary.resolution, '1920x1080');
    assert.equal(summary.bitrate, 5000000);
    assert.equal(summary.language, 'en');
    assert.equal(summary.codecs, 'h264');
    assert.equal(summary.tags, 'default');
});

test('trackSummary - uses fallback values for missing fields', () => {
    const track = { id: 'a1' };
    const summary = trackSummary(track);
    assert.equal(summary.id, 'a1');
    assert.equal(summary.kind, '-');
    assert.equal(summary.label, 'a1');  // label falls back to id
    assert.equal(summary.resolution, '-');
    assert.equal(summary.bitrate, '-');
    assert.equal(summary.language, '-');
    assert.equal(summary.codecs, '-');
    assert.equal(summary.tags, '-');
});

test('trackSummary - uses alternative field names', () => {
    const track = {
        id: 'a1',
        type: 'audio',
        name: 'English',
        bandwidth: 128000,
        lang: 'en',
        codec: 'aac'
    };
    const summary = trackSummary(track);
    assert.equal(summary.kind, 'audio');
    assert.equal(summary.label, 'English');
    assert.equal(summary.bitrate, 128000);
    assert.equal(summary.language, 'en');
    assert.equal(summary.codecs, 'aac');
});

test('trackSummary - handles resolution from width×height', () => {
    const track = { width: 1280, height: 720 };
    assert.equal(trackSummary(track).resolution, '1280x720');
});

test('trackSummary - handles resolution from resolution field', () => {
    const track = { resolution: '720p' };
    assert.equal(trackSummary(track).resolution, '720p');
});

test('trackSummary - handles resolution from size field', () => {
    const track = { size: '480p' };
    assert.equal(trackSummary(track).resolution, '480p');
});

test('trackSummary - collects multiple tags', () => {
    const track = { default: true, forced: true, autoselect: true };
    assert.equal(trackSummary(track).tags, 'default,forced,autoselect');
});

test('trackSummary - uses totalBitrate when bitrate/bandwidth missing', () => {
    const track = { totalBitrate: 7500000 };
    assert.equal(trackSummary(track).bitrate, 7500000);
});

test('trackSummary - uses title over name over id for label', () => {
    const track1 = { id: 'sub1', title: 'English' };
    assert.equal(trackSummary(track1).label, 'English');

    const track2 = { id: 'sub2', name: 'Spanish' };
    assert.equal(trackSummary(track2).label, 'Spanish');

    const track3 = { id: 'sub3' };
    assert.equal(trackSummary(track3).label, 'sub3');  // label falls back to id
});

test('presentTracks - prints report header information', () => {
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(''));

    try {
        const report = {
            inputUrl: 'https://example.com/video',
            provider: 'tvnz',
            manifestType: 'DASH',
            sourceManifestUrl: 'https://example.com/manifest.mpd',
            tracks: { video: [], audio: [], subtitles: [] }
        };
        presentTracks(report);

        const output = capturedLogs.join('\n');
        assert.equal(output.includes('Title: https://example.com/video'), true);
        assert.equal(output.includes('Provider: tvnz'), true);
        assert.equal(output.includes('Manifest: DASH'), true);
        assert.equal(output.includes('Manifest URL: https://example.com/manifest.mpd'), true);
    } finally {
        console.log = originalLog;
    }
});

test('presentTracks - prints "(none)" for empty track sections', () => {
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(''));

    try {
        const report = {
            inputUrl: 'https://example.com/video',
            provider: 'tvnz',
            manifestType: 'DASH',
            tracks: { video: [], audio: [], subtitles: [] }
        };
        presentTracks(report);

        const output = capturedLogs.join('\n');
        assert.equal(output.includes('Video formats:'), true);
        assert.equal(output.includes('  (none)'), true);
    } finally {
        console.log = originalLog;
    }
});

test('presentTracks - prints column headers for non-empty track sections', () => {
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(''));

    try {
        const report = {
            inputUrl: 'https://example.com/video',
            provider: 'tvnz',
            manifestType: 'DASH',
            tracks: {
                video: [{ id: 'v1', width: 1920, height: 1080, bitrate: 5000000 }],
                audio: [],
                subtitles: []
            }
        };
        presentTracks(report);

        const output = capturedLogs.join('\n');
        assert.equal(output.includes('ID'), true);
        assert.equal(output.includes('RES'), true);
        assert.equal(output.includes('BITRATE'), true);
        assert.equal(output.includes('v1'), true);
        assert.equal(output.includes('1920x1080'), true);
    } finally {
        console.log = originalLog;
    }
});

test('presentTracks - omits Manifest URL if sourceManifestUrl missing', () => {
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(''));

    try {
        const report = {
            inputUrl: 'https://example.com/video',
            provider: 'tvnz',
            manifestType: 'DASH',
            tracks: { video: [], audio: [], subtitles: [] }
        };
        presentTracks(report);

        const output = capturedLogs.join('\n');
        assert.equal(output.includes('Manifest URL'), false);
    } finally {
        console.log = originalLog;
    }
});

test('presentTracks - uses pageUrl when inputUrl missing', () => {
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(''));

    try {
        const report = {
            pageUrl: 'https://example.com/stream',
            provider: 'threenow',
            manifestType: 'HLS',
            tracks: { video: [], audio: [], subtitles: [] }
        };
        presentTracks(report);

        const output = capturedLogs.join('\n');
        assert.equal(output.includes('Title: https://example.com/stream'), true);
    } finally {
        console.log = originalLog;
    }
});
