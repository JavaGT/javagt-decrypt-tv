import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModuleRequestOptions } from '../src/infra/module-request-options.mjs';

test('buildModuleRequestOptions applies defaults', () => {
    const options = buildModuleRequestOptions({});

    assert.equal(options.downloadsPath, './downloads');
    assert.equal(options.devicePath, './device.wvd');
    assert.equal(options.noMtime, false);
});

test('buildModuleRequestOptions preserves provided values', () => {
    const options = buildModuleRequestOptions({
        downloadsPath: '/tmp/out',
        devicePath: '/tmp/device.wvd',
        providerId: 'threenow',
        credentials: 'a:b',
        retentionLevel: 'debug',
        format: 'bestvideo+bestaudio',
        output: 'demo',
        noMtime: 1
    });

    assert.equal(options.downloadsPath, '/tmp/out');
    assert.equal(options.devicePath, '/tmp/device.wvd');
    assert.equal(options.providerId, 'threenow');
    assert.equal(options.credentials, 'a:b');
    assert.equal(options.retentionLevel, 'debug');
    assert.equal(options.format, 'bestvideo+bestaudio');
    assert.equal(options.output, 'demo');
    assert.equal(options.noMtime, true);
});
