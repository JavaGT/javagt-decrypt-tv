/**
 * Brightcove generic provider.
 * Handles Brightcove Playback API for any Brightcove-powered site.
 */

import { ProviderError } from '../errors/index.mjs'
import { BaseProvider } from './base-provider.mjs'
import { BrightcoveAuth } from '../auth/index.mjs'
import { ManifestParser } from '../services/manifest-parser/index.mjs'

export class BrightcoveProvider extends BaseProvider {
  /**
   * @param {Object} config - { accountId, policyKey, clientId?, clientSecret? }
   * @param {HttpClient} httpClient
   * @param {BrightcoveAuth} authManager
   */
  constructor(config, httpClient, authManager) {
    super(config, httpClient, authManager)
    this.accountId = config.accountId
    this.policyKey = config.policyKey
    this.playbackApiBase = 'https://edge.api.brightcove.com/playback/v1'
    this.manifestParser = new ManifestParser()
  }

  /**
   * Check if this provider can handle the URL (Brightcove-relative domains).
   * Override in subclass for specific sites.
   * @param {string} url
   * @returns {boolean}
   */
  static canHandle(url) {
    // Generic Brightcove doesn't match by default - override in subclass
    return false
  }

  /**
   * Authenticate with Brightcove OAuth2.
   * @param {Object} credentials
   * @returns {Promise<Object>}
   */
  async authenticate(credentials = {}) {
    if (!this.authManager) {
      throw new ProviderError('Brightcove provider requires an auth manager', { provider: 'BrightcoveProvider' })
    }
    return this.authManager.authenticate(credentials)
  }

  /**
   * Authorize content and get manifest URL + decryption keys.
   * @param {string} videoIdOrUrl - Video ID or content URL
   * @returns {Promise<Object>}
   */
  async authorizeContent(videoIdOrUrl) {
    const videoId = this._extractVideoId(videoIdOrUrl)

    if (!videoId) {
      throw new ProviderError('Invalid video ID or URL', { videoIdOrUrl })
    }

    const playbackUrl = this._getPlaybackUrl(videoId)

    const headers = await this.authManager.getHeaders()

    // Add policy key header if configured
    if (this.policyKey) {
      headers['BCOV-Policy'] = this.policyKey
    }

    const response = await this.httpClient.get(playbackUrl, { headers })

    if (!response.playlist?.[0]?.video_sources?.[0]) {
      throw new ProviderError('No video sources found in Brightcove response', { videoId })
    }

    // Find best video source (prefer DASH with encryption)
    const sources = response.playlist[0].video_sources
    const videoSource = sources.find(s => s.src && s.drm) || sources.find(s => s.src)

    if (!videoSource) {
      throw new ProviderError('No playable video source found', { videoId })
    }

    // Extract PSSH from Widevine/FairPlay config
    let pssh = null
    let licenseUrl = null

    if (videoSource.drm) {
      const widevineConfig = videoSource.drm.find(d => d.system === 'widevine')
      if (widevineConfig) {
        pssh = widevineConfig.pssh
        licenseUrl = widevineConfig.license_url
      }
    }

    return {
      videoId,
      accountId: this.accountId,
      manifestUrl: videoSource.src,
      manifestType: this._detectManifestType(videoSource.src),
      pssh,
      licenseUrl,
      videoMetadata: {
        name: response.playlist?.[0]?.name,
        description: response.playlist?.[0]?.description,
        thumbnail: response.playlist?.[0]?.thumbnail,
        duration: videoSource.duration,
      },
      raw: response,
    }
  }

  /**
   * Fetch and parse a manifest.
   * @param {string} manifestUrl
   * @returns {Promise<Object>}
   */
  async getManifest(manifestUrl) {
    const text = await this.httpClient.fetchText(manifestUrl)
    return this.manifestParser.parse(text)
  }

  /**
   * Get video sources from Brightcove Playback API.
   * @param {string} videoId
   * @returns {Promise<Array>}
   */
  async getVideoSources(videoId) {
    const url = this._getPlaybackUrl(videoId)
    const headers = await this.authManager.getHeaders()

    if (this.policyKey) {
      headers['BCOV-Policy'] = this.policyKey
    }

    const response = await this.httpClient.get(url, { headers })
    const sources = response.playlist?.[0]?.video_sources || []

    return sources.map(s => ({
      src: s.src,
      type: s.type,
      width: s.width,
      height: s.height,
      bandwidth: s.bandwidth,
      drm: s.drm,
      duration: s.duration,
    }))
  }

  _getPlaybackUrl(videoId) {
    return `${this.playbackApiBase}/accounts/${this.accountId}/videos/${videoId}`
  }

  _extractVideoId(input) {
    // If it looks like a URL, try to extract video ID
    if (input.includes('/')) {
      // Brightcove URLs typically have / videos /{id} or /ref:{id}
      const match = input.match(/\/videos\/([^\/\?]+)/)
      if (match) return match[1]

      const refMatch = input.match(/ref:([^&\/\?]+)/)
      if (refMatch) return `ref:${refMatch[1]}`
    }

    // Otherwise assume it's already a video ID
    return input
  }

  _detectManifestType(url) {
    if (url.endsWith('.mpd')) return 'dash'
    if (url.endsWith('.m3u8')) return 'hls'
    return 'unknown'
  }
}

export default BrightcoveProvider