/**
 * TVNZ provider extending Brightcove.
 * Uses TVNZ-specific Edge API for authorization and Brightcove for playback.
 */

import { ProviderError } from '../errors/index.mjs'
import { BrightcoveProvider } from './brightcove-provider.mjs'
import { getWidevineKeys } from '../services/widevine-keys.mjs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// Logging utility
const Log = {
  debug: (...args) => console.debug('[TVNZ]', new Date().toISOString(), ...args),
  info: (...args) => console.info('[TVNZ]', new Date().toISOString(), ...args),
  warn: (...args) => console.warn('[TVNZ]', new Date().toISOString(), ...args),
  error: (...args) => console.error('[TVNZ]', new Date().toISOString(), ...args),
}

const EDGE_API_BASE = 'https://watch-cdn.edge-api.tvnz.co.nz'
const VOD_ORIGIN_BASE = 'https://vod-origin-cdn.cms-api.tvnz.co.nz'
const DATA_STORE_BASE = 'https://data-store-cdn.cms-api.tvnz.co.nz'

export class TvnzProvider extends BrightcoveProvider {
  /**
   * @param {Object} config
   * @param {HttpClient} httpClient
   * @param {TvnzAuth} authManager
   */
  constructor(config, httpClient, authManager) {
    super(config, httpClient, authManager)
    this.tvnzConfig = {
      evergentBase: config.evergentBase ?? 'https://rest-prod-tvnz.evergentpd.com/tvnz',
      edgeApiBase: EDGE_API_BASE,
      vodOriginBase: VOD_ORIGIN_BASE,
      dataStoreBase: DATA_STORE_BASE,
      clientId: config.clientId ?? 'webclient-ui-app',
      clientSecret: config.clientSecret ?? 'f99d00b8-5b20-4c27-983d-d2895f3e9fec',
    }
    this._manifestCache = new Map()
  }

  /**
   * @param {string} url
   * @returns {boolean}
   */
  static canHandle(url) {
    return typeof url === 'string' && /tvnz\.co\.nz/i.test(url)
  }

  /**
   * Authorize content via TVNZ Edge API (not Brightcove directly).
   * @param {string} inputUrl - TVNZ URL (player, show, episode, etc.)
   * @returns {Promise<Object>}
   */
  async authorizeContent(inputUrl) {
    // Resolve content ID from URL
    const contentInfo = await this._resolveContentId(inputUrl)

    // Authorize via Edge API
    const authData = await this._authorizeEdgeApi(
      contentInfo.contentId,
      contentInfo.contentType,
      contentInfo.catalogType
    )

    // Handle SSAI session if needed
    let manifestUrl = authData.contentUrl
    if (authData.mtSessionUrl) {
      manifestUrl = await this._createSsaiSession(authData.mtSessionUrl, authData.playerParams)
    }

    // Get PSSH from manifest
    const pssh = await this._extractPssh(manifestUrl)

    return {
      contentId: contentInfo.contentId,
      contentUrl: manifestUrl,
      licenseUrl: authData.licenseUrl,
      pssh,
      decryptionKeys: [], // Keys obtained separately via getKeys()
      heartbeatToken: authData.heartbeatToken,
      accessToken: this.authManager?.getAccessToken(),
      mtSessionUrl: authData.mtSessionUrl,
      playerParams: authData.playerParams,
      metadata: {
        title: contentInfo.title,
        contentType: contentInfo.contentType,
      },
      raw: authData,
    }
  }

  /**
   * Fetch and parse a manifest.
   * @param {string} manifestUrl
   * @returns {Promise<Object>}
   */
  async getManifest(manifestUrl) {
    if (this._manifestCache.has(manifestUrl)) {
      return this._manifestCache.get(manifestUrl)
    }

    const text = await this.httpClient.fetchText(manifestUrl)
    const manifest = this.manifestParser.parseDASH(text, manifestUrl)

    this._manifestCache.set(manifestUrl, manifest)
    return manifest
  }

