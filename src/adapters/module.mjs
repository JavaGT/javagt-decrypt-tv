import fs from 'fs';
import path from 'path';
import ProviderRegistry from '../providers/registry.mjs';
import MediaService from '../application/media-service.mjs';
import { createDefaultRuntime } from '../infra/runtime.mjs';
import RetentionStore from '../infra/retention-store.mjs';
import {
    normalizeOptions,
    safeStem,
    sanitizeForJson,
    translateFormatExpression
} from '../infra/module-utils.mjs';
import { completeOptions } from '../infra/complete-options.mjs';
import { ensureEnvironmentLoaded } from '../infra/env-bootstrap.mjs';
import TvnzProvider from '../providers/tvnz-provider.mjs';
import ThreeNowProvider from '../providers/threenow-provider.mjs';

export class DecryptModuleAdapter {
    constructor({ runtime, retentionFactory } = {}) {
        this.runtime = runtime || createDefaultRuntime();
        this.registry = new ProviderRegistry();
        this.retentionFactory = retentionFactory || (({ downloadsPath, inputUrl, providerId, options = {} }) => new RetentionStore(downloadsPath, inputUrl, providerId, {
            retentionLevel: options.retentionLevel || process.env.RETENTION_LEVEL || 'safe'
        }));
        this.service = this._createService();
    }

    _createService() {
        return new MediaService({
            registry: this.registry,
            runtime: this.runtime,
            retentionFactory: this.retentionFactory
        });
    }

    _refreshService() {
        this.service = this._createService();
    }

    _toServiceRequest(inputUrl, completedOptions = {}) {
        return {
            inputUrl,
            downloadsPath: completedOptions.downloadsPath,
            wvdDevicePath: completedOptions.devicePath,
            providerId: completedOptions.providerId,
            credentials: completedOptions.credentials,
            options: completedOptions
        };
    }

    _toProviderInstance(providerOrClass, providerOptions = {}) {
        if (typeof providerOrClass === 'function') {
            return new providerOrClass({ runtime: this.runtime, ...providerOptions });
        }
        return providerOrClass;
    }

    static translateFormatExpression(formatExpression) {
        return translateFormatExpression(formatExpression);
    }

    static sanitizeForJson(value, seen = new WeakSet()) {
        return sanitizeForJson(value, seen);
    }

    static safeStem(value) {
        return safeStem(value);
    }

    static normalizeOptions(rawOptions = {}) {
        return normalizeOptions(rawOptions);
    }

    static defaultProviders() {
        return [TvnzProvider, ThreeNowProvider];
    }

    static createWithDefaultProviders(config = {}) {
        return new DecryptModuleAdapter(config).registerDefaultProviders();
    }

    registerDefaultProviders() {
        return this.registerProviders(DecryptModuleAdapter.defaultProviders());
    }

    registerProvider(providerOrClass, providerOptions = {}) {
        const provider = this._toProviderInstance(providerOrClass, providerOptions);

        if (!provider || typeof provider.id !== 'string' || typeof provider.supports !== 'function' || typeof provider.execute !== 'function' || typeof provider.inspect !== 'function') {
            throw new Error('Invalid provider. A provider must have id, supports(), execute(), and inspect().');
        }

        const existing = this.registry.resolveById(provider.id);
        if (existing) {
            throw new Error(`Provider ${provider.id} is already registered`);
        }

        this.registry.register(provider);
        this._refreshService();
        return this;
    }

    registerProviders(providers = []) {
        for (const provider of providers) {
            this.registerProvider(provider);
        }
        return this;
    }

    unregisterProvider(providerId) {
        this.registry.providers = this.registry.providers.filter((provider) => provider.id !== providerId);
        this._refreshService();
        return this;
    }

    clearProviders() {
        this.registry.providers = [];
        this._refreshService();
        return this;
    }

    listProviders() {
        return this.registry.all().map((provider) => provider.id);
    }

    async inspect(inputUrl, rawOptions = {}) {
        ensureEnvironmentLoaded();
        const options = completeOptions(rawOptions);
        return this.service.inspect(this._toServiceRequest(inputUrl, options));
    }

    async #fetchAndNormalizeReport(inputUrl, rawOptions = {}) {
        const options = completeOptions(rawOptions);
        return this.inspect(inputUrl, options);
    }

    async listFormats(inputUrl, rawOptions = {}) {
        const report = await this.#fetchAndNormalizeReport(inputUrl, rawOptions);
        return {
            provider: report.provider,
            status: report.status || 'ready',
            manifestType: report.manifestType,
            sourceManifestUrl: report.sourceManifestUrl,
            tracks: report.tracks || { video: [], audio: [], subtitles: [] },
            defaultSelection: report.defaultSelection || { videoIds: [], audioIds: [], subtitleIds: [] }
        };
    }

    async dumpJson(inputUrl, rawOptions = {}) {
        const report = await this.#fetchAndNormalizeReport(inputUrl, rawOptions);
        return JSON.stringify(sanitizeForJson(report), null, 2);
    }

    async writeInfoJson(inputUrl, rawOptions = {}) {
        const options = completeOptions(rawOptions);
        const report = await this.#fetchAndNormalizeReport(inputUrl, rawOptions);
        const downloadsPath = options.downloadsPath;
        const outputName = options.output || 'output';
        const infoPath = path.join(downloadsPath, `${safeStem(outputName)}.info.json`);

        fs.mkdirSync(path.dirname(infoPath), { recursive: true });
        fs.writeFileSync(infoPath, JSON.stringify(sanitizeForJson(report), null, 2));

        return {
            infoPath,
            report
        };
    }

    async run(inputUrl, rawOptions = {}) {
        ensureEnvironmentLoaded();
        const options = completeOptions(rawOptions);
        return this.service.run(this._toServiceRequest(inputUrl, options));
    }

    async runWithInfoJson(inputUrl, rawOptions = {}) {
        const options = completeOptions(rawOptions);
        const { infoPath, report } = await this.writeInfoJson(inputUrl, options);
        const result = await this.run(inputUrl, options);
        return {
            result,
            infoPath,
            report
        };
    }
}

export const tvnz = TvnzProvider;
export const threenow = ThreeNowProvider;

const moduleAdapter = new DecryptModuleAdapter();

export default moduleAdapter;
