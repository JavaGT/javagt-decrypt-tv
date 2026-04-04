export class MediaService {
    constructor({ registry, runtime, retentionFactory }) {
        this.registry = registry;
        this.runtime = runtime;
        this.retentionFactory = retentionFactory;
    }

    _resolveProvider(inputUrl, providerId) {
        return providerId
            ? this.registry.resolveById(providerId)
            : this.registry.resolveByUrl(inputUrl);
    }

    _createRetention({ downloadsPath, inputUrl, providerId, options = {} }) {
        const resolvedDownloadsPath = downloadsPath || process.cwd();
        return this.retentionFactory ? this.retentionFactory({ downloadsPath: resolvedDownloadsPath, inputUrl, providerId, options }) : undefined;
    }

    async #initializeAction(inputUrl, providerId, downloadsPath, options, actionMode) {
        const provider = this._resolveProvider(inputUrl, providerId);

        if (!provider) {
            throw new Error(`No provider found for input: ${inputUrl}`);
        }

        const retention = this._createRetention({ downloadsPath, inputUrl, providerId: provider.id, options });

        if (retention?.writeRunManifest) {
            retention.writeRunManifest({
                mode: actionMode,
                provider: provider.id,
                input_url: inputUrl,
                downloads_path: downloadsPath,
                selectors: {
                    video: options?.selectVideo,
                    audio: options?.selectAudio,
                    subtitle: options?.selectSubtitle
                }
            });
        }

        return { provider, retention };
    }

    async run({ inputUrl, downloadsPath, wvdDevicePath, credentials, providerId, options = {} }) {
        const { provider, retention } = await this.#initializeAction(inputUrl, providerId, downloadsPath, options, 'download');

        return provider.execute(inputUrl, {
            downloadsPath,
            wvdDevicePath,
            credentials,
            options,
            retention,
            runtime: this.runtime
        });
    }

    async inspect(params = {}) {
        const { inputUrl, downloadsPath, providerId, credentials, wvdDevicePath, options = {} } = params;
        const { provider, retention } = await this.#initializeAction(inputUrl, providerId, downloadsPath, options, 'inspect');

        try {
            const report = await provider.inspect(inputUrl, {
                downloadsPath,
                credentials,
                wvdDevicePath,
                options,
                retention,
                runtime: this.runtime
            });

            if (retention) {
                retention.addEvent('inspect_complete', {
                    provider: provider.id,
                    manifest_type: report?.manifestType,
                    status: report?.status || 'ready'
                });
                retention.writeSummary(true, {
                    mode: 'inspect',
                    provider: provider.id,
                    input_url: inputUrl,
                    status: report?.status || 'ready'
                });
            }

            return report;
        } catch (error) {
            if (retention) {
                retention.addEvent('inspect_exception', {
                    provider: provider.id,
                    message: error.message,
                    type: error.name
                });
                retention.writeSummary(false, {
                    mode: 'inspect',
                    provider: provider.id,
                    input_url: inputUrl,
                    error: error.message,
                    error_type: error.name
                });
            }
            throw error;
        }
    }
}

export default MediaService;
