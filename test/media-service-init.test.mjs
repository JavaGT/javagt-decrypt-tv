import { test } from 'node:test';
import assert from 'node:assert/strict';
import MediaService from '../src/application/media-service.mjs';
import ProviderRegistry from '../src/providers/registry.mjs';

// Mock provider for testing
class MockProvider {
    get id() {
        return 'test-provider';
    }

    supports(url) {
        return url.includes('test-service');
    }

    async execute(inputUrl, context) {
        return {
            provider: this.id,
            message: 'ok',
            context: {
                hasRetention: !!context.retention,
                downloadsPath: context.downloadsPath
            }
        };
    }

    async inspect(inputUrl, context) {
        return {
            provider: this.id,
            status: 'ready',
            manifestType: 'DASH',
            context: {
                hasRetention: !!context.retention
            }
        };
    }
}

function createTestService(options = {}) {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider());

    return new MediaService({
        registry,
        runtime: options.runtime,
        retentionFactory: options.retentionFactory
    });
}

test('run() resolves provider from URL', async () => {
    const service = createTestService();

    const result = await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {}
    });

    assert.equal(result.provider, 'test-provider');
});

test('run() uses providerId override when provided', async () => {
    const service = createTestService();
    const mockProvider = new MockProvider();
    service.registry.register(mockProvider);

    const result = await service.run({
        inputUrl: 'https://other-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: 'test-provider',  // Override
        credentials: null,
        options: {}
    });

    assert.equal(result.provider, 'test-provider');
});

test('run() throws when no provider found', async () => {
    const service = createTestService();

    await assert.rejects(
        async () => service.run({
            inputUrl: 'https://unknown-service.example.com/video',
            downloadsPath: './downloads',
            wvdDevicePath: './device.wvd',
            providerId: 'nonexistent',
            credentials: null,
            options: {}
        }),
        /No provider found/
    );
});

test('run() creates retention store and passes to provider', async () => {
    let retentionWasCreated = false;
    const testRetention = {
        writeRunManifest: (manifest) => {
            assert.equal(manifest.mode, 'download');
            retentionWasCreated = true;
        }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    const result = await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {}
    });

    assert.equal(retentionWasCreated, true);
    assert.equal(result.context.hasRetention, true);
});

test('run() calls writeRunManifest with download mode', async () => {
    let capturedManifest = null;
    const testRetention = {
        writeRunManifest: (manifest) => {
            capturedManifest = manifest;
        }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {}
    });

    assert.ok(capturedManifest);
    assert.equal(capturedManifest.mode, 'download');
    assert.equal(capturedManifest.provider, 'test-provider');
});

test('inspect() resolves provider and initializes correctly', async () => {
    let capturedManifest = null;
    const testRetention = {
        writeRunManifest: (manifest) => {
            capturedManifest = manifest;
        },
        addEvent: () => { },
        writeSummary: () => { }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    const result = await service.inspect({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        providerId: null,
        credentials: null,
        wvdDevicePath: './device.wvd',
        options: {}
    });

    assert.equal(result.provider, 'test-provider');
    assert.ok(capturedManifest);
    assert.equal(capturedManifest.mode, 'inspect');  // <-- Different mode than run()
});

test('inspect() calls writeRunManifest with inspect mode', async () => {
    let capturedManifest = null;
    const testRetention = {
        writeRunManifest: (manifest) => {
            capturedManifest = manifest;
        },
        addEvent: () => { },
        writeSummary: () => { }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    await service.inspect({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        providerId: null,
        credentials: null,
        wvdDevicePath: './device.wvd',
        options: {}
    });

    assert.equal(capturedManifest.mode, 'inspect');
});

test('initialization includes selector options from normalized data', async () => {
    let capturedManifest = null;
    const testRetention = {
        writeRunManifest: (manifest) => {
            capturedManifest = manifest;
        }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {
            selectVideo: { resolution: '1080p' },
            selectAudio: { language: 'en' },
            selectSubtitle: { language: 'en' }
        }
    });

    assert.deepEqual(capturedManifest.selectors, {
        video: { resolution: '1080p' },
        audio: { language: 'en' },
        subtitle: { language: 'en' }
    });
});

test('initialization handles missing selectors gracefully', async () => {
    let capturedManifest = null;
    const testRetention = {
        writeRunManifest: (manifest) => {
            capturedManifest = manifest;
        }
    };

    const service = createTestService({
        retentionFactory: () => testRetention
    });

    await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {}  // No selector options
    });

    assert.deepEqual(capturedManifest.selectors, {
        video: undefined,
        audio: undefined,
        subtitle: undefined
    });
});

test('run() and inspect() share same provider resolution logic', async () => {
    let resolvedProviders = [];

    class TrackingProvider extends MockProvider {
        async execute(inputUrl, context) {
            resolvedProviders.push({ method: 'execute', provider: this.id });
            return super.execute(inputUrl, context);
        }
        async inspect(inputUrl, context) {
            resolvedProviders.push({ method: 'inspect', provider: this.id });
            return super.inspect(inputUrl, context);
        }
    }

    const registry = new ProviderRegistry();
    registry.register(new TrackingProvider());

    const service = new MediaService({ registry });

    // Both methods should use same provider for same URL
    await service.run({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        wvdDevicePath: './device.wvd',
        providerId: null,
        credentials: null,
        options: {}
    });

    await service.inspect({
        inputUrl: 'https://test-service.example.com/video',
        downloadsPath: './downloads',
        providerId: null,
        credentials: null,
        wvdDevicePath: './device.wvd',
        options: {}
    });

    assert.equal(resolvedProviders.length, 2);
    assert.equal(resolvedProviders[0].provider, 'test-provider');
    assert.equal(resolvedProviders[1].provider, 'test-provider');
});
