import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeOptions } from '../src/infra/complete-options.mjs';

test('completeOptions applies path defaults', () => {
    const result = completeOptions({});
    assert.equal(result.downloadsPath, './downloads');
    assert.equal(result.devicePath, './device.wvd');
});

test('completeOptions preserves user-provided paths', () => {
    const result = completeOptions({
        downloadsPath: '/custom/downloads',
        devicePath: '/custom/device.wvd'
    });
    assert.equal(result.downloadsPath, '/custom/downloads');
    assert.equal(result.devicePath, '/custom/device.wvd');
});

test('completeOptions translates format expression to selections', () => {
    const result = completeOptions({ format: 'bestvideo[ext=mp4]' });

    // Format should be translated to selection objects
    assert.ok(result.selectVideo);
    assert.ok(result.selectAudio);
    assert.ok(result.selectSubtitle);
});

test('completeOptions uses default format if not provided', () => {
    const result = completeOptions({});

    // Should have selections even without explicit format
    assert.ok(result.selectVideo);
    assert.ok(result.selectAudio);
    assert.ok(result.selectSubtitle);
});

test('completeOptions respects explicit selectVideo override', () => {
    const override = { 'height': 1080 };
    const result = completeOptions({
        selectVideo: override,
        format: 'bestvideo'  // Should be ignored in favor of explicit
    });

    assert.deepEqual(result.selectVideo, override);
});

test('completeOptions preserves explicit credentials', () => {
    const creds = { username: 'user', password: 'pass' };
    const result = completeOptions({ credentials: creds });

    assert.deepEqual(result.credentials, creds);
});

test('completeOptions handles empty credentials', () => {
    const result = completeOptions({});
    assert.equal(result.credentials, undefined);
});

test('completeOptions preserves output name', () => {
    const result = completeOptions({ output: 'my-video' });
    assert.equal(result.output, 'my-video');
});

test('completeOptions preserves provider override', () => {
    const result = completeOptions({ providerId: 'tvnz' });
    assert.equal(result.providerId, 'tvnz');
});

test('completeOptions preserves retentionLevel', () => {
    const result = completeOptions({ retentionLevel: 'forensic' });
    assert.equal(result.retentionLevel, 'forensic');
});

test('completeOptions preserves noMtime flag', () => {
    const result = completeOptions({ noMtime: true });
    assert.equal(result.noMtime, true);
});

test('completeOptions passes through custom options', () => {
    const result = completeOptions({
        customOption: 'custom-value',
        anotherCustom: 42
    });

    assert.equal(result.customOption, 'custom-value');
    assert.equal(result.anotherCustom, 42);
});

test('completeOptions merges all fields correctly', () => {
    const input = {
        downloadsPath: '/my/downloads',
        devicePath: '/my/device.wvd',
        format: 'best',
        output: 'output-name',
        providerId: 'tvnz',
        credentials: { token: 'abc123' },
        retentionLevel: 'safe',
        noMtime: true,
        customField: 'custom'
    };

    const result = completeOptions(input);

    assert.equal(result.downloadsPath, '/my/downloads');
    assert.equal(result.devicePath, '/my/device.wvd');
    assert.equal(result.output, 'output-name');
    assert.equal(result.providerId, 'tvnz');
    assert.equal(result.retentionLevel, 'safe');
    assert.equal(result.noMtime, true);
    assert.deepEqual(result.credentials, { token: 'abc123' });
    assert.equal(result.customField, 'custom');
    assert.ok(result.selectVideo);  // Format translated
});

test('completeOptions with all explicit selections', () => {
    const completeInput = {
        selectVideo: { res: '720p' },
        selectAudio: { lang: 'en' },
        selectSubtitle: { lang: 'fr' }
    };

    const result = completeOptions(completeInput);

    assert.deepEqual(result.selectVideo, { res: '720p' });
    assert.deepEqual(result.selectAudio, { lang: 'en' });
    assert.deepEqual(result.selectSubtitle, { lang: 'fr' });
});

test('completeOptions preserves format field for reference', () => {
    const result = completeOptions({ format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]' });

    // Format expression should be preserved so callers can see original intent
    assert.equal(result.format, 'bestvideo[ext=mp4]+bestaudio[ext=m4a]');
});

test('completeOptions returns different object (immutable)', () => {
    const input = { downloadsPath: '/custom' };
    const result = completeOptions(input);

    // Modifying result should not affect input
    result.downloadsPath = '/other';
    assert.equal(input.downloadsPath, '/custom');
});

test('completeOptions handles null/undefined gracefully', () => {
    const resultNull = completeOptions(null);
    const resultUndef = completeOptions(undefined);

    assert.equal(resultNull.downloadsPath, './downloads');
    assert.equal(resultUndef.downloadsPath, './downloads');
});

test('completeOptions with mixed partial and explicit options', () => {
    const input = {
        outputName: 'my-video',  // Only explicit for output
        selectVideoExplicit: { height: 1080 },  // Explicit video selection
        format: 'best',  // Fall back format for audio/subtitle
        providerId: 'tvnz'
    };

    const result = completeOptions(input);

    // Explicit selection should win
    assert.deepEqual(result.selectVideoExplicit, { height: 1080 });
    assert.ok(result.selectAudio);  // From format fallback
    assert.ok(result.selectSubtitle);  // From format fallback
});