  /**
   * Build segment URL from template.
   * @param {string} baseUrl
   * @param {Object} segment
   * @param {Object} representation
   * @returns {string}
   */
  buildSegmentUrl(baseUrl, segment, representation) {
    let url = baseUrl

    // Prefer /content/pubcontent/ paths over /tm/ (TVNZ-specific: /tm/ has segment gating)
    if (baseUrl.includes('/tm/') && !baseUrl.includes('/content/pubcontent/')) {
      // This is a gated path - might fail for later segments
      // Keep as-is but note: this may cause 403 on segments beyond the gate
    }

    if (segment.url) {
      return segment.url
    }

    url = url.replace(/\$Time\$/g, segment.time?.toString() ?? '')
    url = url.replace(/\$Number\$/g, segment.number?.toString() ?? '')
    url = url.replace(/\$Bandwidth\$/g, (representation?.bandwidth ?? segment.bandwidth)?.toString() ?? '')

    return url
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  async _resolveContentId(inputUrl) {
    // Parse URL patterns
    const playerMatch = inputUrl.match(/\/player\/([^/]+)\/([^/]+)/)
    if (playerMatch) {
      const [, contentType, slug] = playerMatch
      return {
        contentId: slug,
        contentType: contentType === 'tvepisode' ? 'vod' : contentType,
        catalogType: contentType,
        title: slug,
      }
    }

    const showMatch = inputUrl.match(/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/)
    if (showMatch) {
      const [, series, contentType, season, episode] = showMatch
      const slug = contentType === 'movie'
        ? `${series}/movie/s${season}-e${episode}`
        : `${series}/episodes/s${season}-e${episode}`

      return {
        contentId: slug, // Will resolve to contentId via getContentBySlug
        contentType: contentType === 'movie' ? 'movie' : 'vod',
        catalogType: contentType === 'movie' ? 'movie' : 'tvepisode',
        title: series,
      }
    }

    // TVNZ series/season URL pattern: /tvseries/{slug} or /tvseries/{slug}?season={id}
    const seriesMatch = inputUrl.match(/\/tvseries\/([^/?#]+)/)
    if (seriesMatch) {
      const [, slug] = seriesMatch
      return {
        contentId: slug,
        contentType: 'tvseries',
        catalogType: 'tvseries',
        title: slug,
      }
    }

    const sportMatch = inputUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/)
    if (sportMatch) {
      const [, category, subcategory, slug] = sportMatch
      return {
        contentId: slug,
        contentType: 'sport',
        catalogType: 'sport',
        title: `${category}/${subcategory}/${slug}`,
      }
    }

    // Default: treat as slug directly
    return {
      contentId: inputUrl,
      contentType: 'vod',
      catalogType: 'tvepisode',
      title: inputUrl,
    }
  }

  /**
   * List episodes for a series.
   * @param {string} seriesSlug - Series slug (e.g., 'bluey')
   * @param {string} [seasonId] - Optional season ID to filter
   * @returns {Promise<Array>} Array of episode info objects
   */
  async listSeriesEpisodes(seriesSlug, seasonId = null) {
    Log.info('=== listSeriesEpisodes START ===')
    Log.info(`seriesSlug: ${seriesSlug}, seasonId: ${seasonId || 'all'}`)

    // First get series info to get the series ID
    const seriesData = await this._getContentBySlug('tvseries', seriesSlug)
    if (!seriesData?.data?.id) {
      throw new Error(`Series not found: ${seriesSlug}`)
    }

    const seriesId = seriesData.data.id
    Log.info(`Series ID: ${seriesId}`)

    // Get all seasons
    const seasonsData = await this._getSeriesSeasons(seriesId)
    const seasons = seasonsData.data || []
    Log.info(`Found ${seasons.length} seasons`)

    const allEpisodes = []

    // Get episodes for each season (or just the specified season)
    const targetSeasons = seasonId
      ? seasons.filter(s => s.id === seasonId)
      : seasons

    for (const season of targetSeasons) {
      Log.info(`Fetching episodes for season ${season.snum} (${season.id})`)
      const episodesData = await this._getSeasonEpisodes(seriesId, season.id)

      if (episodesData?.data) {
        for (const ep of episodesData.data) {
          allEpisodes.push({
            id: ep.id,
            slug: ep.nu, // episode slug used in URLs
            title: ep.lon?.[0]?.n || ep.lostl?.[0]?.n || 'Unknown',
            seasonNumber: ep.snum,
            episodeNumber: ep.enum,
            seasonId: season.id,
            seasonLabel: ep.lostl?.[0]?.n || `Season ${ep.snum}`,
            // Full episode URL pattern
            url: `https://www.tvnz.co.nz/player/tvepisode/${ep.nu}`,
          })
        }
      }
    }

    Log.info(`Total episodes: ${allEpisodes.length}`)
    Log.info('=== listSeriesEpisodes END ===')

    return allEpisodes
  }

  async _getSeriesSeasons(seriesId) {
    const params = {
      pageNumber: 1,
      pageSize: 30,
      sortBy: 'asc',
      sortOrder: 'desc',
      reg: 'nz',
      dt: 'web',
      client: 'tvnz-tvnz-web',
      pf: 'Regular',
      allowpg: 'true',
    }

    const url = `${DATA_STORE_BASE}/content/series/${seriesId}/seasons?${new URLSearchParams(params)}`
    return this.httpClient.get(url, {
      headers: await this.authManager.getHeaders(),
    })
  }

  async _getSeasonEpisodes(seriesId, seasonId) {
    const params = {
      seasonId,
      pageNumber: 1,
      pageSize: 50,
      sortBy: 'epnum',
      sortOrder: 'asc',
      reg: 'nz',
      dt: 'web',
      client: 'tvnz-tvnz-web',
      pf: 'Regular',
      allowpg: 'true',
    }

    const url = `${DATA_STORE_BASE}/content/series/${seriesId}/episodes?${new URLSearchParams(params)}`
    return this.httpClient.get(url, {
      headers: await this.authManager.getHeaders(),
    })
  }

  async _authorizeEdgeApi(contentId, contentType, catalogType) {
    Log.info('=== _authorizeEdgeApi START ===')
    Log.info(`contentId: ${contentId}, contentType: ${contentType}, catalogType: ${catalogType}`)

    // The Edge API expects:
    // - Authorization: Bearer {edgeApiToken from client credentials flow}
    // - x-authorization: {xAuthToken from Edge token response}
    // - x-device-id: JWT generated from deviceId + deviceSecret

    // edgeApiToken is obtained via client credentials OAuth (different from session oAuthToken)
    // xAuthToken is for x-authorization header (EME format, ~1305 chars)
    // accessToken is the Evergent token for deviceToken field

    // Get fresh edgeApiToken via client credentials
    Log.info('Fetching fresh edgeApiToken via client credentials...')
    const tokenResult = await this.authManager._getEdgeApiToken()
    const edgeApiToken = tokenResult.accessToken
    this.authManager.setEdgeApiToken(edgeApiToken)
    Log.info(`edgeApiToken obtained, length: ${edgeApiToken.length}`)

    const xAuthToken = this.authManager.getXAuthToken()
    const accessToken = this.authManager.getAccessToken()  // Evergent token

    Log.info(`xAuthToken: ${xAuthToken ? 'present (' + xAuthToken.length + ' chars)' : 'MISSING'}`)
    Log.info(`accessToken (Evergent): ${accessToken ? 'present (' + accessToken.length + ' chars)' : 'MISSING'}`)
    Log.info(`deviceId: ${this.authManager.deviceId}`)
    Log.info(`deviceSecret: ${this.authManager.deviceSecret ? 'present' : 'MISSING'}`)

    if (!edgeApiToken) {
      throw new ProviderError('No edgeApiToken available for Edge API authorization', {})
    }

    // Generate device JWT if we have device secret
    let deviceJwt = null
    if (this.authManager.deviceSecret && this.authManager.deviceId) {
      Log.info('Generating device JWT...')
      deviceJwt = this._generateDeviceTokenJwt(
        this.authManager.deviceId,
        this.authManager.deviceSecret,
        30
      )
      Log.info(`deviceJwt generated, length: ${deviceJwt.length}`)
    } else {
      Log.warn('No deviceSecret - x-device-id header will NOT be sent')
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${edgeApiToken}`,
      'x-client-id': 'tvnz-tvnz-mobileweb',
      'x-device-type': 'web',
      'x-authorization': xAuthToken,
    }

    if (deviceJwt) {
      headers['x-device-id'] = deviceJwt
    }

    Log.info('=== Edge API Request Headers ===')
    Log.info(`  Authorization: Bearer ${edgeApiToken.slice(0, 20)}... (${edgeApiToken.length} chars)`)
    Log.info(`  x-authorization: ${xAuthToken ? xAuthToken.slice(0, 20) + '... (' + xAuthToken.length + ' chars)' : 'MISSING'}`)
    Log.info(`  x-device-id: ${deviceJwt ? deviceJwt.slice(0, 20) + '... (' + deviceJwt.length + ' chars)' : 'NOT SET'}`)
    Log.info(`  x-client-id: tvnz-tvnz-mobileweb`)
    Log.info(`  x-device-type: web`)

    // Use device JWT as deviceToken when available (same as old implementation)
    const deviceToken = deviceJwt || accessToken || edgeApiToken

    const payload = {
      deviceName: 'mobileweb',
      deviceId: this.authManager.deviceId,
      contentId,
      contentTypeId: contentType,
      catalogType,
      mediaFormat: 'dash',
      drm: 'widevine',
      delivery: 'streaming',
      disableSsai: 'false',
      deviceManufacturer: 'web',
      deviceModelName: 'Chrome browser on macOS',
      deviceModelNumber: 'Chrome',
      deviceOs: 'Mozilla/5.0',
      supportedAudioCodecs: 'mp4a',
      supportedVideoCodecs: 'avc,hevc,av01',
      supportedMaxWVSecurityLevel: 'L3',
      deviceToken,
      urlParameters: {
        vpa: 'click',
        rdid: this.authManager.deviceId,
        is_lat: '0',
        npa: '0',
        idtype: 'dpid',
        endpoint: 'web',
        'endpoint-group': 'desktop',
        endpoint_detail: 'desktop',
      },
    }

    Log.info('=== Edge API Request Payload ===')
    Log.info(`URL: POST ${EDGE_API_BASE}/media/content/authorize`)
    Log.info(`deviceName: ${payload.deviceName}`)
    Log.info(`deviceId: ${payload.deviceId}`)
    Log.info(`contentId: ${payload.contentId}`)
    Log.info(`contentTypeId: ${payload.contentTypeId}`)
    Log.info(`catalogType: ${payload.catalogType}`)
    Log.info(`deviceToken: ${payload.deviceToken ? payload.deviceToken.slice(0, 20) + '...' : 'MISSING'}`)

    // Use fetch directly (like original) for proper error body capture
    Log.info('Making Edge API request...')
    const startTime = Date.now()
    const response = await fetch(`${EDGE_API_BASE}/media/content/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    // Log to HAR if enabled
    if (this.httpClient?.logHarResponse) {
      await this.httpClient.logHarResponse(
        response,
        `${EDGE_API_BASE}/media/content/authorize`,
        'POST',
        headers,
        JSON.stringify(payload),
        startTime
      )
    }

    const responseText = await response.text()
    Log.info(`=== Edge API Response ===`)
    Log.info(`Status: ${response.status}`)
    Log.info(`Body: ${responseText.slice(0, 500)}`)

    let data
    try {
      data = JSON.parse(responseText)
    } catch (e) {
      Log.error('Failed to parse response as JSON:', e.message)
      throw new ProviderError(`Content authorize response invalid: ${responseText.slice(0, 200)}`, {})
    }

    if (data.header?.errors?.length > 0) {
      Log.error('Edge API errors:', JSON.stringify(data.header.errors))
    }

    if (!data?.data?.contentUrl) {
      Log.error('No contentUrl in response - authorization failed')
      throw new ProviderError('TVNZ content authorization failed', { response: data })
    }

    Log.info(`contentUrl: ${data.data.contentUrl.slice(0, 80)}...`)
    Log.info(`licenseUrl: ${data.data.licenseUrl}`)
    Log.info('=== _authorizeEdgeApi END ===')

    return data.data
  }

  /**
   * Generate a device JWT token for Edge API device authentication.
   * @param {string} deviceId
   * @param {string} deviceSecret - base64 encoded secret
   * @param {number} expiresIn - expiry in seconds
   * @returns {string} JWT token
   */
  _generateDeviceTokenJwt(deviceId, deviceSecret, expiresIn = 30) {
    const { createHmac } = require('crypto')
    const now = Math.floor(Date.now() / 1000)
    const expiry = now + expiresIn

    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = {
      deviceId,
      aud: 'playback-auth-service',
      iat: now,
      exp: expiry
    }

    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url')
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url')

    const signingInput = `${base64Header}.${base64Payload}`
    // Device secret is stored as base64 encoded - decode before using as HMAC key
    const decodedSecret = Buffer.from(deviceSecret, 'base64')
    const signature = createHmac('sha256', decodedSecret)
      .update(signingInput)
      .digest('base64url')

    return `${base64Header}.${base64Payload}.${signature}`
  }

  async _createSsaiSession(mtSessionUrl, playerParams) {
    const response = await this.authManager.createSsaiSession(mtSessionUrl, playerParams)
    return response
  }

  async _extractPssh(manifestUrl) {
    const manifest = await this.getManifest(manifestUrl)

    // Find all cenc:pssh occurrences - there are multiple (for video, audio, etc.)
    // We need one that starts with 'AAAA' (valid PSSH base64 starts with this)
    const startTag = '<cenc:pssh>'
    const endTag = '</cenc:pssh>'

    let searchStart = 0
    let foundValid = false
    let result = null

    // Search through all cenc:pssh occurrences
    while (!foundValid) {
      const startIdx = manifest.raw?.indexOf(startTag, searchStart)
      const endIdx = manifest.raw?.indexOf(endTag, startIdx)

      if (startIdx === -1 || endIdx === -1) break

      const psshContent = manifest.raw?.slice(startIdx + startTag.length, endIdx)
      // Valid PSSH base64 starts with 'AAAA' (not '>' or other chars)
      if (psshContent?.trim().startsWith('AAAA')) {
        result = psshContent.trim()
        foundValid = true
        break
      }

      searchStart = endIdx + endTag.length
    }

    return result
  }

  async _getContentBySlug(contentType, slug) {
    const params = {
      reg: 'nz',
      dt: 'web',
      client: 'tvnz-tvnz-web',
      pf: 'Regular',
      allowpg: 'true',
    }

    const url = `${DATA_STORE_BASE}/content/urn/resource/catalog/${contentType}/${slug}`
    const fullUrl = `${url}?${new URLSearchParams(params).toString()}`

    const data = await this.httpClient.get(fullUrl, {
      headers: await this.authManager.getHeaders(),
    })

    return data
  }

  /**
   * Fetch Widevine DRM decryption keys.
   * @param {string} pssh - Base64-encoded PSSH box
   * @param {string} licenseUrl - Widevine license server URL
   * @param {Object} [options]
   * @param {string} [options.wvdDevicePath] - Path to .wvd device file
   * @param {string} [options.accessToken] - Edge API access token
   * @param {string} [options.heartbeatToken] - Heartbeat/authorization token
   * @returns {Promise<Array<string>>} Array of 'kid:key' strings
   */
  async getKeys(pssh, licenseUrl, options = {}) {
    // Get fresh edgeApiToken via client credentials (same as old src app's _ensureEdgeApiToken)
    const tokenResult = await this.authManager._getEdgeApiToken()
    const edgeApiToken = tokenResult.accessToken
    return getWidevineKeys({
      pssh,
      licenseUrl,
      wvdDevicePath: options.wvdDevicePath || process.env.WVDEVICE_PATH || './device.wvd',
      origin: 'https://www.tvnz.co.nz',
      referer: 'https://www.tvnz.co.nz/',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      // accessToken is used for Authorization: Bearer header in Widevine license request
      // For TVNZ, this should be the client-credentials edgeApiToken (not the Evergent accessToken)
      accessToken: edgeApiToken,
    })
  }
}

export default TvnzProvider