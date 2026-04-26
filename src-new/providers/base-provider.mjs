/**
 * Base provider abstract class.
 * All provider implementations should extend this.
 */

import { ProviderError } from '../errors/index.mjs'

export class BaseProvider {
  /**
   * Check if this provider can handle the given URL.
   * @param {string} url
   * @returns {boolean}
   */
  static canHandle(url) {
    throw new ProviderError('canHandle() must be implemented by subclass', { class: this.name })
  }

  /**
   * @param {Object} config
   * @param {HttpClient} httpClient
   * @param {BaseAuthManager} authManager
   */
  constructor(config, httpClient, authManager) {
    this.config = config
    this.httpClient = httpClient
    this.authManager = authManager
  }

  /**
   * Authorize content for a given URL.
   * Returns content metadata including manifest URL and decryption keys.
   * @param {string} url
   * @returns {Promise<Object>} - { manifestUrl, decryptionKeys, contentMetadata }
   */
  async authorizeContent(url) {
    throw new ProviderError('authorizeContent() must be implemented by subclass', { class: this.constructor.name })
  }

  /**
   * Fetch and parse a manifest.
   * @param {string} manifestUrl
   * @returns {Promise<Object>} Parsed manifest
   */
  async getManifest(manifestUrl) {
    throw new ProviderError('getManifest() must be implemented by subclass', { class: this.constructor.name })
  }

  /**
   * Build a segment URL from a template and parameters.
   * @param {string} baseUrl
   * @param {Object} segment - { time, number, bandwidth }
   * @param {Object} representation
   * @returns {string}
   */
  buildSegmentUrl(baseUrl, segment, representation) {
    let url = baseUrl

    if (segment.url) {
      return segment.url
    }

    // Template substitution
    url = url.replace(/\$Time\$/g, segment.time?.toString() ?? '')
    url = url.replace(/\$Number\$/g, segment.number?.toString() ?? '')
    url = url.replace(/\$Bandwidth\$/g, (representation?.bandwidth ?? segment.bandwidth)?.toString() ?? '')

    return url
  }
}

export default BaseProvider