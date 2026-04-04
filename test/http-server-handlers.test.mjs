import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildInspectRequest,
    buildRunRequest,
    executeServiceAction
} from '../src/adapters/http-server-handlers.mjs';

test('buildRunRequest applies defaults', () => {
    const request = buildRunRequest({ inputUrl: 'https://example.test', options: { a: 1 } });

    assert.equal(request.inputUrl, 'https://example.test');
    assert.equal(request.downloadsPath, './downloads');
    assert.equal(request.wvdDevicePath, './device.wvd');
    assert.deepEqual(request.options, { a: 1 });
});

test('buildInspectRequest applies defaults', () => {
    const request = buildInspectRequest({ inputUrl: 'https://example.test' });

    assert.equal(request.inputUrl, 'https://example.test');
    assert.equal(request.downloadsPath, './downloads');
    assert.equal(request.wvdDevicePath, './device.wvd');
    assert.deepEqual(request.options, {});
});

test('executeServiceAction returns 400 for invalid JSON', async () => {
    const result = await executeServiceAction({
        service: {},
        action: 'run',
        rawBody: '{'
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.payload, { error: 'Invalid JSON body' });
});

test('executeServiceAction handles run success', async () => {
    const service = {
        run: async (request) => ({ ok: true, request })
    };

    const result = await executeServiceAction({
        service,
        action: 'run',
        rawBody: JSON.stringify({ inputUrl: 'https://example.test' })
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.request.downloadsPath, './downloads');
});

test('executeServiceAction handles inspect success', async () => {
    const service = {
        inspect: async (request) => ({ inspected: true, request })
    };

    const result = await executeServiceAction({
        service,
        action: 'inspect',
        rawBody: JSON.stringify({ inputUrl: 'https://example.test', devicePath: '/tmp/x.wvd' })
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.inspected, true);
    assert.equal(result.payload.request.wvdDevicePath, '/tmp/x.wvd');
});

test('executeServiceAction returns 400 on service error', async () => {
    const service = {
        run: async () => {
            throw new Error('boom');
        }
    };

    const result = await executeServiceAction({
        service,
        action: 'run',
        rawBody: JSON.stringify({ inputUrl: 'https://example.test' })
    });

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.payload, { error: 'boom' });
});
