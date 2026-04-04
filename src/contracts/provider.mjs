/**
 * @typedef {Object} ProviderContext
 * @property {string} downloadsPath
 * @property {string} [devicePath]
 * @property {string} [credentials]
 * @property {import('../infra/retention-store.mjs').default} [retention]
 * @property {ReturnType<import('../infra/runtime.mjs').createDefaultRuntime>} [runtime]
 * @property {Record<string, any>} [options]
 */

/**
 * @typedef {Object} ProviderResult
 * @property {string} provider
 * @property {string} inputUrl
 * @property {boolean} success
 * @property {string} [message]
 * @property {Record<string, any>} [artifacts]
 */

/**
 * Provider interface contract for all streaming service plugins.
 */
export class MediaProvider {
    /** @returns {string} */
    get id() {
        throw new Error('Provider must implement id getter');
    }

    /**
     * Return true if this provider supports the given URL.
     * @param {string} inputUrl
     * @returns {boolean}
     */
    supports(inputUrl) {
        throw new Error('Provider must implement supports(inputUrl)');
    }

    /**
     * Prepare + optionally execute media workflow.
     * @param {string} inputUrl
     * @param {ProviderContext} context
     * @returns {Promise<ProviderResult>}
     */
    async execute(inputUrl, context) {
        throw new Error('Provider must implement execute(inputUrl, context)');
    }

    /**
     * Resolve and inspect a page URL.
     * @param {string} inputUrl
     * @param {ProviderContext} context
     * @returns {Promise<Record<string, any>>}
     */
    async inspect(inputUrl, context) {
        throw new Error('Provider must implement inspect(inputUrl, context)');
    }
}

export default MediaProvider;
