import fs from 'fs';
import path from 'path';
import ProviderRegistry from './providers/registry.mjs';
import MediaService from './application/media-service.mjs';
import { createDefaultRuntime } from './infra/runtime.mjs';
import RetentionStore from './infra/retention-store.mjs';
import { completeOptions } from './infra/complete-options.mjs';
import { ensureEnvironmentLoaded } from './infra/env-bootstrap.mjs';
import { safeStem, sanitizeForJson } from './infra/module-utils.mjs';

function credentialsFromProvider(provider) {
    if (!provider || typeof provider.getAuth !== 'function') {
        return undefined;
    }

    const auth = provider.getAuth();
    if (!auth || typeof auth !== 'object') {
        return undefined;
    }

    if (typeof auth.credentials === 'string' && auth.credentials.includes(':')) {
        return auth.credentials;
    }

    if (typeof auth.username === 'string' && typeof auth.password === 'string') {
        return `${auth.username}:${auth.password}`;
    }

    return undefined;
}

function mapPreferencesToSelectors(preferences = {}) {
    const mapped = {};

    const videoStrategy = preferences?.video?.strategy;
    const audioStrategy = preferences?.audio?.strategy;
    const subtitleStrategy = preferences?.subtitle?.strategy;

    if (Array.isArray(videoStrategy)) {
        mapped.selectVideo = videoStrategy.includes('lowest-resolution') || videoStrategy.includes('lowest-bitrate') ? 'worst' : 'best';
    } else if (videoStrategy === 'lowest-resolution-then-lowest-bitrate') {
        mapped.selectVideo = 'worst';
    }

    if (audioStrategy === 'lowest-bitrate') {
        mapped.selectAudio = 'worstaudio';
    }

    if (subtitleStrategy === 'all') {
        mapped.selectSubtitle = 'all';
    }

    return mapped;
}

class RetainerAwareStore {
    constructor(baseStore, retainer) {
        this.baseStore = baseStore;
        this.retainer = retainer;
    }

    get baseDir() {
        return this.baseStore.baseDir;
    }

    writeJson(relativePath, payload) {
        this.baseStore.writeJson(relativePath, payload);
    }

    writeText(relativePath, payload) {
        this.baseStore.writeText(relativePath, payload);
    }

    writeRunManifest(details = {}) {
        this.baseStore.writeRunManifest(details);
        this.retainer?.dump?.('run_manifest', details);
    }

    writeOutputFiles(filePaths = []) {
        this.baseStore.writeOutputFiles(filePaths);
        this.retainer?.dump?.('output_files', { count: filePaths.length });
    }

    addEvent(stage, details) {
        this.baseStore.addEvent(stage, details);
        this.retainer?.dump?.(`event:${stage}`, details);
    }

    writeSummary(success, details) {
        this.baseStore.writeSummary(success, details);
        this.retainer?.dump?.('summary', { success, ...details });
    }
}

export class DecryptModule {
    constructor({ downloadsDir = './downloads', tempDir = './tmp', retainer, runtime } = {}) {
        ensureEnvironmentLoaded();
        this.downloadsDir = downloadsDir;
        this.tempDir = tempDir;
        this.retainer = retainer;
        this.runtime = runtime || createDefaultRuntime();
        this.registry = new ProviderRegistry();

        this.service = new MediaService({
            registry: this.registry,
            runtime: this.runtime,
            retentionFactory: ({ downloadsPath, inputUrl, providerId, options = {} }) => {
                const base = new RetentionStore(downloadsPath || this.downloadsDir, inputUrl, providerId, {
                    retentionLevel: options.retentionLevel || process.env.RETENTION_LEVEL || 'safe'
                });

                return this.retainer ? new RetainerAwareStore(base, this.retainer) : base;
            }
        });
    }

    addProvider(provider) {
        if (!provider || typeof provider.id !== 'string' || typeof provider.supports !== 'function' || typeof provider.execute !== 'function' || typeof provider.inspect !== 'function') {
            throw new Error('Invalid provider instance. Expected id, supports(), execute(), and inspect().');
        }

        const existing = this.registry.resolveById(provider.id);
        if (existing) {
            throw new Error(`Provider ${provider.id} is already registered`);
        }

        this.registry.register(provider);
        return this;
    }

    _resolveProvider(url, providerId) {
        return providerId ? this.registry.resolveById(providerId) : this.registry.resolveByUrl(url);
    }

    _serviceRequest(url, options = {}) {
        const provider = this._resolveProvider(url, options.providerId);
        const providerCredentials = credentialsFromProvider(provider);

        return {
            inputUrl: url,
            downloadsPath: options.downloadsPath || this.downloadsDir,
            wvdDevicePath: options.devicePath || './device.wvd',
            providerId: options.providerId,
            credentials: options.credentials || providerCredentials,
            options: {
                ...options,
                tempDir: options.tempDir || this.tempDir
            }
        };
    }

    async inspect(url, options = {}) {
        ensureEnvironmentLoaded();
        const normalized = completeOptions({ downloadsPath: this.downloadsDir, ...options });
        const request = this._serviceRequest(url, normalized);

        try {
            const report = await this.service.inspect(request);
            this.retainer?.dump?.('inspect_report', sanitizeForJson(report));
            return report;
        } catch (error) {
            const providerLabel = request.providerId || 'auto-resolve';
            const message = `inspect failed for ${url} (provider=${providerLabel}): ${error.message}`;
            this.retainer?.dump?.('inspect_error', { url, provider: providerLabel, message: error.message });
            throw new Error(message);
        }
    }

    async download(url, options = {}) {
        ensureEnvironmentLoaded();

        const selectors = mapPreferencesToSelectors(options.preferences || {});
        const normalized = completeOptions({
            downloadsPath: this.downloadsDir,
            ...options,
            ...selectors,
            noMtime: options.preserveTimestamp === false ? true : options.noMtime
        });

        let inspectContext = options.inspectContext;
        if (!inspectContext) {
            inspectContext = await this.inspect(url, normalized);
        }

        const request = this._serviceRequest(url, normalized);
        let runResult;
        try {
            runResult = await this.service.run(request);
        } catch (error) {
            const providerLabel = request.providerId || 'auto-resolve';
            const message = `download failed for ${url} (provider=${providerLabel}): ${error.message}`;
            this.retainer?.dump?.('download_error', { url, provider: providerLabel, message: error.message });
            throw new Error(message);
        }

        let metadataPath;
        if (options.saveMetadata) {
            const outputName = normalized.output || 'output';
            metadataPath = path.join(normalized.downloadsPath, `${safeStem(outputName)}.info.json`);
            fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
            fs.writeFileSync(metadataPath, JSON.stringify(sanitizeForJson(inspectContext), null, 2));
        }

        const outputPath = path.join(normalized.downloadsPath, `${safeStem(normalized.output || 'output')}.mkv`);
        const result = {
            ...runResult,
            outputPath,
            metadataPath
        };

        this.retainer?.dump?.('download_result', sanitizeForJson(result));
        return result;
    }
}

export default DecryptModule;