/**
 * TVNZ Provider - Updated for new API architecture
 *
 * Authentication: OTP-based via Evergent (rest-prod-tvnz.evergentpd.com)
 * Video Playback: Edge API (watch-cdn.edge-api.tvnz.co.nz)
 * Content API: Data Store API (data-store-cdn.cms-api.tvnz.co.nz)
 * Widevine DRM: widevine-proxy-cdn.edge-api.tvnz.co.nz
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DOMParser } from 'xmldom';
import { MediaProvider } from '../contracts/provider.mjs';
import { extractManifestWidevineData, getWidevineKeys } from '../infra/brightcove-media.mjs';
import { buildDownloadPlan, executeDownloadPlan } from '../application/media-pipeline.mjs';
import { fetchJson, fetchText, postFormEncoded, createTimeoutSignal } from '../infra/http-client.mjs';
import RetentionStore from '../infra/retention-store.mjs';
import { inspectManifestUrl } from '../n3u8dl-node/index.mjs';
import {
    loadFromEnv,
    generateDeviceId,
    validateCredentials,
    findMostRecentSessionFile
} from '../infra/tvnz-session.mjs';
import {
    searchAccount,
    createOTP,
    confirmOTP,
    getEdgeApiToken,
    registerDevice,
    refreshAccessToken,
    validateAuthCredentials,
    generateDeviceTokenJwt,
    createSsaiSession
} from '../infra/tvnz-auth.mjs';

// Base URLs
const EVERGENT_BASE = 'https://rest-prod-tvnz.evergentpd.com/tvnz';
const EDGE_API_BASE = 'https://watch-cdn.edge-api.tvnz.co.nz';
const DATA_STORE_BASE = 'https://data-store-cdn.cms-api.tvnz.co.nz';
const VOD_ORIGIN_BASE = 'https://vod-origin-cdn.cms-api.tvnz.co.nz';
const WIDEVINE_PROXY_BASE = 'https://widevine-proxy-cdn.edge-api.tvnz.co.nz';
const IMAGE_RESIZER_BASE = 'https://image-resizer-cloud-cdn.cms-api.tvnz.co.nz';

// Client credentials for Edge API
const EDGE_CLIENT_ID = 'webclient-ui-app';
const EDGE_CLIENT_SECRET = 'f99d00b8-5b20-4c27-983d-d2895f3e9fec';

// Color output helpers
const bcolors = {
    LIGHTBLUE: '\x1b[94m',
    RED: '\x1b[91m',
    GREEN: '\x1b[92m',
    YELLOW: '\x1b[93m',
    ENDC: '\x1b[0m'
};

// Section: TVNZ API Class
export class TVNZAPI {
    constructor() {
        // Auth state
        this.accessToken = null;
        this.refreshToken = null;
        this.edgeApiToken = null;
        this.xAuthToken = null;
        this.deviceId = null;
        this.contactId = null;
        this.customerId = null;
        this.profileId = null;
        this.expiresAt = 0;

        // Device registration
        this.deviceSecret = null;

        // Retention store
        this.retention = null;

        // Manifest cache
        this.manifestCache = new Map();
        this.manifestSummaryCache = new Map();

        // Default headers
        this.defaultHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Origin': 'https://www.tvnz.co.nz',
            'Referer': 'https://www.tvnz.co.nz/'
        };

        // Cookies
        this.cookies = new Map();
    }

    setRetention(retention) {
        this.retention = retention;
    }

    _retainJson(filename, payload) {
        if (this.retention) {
            this.retention.writeJson(filename, payload);
        }
    }

    _retainText(filename, payload) {
        if (this.retention) {
            this.retention.writeText(filename, payload);
        }
    }

    /**
     * Load credentials from various sources
     * Priority: constructor > env vars > file
     */
    loadCredentials(credentials = null) {
        // If credentials passed directly, use them
        if (credentials && typeof credentials === 'object') {
            this.accessToken = credentials.accessToken || null;
            this.refreshToken = credentials.refreshToken || null;
            this.edgeApiToken = credentials.edgeApiToken || credentials.oAuthToken || null;
            this.xAuthToken = credentials.xAuthToken || null;
            this.deviceId = credentials.deviceId || credentials.deviceref || null;
            this.contactId = credentials.contactId || null;
            this.customerId = credentials.customerId || null;
            this.profileId = credentials.profileId || null;
            this.expiresAt = credentials.expiresAt || 0;

            // Extract device secret from stored CONTENT_AUTHORIZER token if present
            if (credentials['CONTENT_AUTHORIZER_STORE_NAME_CONTENT_AUTHORIZER_STORE_ACCESS_TOKEN']) {
                try {
                    const caStore = JSON.parse(credentials['CONTENT_AUTHORIZER_STORE_NAME_CONTENT_AUTHORIZER_STORE_ACCESS_TOKEN']);
                    this.deviceSecret = caStore?.value?.secret || null;
                } catch (e) {
                    // Ignore parse errors
                }
            }
            // Also check for deviceSecret directly in credentials
            if (credentials.deviceSecret) {
                this.deviceSecret = credentials.deviceSecret;
            }
            return;
        }

        // Load from environment variables
        const envCreds = loadFromEnv();
        this.accessToken = envCreds.accessToken;
        this.refreshToken = envCreds.refreshToken;
        this.edgeApiToken = envCreds.edgeApiToken;
        this.xAuthToken = envCreds.xAuthToken;
        this.deviceId = envCreds.deviceId || envCreds.deviceref || generateDeviceId();
        this.contactId = envCreds.contactId;
        this.customerId = envCreds.customerId;
        this.profileId = envCreds.profileId;
    }

    _authHeaders(extra = {}) {
        const headers = {
            ...this.defaultHeaders,
            ...extra
        };

        const cookieHeader = this._cookieHeader();
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        return headers;
    }

    _edgeHeaders(extra = {}) {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.edgeApiToken}`,
            'x-client-id': 'tvnz-tvnz-mobileweb',
            'x-device-type': 'web',
            ...extra
        };

        // Add X-Authorization if we have it
        if (this.xAuthToken) {
            headers['x-authorization'] = this.xAuthToken;
        }

        return headers;
    }

    _captureCookies(response) {
        const raw = response.headers.get('set-cookie');
        if (!raw) return;

        const cookieParts = raw.split(/,(?=[^;=]+=[^;]+)/g);
        for (const cookie of cookieParts) {
            const firstPart = cookie.split(';', 1)[0];
            const eq = firstPart.indexOf('=');
            if (eq > 0) {
                const key = firstPart.slice(0, eq).trim();
                const value = firstPart.slice(eq + 1).trim();
                this.cookies.set(key, value);
            }
        }
    }

    _cookieHeader() {
        if (!this.cookies.size) return '';
        return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /**
     * Check if Edge API token is valid or needs refresh
     */
    async _ensureEdgeApiToken() {
        if (this.edgeApiToken) return;

        // Use client credentials to get a new token
        const result = await getEdgeApiToken();
        this.edgeApiToken = result.accessToken;
        this._retainText('raw/edge_api_token.txt', result.accessToken);
    }

    /**
     * Ensure we have a valid access token (refresh if needed)
     */
    async _ensureAccessToken() {
        console.log(`${bcolors.LIGHTBLUE}[DEBUG] _ensureAccessToken: checking tokens${bcolors.ENDC}`);
        console.log(`  accessToken: ${this.accessToken ? 'present (' + this.accessToken.slice(0, 20) + '...' : 'MISSING'}`);
        console.log(`  refreshToken: ${this.refreshToken ? 'present' : 'MISSING'}`);
        console.log(`  expiresAt: ${this.expiresAt} (now: ${Date.now()})`);

        // If we have a valid access token that's not expired, use it
        if (this.accessToken) {
            // If no expiresAt (or 0), we can't verify expiry - treat as potentially valid (trust browser session)
            // But if expiresAt is set AND token is expired, try to refresh
            if (this.expiresAt && this.expiresAt > 0 && Date.now() < this.expiresAt - 300000) {
                console.log(`${bcolors.LIGHTBLUE}[DEBUG] _ensureAccessToken: using existing valid token${bcolors.ENDC}`);
                return; // Token still valid (5 min buffer)
            }
            // If expiresAt is 0 or missing, we assume the browser session token is still valid
            if (!this.expiresAt || this.expiresAt <= 0) {
                console.log(`${bcolors.LIGHTBLUE}[DEBUG] _ensureAccessToken: no expiresAt, trusting browser session token${bcolors.ENDC}`);
                return;
            }
            // Token exists but may be expired - try to refresh
            if (this.refreshToken) {
                try {
                    console.log(`${bcolors.LIGHTBLUE}[DEBUG] _ensureAccessToken: attempting refresh${bcolors.ENDC}`);
                    const result = await refreshAccessToken(this.refreshToken, null, {
                        deviceId: this.deviceId
                    });
                    this.accessToken = result.accessToken;
                    this.refreshToken = result.refreshToken || this.refreshToken;
                    this.expiresAt = result.expiresAt;
                    this.contactId = this.contactId || result.contactID;
                    this.customerId = this.customerId || result.customerID;
                    this._retainJson('raw/token_refresh_response.json', result);
                    console.log(`${bcolors.LIGHTBLUE}[DEBUG] _ensureAccessToken: refresh successful${bcolors.ENDC}`);
                    return;
                } catch (e) {
                    // Refresh failed - fall through to try with existing token anyway
                    console.log(`${bcolors.YELLOW}[WARN] Token refresh failed: ${e.message}, continuing with existing token${bcolors.ENDC}`);
                }
            }
        }
        // No access token available
        console.error(`${bcolors.RED}[DEBUG] _ensureAccessToken: No access token available${bcolors.ENDC}`);
        throw new Error('No access token available. Please provide valid credentials.');
    }

    /**
     * Register device with Edge API (required before playback)
     */
    async _registerDevice() {
        if (this.deviceSecret) {
            console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: deviceSecret already set, skipping${bcolors.ENDC}`);
            return; // Already registered
        }

        await this._ensureEdgeApiToken();

        // Generate device ID if not present
        if (!this.deviceId) {
            this.deviceId = generateDeviceId();
            console.log(`${bcolors.YELLOW}[WARN] Generated new deviceId: ${this.deviceId}${bcolors.ENDC}`);
        }

        console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: Registering device: ${this.deviceId}${bcolors.ENDC}`);
        console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: edgeApiToken: ${this.edgeApiToken ? this.edgeApiToken.slice(0, 20) + '...' : 'MISSING'}${bcolors.ENDC}`);
        console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: xAuthToken: ${this.xAuthToken ? this.xAuthToken.slice(0, 20) + '...' : 'MISSING'}${bcolors.ENDC}`);

        // Try device registration - it may fail if device already registered
        try {
            console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: Calling registerDevice...${bcolors.ENDC}`);
            const result = await registerDevice(this.deviceId, this.edgeApiToken, this.xAuthToken);
            console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: Registration result: ${JSON.stringify(result)}${bcolors.ENDC}`);
            this.deviceSecret = result.secret;
            this._retainJson('parsed/device_registration.json', result);
        } catch (e) {
            console.log(`${bcolors.YELLOW}[DEBUG] _registerDevice: Registration failed: ${e.message}${bcolors.ENDC}`);
            // If device already registered, we can still proceed - the secret might be cached
            if (e.message.includes('already') || e.message.includes('exists')) {
                console.log(`${bcolors.YELLOW}[WARN] Device may already be registered, continuing...${bcolors.ENDC}`);
                this.deviceSecret = 'cached'; // Use cached value
            } else {
                // Check if the error indicates we can proceed without registration
                console.log(`${bcolors.YELLOW}[WARN] Device registration warning: ${e.message}${bcolors.ENDC}`);
                // Continue anyway - some content may not require device registration
            }
        }
        console.log(`${bcolors.LIGHTBLUE}[DEBUG] _registerDevice: After registration, deviceSecret: ${this.deviceSecret ? '(set)' : 'null'}${bcolors.ENDC}`);
    }

    /**
     * Search for an account by email
     */
    async searchAccount(email) {
        const result = await searchAccount(email);
        this._retainJson('raw/search_account_response.json', result);
        return result;
    }

    /**
     * Create (send) OTP to email
     */
    async sendOTP(email) {
        const result = await createOTP(email);
        this._retainJson('raw/create_otp_response.json', result);
        return result;
    }

    /**
     * Confirm OTP and store tokens
     */
    async confirmOTP(email, otp) {
        const result = await confirmOTP(email, otp, {
            deviceId: this.deviceId
        });

        this.accessToken = result.accessToken;
        this.refreshToken = result.refreshToken;
        this.expiresAt = result.expiresAt;
        this.contactId = result.contactID;
        this.customerId = result.customerID;
        this.deviceId = result.deviceId;

        this._retainJson('raw/confirm_otp_response.json', result);
        return result;
    }

    /**
     * Get Edge API token using client credentials
     */
    async getEdgeApiToken() {
        const result = await getEdgeApiToken();
        this.edgeApiToken = result.accessToken;
        this._retainText('raw/edge_api_token.txt', result.accessToken);
        return result;
    }

    /**
     * Login with credentials (automated OTP flow)
     * Note: This requires user interaction to get OTP from email
     * For fully automated login, provide pre-extracted tokens instead
     */
    async login(email, otp) {
        await this.sendOTP(email);
        await this.confirmOTP(email, otp);
        await this.getEdgeApiToken();
        console.info(`${bcolors.OKGREEN}Login successful${bcolors.ENDC}`);
    }

    /**
     * Login with pre-extracted session tokens (no OTP needed)
     */
    async loginWithSession(credentials) {
        this.loadCredentials(credentials);

        if (!this.accessToken && !this.refreshToken) {
            throw new Error('No access token or refresh token provided');
        }

        // Try to ensure we have a valid access token
        if (!this.accessToken && this.refreshToken) {
            await this._ensureAccessToken();
        }

        // Ensure we have Edge API token
        if (!this.edgeApiToken) {
            await this._ensureEdgeApiToken();
        }

        console.info(`${bcolors.OKGREEN}Session login successful${bcolors.ENDC}`);
    }

    /**
     * Get content details from Data Store API
     * @param {string} contentType - e.g., 'tvepisode', 'movie', 'show'
     * @param {string} slug - Content slug
     */
    async getContent(contentType, slug) {
        const url = `${DATA_STORE_BASE}/content/urn/resource/catalog/${contentType}/${slug}`;
        const params = {
            reg: 'nz',
            dt: 'web',
            client: 'tvnz-tvnz-web',
            pf: 'Regular',
            allowpg: 'true'
        };

        const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;
        const data = await fetchJson(fullUrl, {
            headers: this._authHeaders()
        });

        this._retainJson(`raw/content_${contentType}_${slug.replace(/[^a-z0-9]/gi, '_')}.json`, data);
        return data;
    }

    /**
     * Get content by slug directly (for player URLs)
     * @param {string} slug - Content slug
     */
    async getContentBySlug(slug) {
        // Try multiple content types to find the content
        const contentTypes = ['tvepisode', 'movie', 'show', 'sport'];
        for (const contentType of contentTypes) {
            try {
                const data = await this.getContent(contentType, slug);
                if (data?.header?.code === 0 || data?.data) {
                    return data;
                }
            } catch (e) {
                // Continue to next type
            }
        }
        // Fallback: try as-is with tvepisode
        return this.getContent('tvepisode', slug);
    }

    /**
     * Get series seasons
     */
    async getSeriesSeasons(seriesId) {
        const url = `${DATA_STORE_BASE}/content/series/${seriesId}/seasons`;
        const params = {
            pageNumber: '1',
            pageSize: '30',
            sortBy: 'snum',
            sortOrder: 'desc',
            reg: 'nz',
            dt: 'web',
            client: 'tvnz-tvnz-web',
            pf: 'Regular',
            allowpg: 'true'
        };

        const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;
        const data = await fetchJson(fullUrl, {
            headers: this._authHeaders()
        });

        this._retainJson(`raw/series_seasons_${seriesId}.json`, data);
        return data;
    }

    /**
     * Get episodes for a season
     */
    async getSeasonEpisodes(seriesId, seasonId) {
        const url = `${DATA_STORE_BASE}/content/series/${seriesId}/episodes`;
        const params = {
            seasonId,
            pageNumber: '1',
            pageSize: '30',
            sortBy: 'epnum',
            sortOrder: 'asc',
            reg: 'nz',
            dt: 'web',
            client: 'tvnz-tvnz-web',
            pf: 'Regular',
            allowpg: 'true'
        };

        const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;
        const data = await fetchJson(fullUrl, {
            headers: this._authHeaders()
        });

        this._retainJson(`raw/season_episodes_${seasonId}.json`, data);
        return data;
    }

    /**
     * Authorize content for playback via Edge API
     * This is the replacement for Brightcove playback API
     */
    async authorizeContent(contentId, contentType = 'vod', catalogType = 'tvepisode') {
        await this._ensureAccessToken();
        await this._registerDevice();

        const url = `${EDGE_API_BASE}/media/content/authorize`;

        // Generate device token JWT if we have a device secret
        let deviceToken = this.accessToken;
        if (this.deviceSecret && this.deviceId) {
            deviceToken = generateDeviceTokenJwt(this.deviceId, this.deviceSecret, 30);
        }

        const payload = {
            deviceName: 'mobileweb',
            deviceId: this.deviceId,
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
            deviceOs: this.defaultHeaders['User-Agent'],
            supportedAudioCodecs: 'mp4a',
            supportedVideoCodecs: 'avc,hevc,av01',
            supportedMaxWVSecurityLevel: 'L3',
            deviceToken,
            urlParameters: {
                vpa: 'click',
                rdid: this.deviceId,
                is_lat: '0',
                npa: '0',
                idtype: 'dpid',
                endpoint: 'web',
                'endpoint-group': 'desktop',
                endpoint_detail: 'desktop'
            }
        };

        // Build headers for content authorize - Authorization with oAuthToken is required
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.edgeApiToken}`,
            'x-client-id': 'tvnz-tvnz-mobileweb',
            'x-device-type': 'web',
            'x-authorization': this.xAuthToken
        };
        // Add x-device-id header with JWT if we have device secret
        if (this.deviceSecret && this.deviceId) {
            headers['x-device-id'] = deviceToken;
        }

        console.log(`${bcolors.LIGHTBLUE}[DEBUG] Content authorize request:${bcolors.ENDC}`);
        console.log(`  URL: ${url}`);
        console.log(`  Headers.Authorization: ${this.edgeApiToken ? this.edgeApiToken.slice(0, 30) + '...' : 'MISSING'}`);
        console.log(`  Headers.x-authorization: ${this.xAuthToken ? this.xAuthToken.slice(0, 30) + '...' : 'MISSING'}`);
        console.log(`  Headers.x-device-id: ${headers['x-device-id'] ? headers['x-device-id'].slice(0, 30) + '...' : 'NOT SET'}`);
        console.log(`  payload.deviceToken: ${deviceToken.slice(0, 30)}...`);
        console.log(`  payload.contentId: ${contentId}`);
        console.log(`  payload.contentTypeId: ${contentType}`);
        console.log(`  payload.catalogType: ${catalogType}`);

        const startTime = Date.now();
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: createTimeoutSignal()
        });

        // Log to HAR if enabled
        if (this.httpClient?.logHarResponse) {
            await this.httpClient.logHarResponse(
                response,
                url,
                'POST',
                headers,
                JSON.stringify(payload),
                startTime
            );
        }

        const responseText = await response.text();
        console.log(`${bcolors.LIGHTBLUE}[DEBUG] Content authorize response status: ${response.status}${bcolors.ENDC}`);

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            console.error(`${bcolors.RED}[DEBUG] Failed to parse response as JSON:${bcolors.ENDC}`, responseText.slice(0, 500));
            throw new Error(`Content authorize response invalid: ${responseText.slice(0, 200)}`);
        }

        this._retainJson('raw/content_authorize_response.json', data);

        console.log(`${bcolors.LIGHTBLUE}[DEBUG] Content authorize response data:${bcolors.ENDC}`, JSON.stringify(data, null, 2));

        if (!data.data?.contentUrl) {
            console.error(`${bcolors.RED}[ERROR] Content authorization failed:${bcolors.ENDC}`, JSON.stringify(data, null, 2));
            throw new Error(`Content authorization failed: ${data.header?.message || 'No content URL returned'}`);
        }

        return data.data;
    }

    /**
     * Get video ID from various URL formats
     */
    async getVideoIdFromUrl(videoUrl) {
        // Format 1: /shows/{series}/episodes/s{season}-e{episode}
        const matchShow = videoUrl.match(/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/);
        if (matchShow) {
            const [, seriesName, contentType, season, episode] = matchShow;
            return this.findVideoIdInShow(seriesName, contentType, season, episode);
        }

        // Format 2: /sport/{category}/{subcategory}/{slug}
        const matchSport = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
        if (matchSport) {
            const [, category, subcategory, slug] = matchSport;
            return this.findVideoIdInSport(category, subcategory, slug);
        }

        // Format 3: /player/{type}/{slug}
        const matchPlayer = videoUrl.match(/\/player\/([^/]+)\/([^/]+)/);
        if (matchPlayer) {
            const [, contentType, slug] = matchPlayer;
            return { slug, contentType, catalogType: contentType, isPlayerUrl: true };
        }

        throw new Error(`Could not parse video URL: ${videoUrl}`);
    }

    /**
     * Find video ID in show/episode data
     */
    async findVideoIdInShow(seriesName, contentType, season, episode) {
        const slug = contentType === 'movie'
            ? `${seriesName}/movie/s${season}-e${episode}`
            : `${seriesName}/episodes/s${season}-e${episode}`;

        const data = await this.getContent(contentType === 'movie' ? 'movie' : 'tvepisode', slug);

        // Look for video ID in response
        const videoId = this._findVideoIdInData(data);
        if (videoId) {
            return {
                contentId: videoId,
                contentType: contentType === 'movie' ? 'movie' : 'vod',
                catalogType: contentType === 'movie' ? 'movie' : 'tvepisode'
            };
        }

        // Try to find series ID and look up episode
        const seriesId = this._findSeriesIdInData(data);
        if (seriesId) {
            const seasons = await this.getSeriesSeasons(seriesId);
            const seasonId = this._findSeasonId(seasons, Number(season));
            if (seasonId) {
                const episodes = await this.getSeasonEpisodes(seriesId, seasonId);
                const episodeData = this._findEpisodeInData(episodes, Number(episode));
                if (episodeData) {
                    return {
                        contentId: episodeData.contentId || episodeData.id,
                        contentType: 'vod',
                        catalogType: 'tvepisode'
                    };
                }
            }
        }

        throw new Error(`Could not find video ID for ${slug}`);
    }

    /**
     * Find video ID in sport content
     */
    async findVideoIdInSport(category, subcategory, slug) {
        const data = await this.getContent('sport', `${category}/${subcategory}/${slug}`);
        return {
            contentId: slug,
            contentType: 'sport',
            catalogType: 'sport'
        };
    }

    _findVideoIdInData(data) {
        // Look for brightcoveVideoId or contentId in the data
        const search = (obj) => {
            if (!obj || typeof obj !== 'object') return null;

            if (obj.brightcoveVideoId) return obj.brightcoveVideoId;
            if (obj.contentId) return obj.contentId;
            if (obj.id && typeof obj.id === 'string' && obj.id.includes('-')) return obj.id;

            for (const value of Object.values(obj)) {
                const found = search(value);
                if (found) return found;
            }
            return null;
        };

        return search(data);
    }

    _findSeriesIdInData(data) {
        const search = (obj) => {
            if (!obj || typeof obj !== 'object') return null;

            if (obj.seriesId) return obj.seriesId;
            if (obj.series?.id) return obj.series.id;

            for (const value of Object.values(obj)) {
                const found = search(value);
                if (found) return found;
            }
            return null;
        };

        return search(data);
    }

    _findSeasonId(seasonsData, targetSeason) {
        const seasons = seasonsData?.data || [];
        const season = seasons.find(s => s.snum === targetSeason);
        return season?.id || season?.seasonId;
    }

    _findEpisodeInData(episodesData, targetEpisode) {
        const episodes = episodesData?.data || episodesData || [];
        return episodes.find(e => e.epnum === targetEpisode);
    }

    /**
     * Get PSSH from manifest
     */
    async getPssh(urlMpd) {
        if (!this.manifestCache.has(urlMpd)) {
            const text = await fetchText(urlMpd, {
                headers: this._authHeaders()
            });
            this.manifestCache.set(urlMpd, text);
            this._retainText('raw/manifest.mpd', text);
        }

        const manifestText = this.manifestCache.get(urlMpd);
        let summary = this.manifestSummaryCache.get(urlMpd);
        if (!summary) {
            summary = this._buildManifestSummary(urlMpd, manifestText);
            this.manifestSummaryCache.set(urlMpd, summary);
        }

        const details = extractManifestWidevineData(manifestText, urlMpd);
        if (!details.pssh) {
            return null;
        }

        this._retainJson('parsed/pssh_summary.json', {
            pssh_length: details.pssh.length,
            pssh_preview: `${details.pssh.slice(0, 32)}...`,
            manifest_url: urlMpd,
            manifest_type: summary.type,
            max_video_height: summary.max_video_height
        });

        return details.pssh;
    }

    _parseIsoDuration(durationValue) {
        if (!durationValue) return null;
        const match = durationValue.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
        if (!match) return null;
        const hours = Number(match[1] || 0);
        const minutes = Number(match[2] || 0);
        const seconds = Number(match[3] || 0);
        return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000) / 1000;
    }

    _buildManifestSummary(urlMpd, manifestText) {
        const doc = new DOMParser().parseFromString(manifestText, 'application/xml');
        const mpd = doc.documentElement;
        const adaptSets = Array.from(doc.getElementsByTagName('AdaptationSet'));

        const summary = {
            manifest_url: urlMpd,
            type: mpd.getAttribute('type'),
            profiles: mpd.getAttribute('profiles'),
            media_presentation_duration: mpd.getAttribute('mediaPresentationDuration'),
            media_presentation_duration_seconds: this._parseIsoDuration(mpd.getAttribute('mediaPresentationDuration')),
            min_buffer_time: mpd.getAttribute('minBufferTime'),
            adaptation_sets: [],
            video_representations: [],
            audio_representations: [],
            text_tracks: [],
            max_video_height: 0
        };

        for (const adaptation of adaptSets) {
            const mimeType = adaptation.getAttribute('mimeType');
            const reps = Array.from(adaptation.getElementsByTagName('Representation'));
            const adaptationSummary = {
                mime_type: mimeType,
                lang: adaptation.getAttribute('lang'),
                representation_count: reps.length
            };

            for (const representation of reps) {
                const repSummary = {
                    id: representation.getAttribute('id'),
                    bandwidth: Number(representation.getAttribute('bandwidth') || 0),
                    codecs: representation.getAttribute('codecs')
                };
                const height = representation.getAttribute('height');
                const width = representation.getAttribute('width');
                if (height) {
                    repSummary.height = Number(height);
                    summary.max_video_height = Math.max(summary.max_video_height, Number(height));
                }
                if (width) {
                    repSummary.width = Number(width);
                }

                if (mimeType === 'video/mp4') {
                    summary.video_representations.push(repSummary);
                } else if (mimeType === 'audio/mp4') {
                    summary.audio_representations.push(repSummary);
                } else if (mimeType === 'text/vtt') {
                    summary.text_tracks.push(repSummary);
                }
            }

            summary.adaptation_sets.push(adaptationSummary);
        }

        summary.available_resolutions = Array.from(new Set(summary.video_representations.map(x => x.height).filter(Boolean))).sort((a, b) => b - a);
        summary.selected_resolution = summary.max_video_height >= 1080 ? '1080p' : summary.max_video_height >= 720 ? '720p' : 'SD';
        return summary;
    }

    async getHighestResolution(urlMpd) {
        if (!this.manifestCache.has(urlMpd)) {
            const text = await fetchText(urlMpd, {
                headers: this._authHeaders()
            });
            this.manifestCache.set(urlMpd, text);
        }

        const summary = this._buildManifestSummary(urlMpd, this.manifestCache.get(urlMpd));
        this.manifestSummaryCache.set(urlMpd, summary);
        return summary.selected_resolution || 'SD';
    }

    /**
     * Get DRM keys
     */
    async getKeys(pssh, licenseUrl, wvdDevicePath, authorizationToken = null) {
        return getWidevineKeys({
            pssh,
            licenseUrl,
            wvdDevicePath,
            origin: 'https://www.tvnz.co.nz',
            referer: 'https://www.tvnz.co.nz/',
            userAgent: this.defaultHeaders['User-Agent'],
            authorizationToken,
            retention: this.retention,
            accessToken: this.edgeApiToken
        });
    }
}

// Section: TVNZ route-specific handlers
async function handleMediakindSportVideo(api, videoUrl, downloadsPath, wvdDevicePath, options = {}) {
    // Similar to original but updated for new API structure
    const match = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!match) {
        throw new Error(`Regex match failed for the URL: ${videoUrl}`);
    }

    const [_, category, subcategory, videoSlug] = match;
    const authorization = await api.authorizeContent(videoSlug, 'sport', 'sport');

    const mpdUrl = authorization.custom?.mtSessionUrl || authorization.contentUrl;
    const pssh = await api.getPssh(mpdUrl);
    if (!pssh) {
        throw new Error('Failed to extract PSSH data');
    }

    const licenseUrl = authorization.licenseUrl;
    const keys = await api.getKeys(pssh, licenseUrl, wvdDevicePath, authorization.heartbeatToken);
    const resolution = await api.getHighestResolution(mpdUrl);
    const formattedFileName = `${subcategory}.${videoSlug}`.replace(/-/g, '.').replace(/\.{2,}/g, '.').replace(/^./, (ch) => ch.toUpperCase()) + `.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;

    console.log(`${bcolors.LIGHTBLUE}MPD URL: ${bcolors.ENDC}${mpdUrl}`);
    console.log(`${bcolors.RED}License URL: ${bcolors.ENDC}${licenseUrl}`);
    console.log(`${bcolors.LIGHTBLUE}PSSH: ${bcolors.ENDC}${pssh}`);
    for (const key of keys) {
        console.log(`${bcolors.GREEN}KEYS: ${bcolors.ENDC}--key ${key}`);
    }

    const plan = buildDownloadPlan({
        mpdUrl,
        downloadsPath,
        saveName: formattedFileName,
        keys,
        selectVideo: options.selectVideo || 'best',
        selectAudio: options.selectAudio || 'best',
        selectSubtitle: options.selectSubtitle || 'all',
        requestHeaders: {
            'User-Agent': api.defaultHeaders['User-Agent'],
            Origin: api.defaultHeaders.Origin,
            Referer: api.defaultHeaders.Referer
        }
    });

    await executeDownloadPlan(plan);
}

// Section: TVNZ provider workflow
export async function getDownloadCommand(videoUrl, downloadsPath, wvdDevicePath, credentials, options = {}) {
    const retention = options.retention || new RetentionStore(downloadsPath, videoUrl, 'tvnz');
    retention.addEvent('start', { video_url: videoUrl, downloads_path: downloadsPath });

    const api = new TVNZAPI();
    api.setRetention(retention);

    // Determine login method
    const hasSessionTokens = credentials?.accessToken || credentials?.refreshToken;
    const hasEmailPassword = typeof credentials === 'string' && credentials.includes(':');

    console.log(`${bcolors.LIGHTBLUE}[DEBUG] credentials type: ${typeof credentials}, hasSessionTokens: ${hasSessionTokens}, hasEmailPassword: ${hasEmailPassword}${bcolors.ENDC}`);

    if (!hasSessionTokens && !hasEmailPassword) {
        retention.addEvent('error', { reason: 'invalid_credentials' });
        retention.writeSummary(false, { error: 'Missing TVNZ credentials' });
        throw new Error('Missing TVNZ credentials. Provide either:\n1. Session tokens (accessToken, refreshToken, edgeApiToken)\n2. Email:OTP (for OTP flow)');
    }

    try {
        if (hasSessionTokens) {
            // Login with pre-extracted session tokens
            await api.loginWithSession(credentials);
            retention.addEvent('auth_method', { method: 'session' });
        } else {
            // Login with email:OTP
            const [email, otp] = credentials.split(':', 2);
            retention.addEvent('auth_start', { email });
            await api.login(email, otp);
            retention.addEvent('auth_method', { method: 'otp' });
        }
        retention.addEvent('auth_complete', { token_cached: Boolean(api.accessToken) });

        // Get video info from URL
        const videoInfo = await api.getVideoIdFromUrl(videoUrl);
        retention.addEvent('video_id_resolved', { video_info: videoInfo });

        // Handle Mediakind sport videos
        if (videoInfo.contentType === 'sport') {
            retention.addEvent('route', { target: 'mediakind_handler' });
            await handleMediakindSportVideo(api, videoUrl, downloadsPath, wvdDevicePath, options);
            retention.writeSummary(true, { path: 'mediakind', video_info: videoInfo });
            return;
        }

        // Authorize content for playback
        let authorization;
        if (videoInfo.isPlayerUrl) {
            // Player URL: query content directly by slug
            const contentData = await api.getContentBySlug(videoInfo.slug);
            const contentId = contentData?.data?.contentId || contentData?.data?.id || videoInfo.slug;
            // For player URLs, contentTypeId should be 'vod' not the URL content type
            authorization = await api.authorizeContent(contentId, 'vod', videoInfo.catalogType);
        } else {
            authorization = await api.authorizeContent(
                videoInfo.contentId,
                videoInfo.contentType,
                videoInfo.catalogType
            );
        }
        retention.addEvent('content_authorized', { content_url: authorization.contentUrl });

        // For SSAI content, we need to create a session to resolve ad placeholders
        let mpdUrl = authorization.contentUrl;
        if (authorization.custom?.mtSessionUrl) {
            retention.addEvent('ssai_session', { status: 'creating' });
            try {
                mpdUrl = await createSsaiSession(
                    authorization.custom.mtSessionUrl,
                    authorization.custom.playerParams,
                    { headers: api.defaultHeaders }
                );
                retention.addEvent('ssai_session', { status: 'resolved', mpdUrl });
            } catch (e) {
                retention.addEvent('ssai_session', { status: 'failed', error: e.message });
                console.log(`${bcolors.YELLOW}[WARN] SSAI session creation failed, falling back to contentUrl: ${e.message}${bcolors.ENDC}`);
            }
        }

        const licenseUrl = authorization.licenseUrl;

        // Get PSSH and keys
        const pssh = await api.getPssh(mpdUrl);
        if (!pssh) {
            retention.addEvent('error', { reason: 'pssh_not_found' });
            throw new Error('Failed to extract PSSH data');
        }

        const keys = await api.getKeys(pssh, licenseUrl, wvdDevicePath, authorization.heartbeatToken);
        const resolution = await api.getHighestResolution(mpdUrl);

        // Determine output filename
        const matchShow = videoUrl.match(/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/);
        const matchSport = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
        let formattedFileName;

        if (matchSport) {
            const [, , subcategory, title] = matchSport;
            formattedFileName = `${subcategory}.${title}`.replace(/-/g, '.').replace(/\.{2,}/g, '.').replace(/^./, (ch) => ch.toUpperCase()) + `.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
        } else if (matchShow) {
            const [, seriesName, contentType, season, episode] = matchShow;
            const normalized = seriesName.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/ /g, '.');
            if (contentType === 'episodes') {
                formattedFileName = `${normalized}.S${String(Number(season)).padStart(2, '0')}E${String(Number(episode)).padStart(2, '0')}.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
            } else {
                formattedFileName = `${normalized}.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
            }
        } else {
            formattedFileName = `content.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
        }

        formattedFileName = options.output || formattedFileName;

        console.log(`${bcolors.LIGHTBLUE}MPD URL: ${bcolors.ENDC}${mpdUrl}`);
        console.log(`${bcolors.RED}License URL: ${bcolors.ENDC}${licenseUrl}`);
        console.log(`${bcolors.LIGHTBLUE}PSSH: ${bcolors.ENDC}${pssh}`);
        for (const key of keys) {
            console.log(`${bcolors.GREEN}KEYS: ${bcolors.ENDC}--key ${key}`);
        }

        const plan = buildDownloadPlan({
            mpdUrl,
            downloadsPath,
            saveName: formattedFileName,
            keys,
            selectVideo: options.selectVideo || 'best',
            selectAudio: options.selectAudio || 'best',
            selectSubtitle: options.selectSubtitle || 'all',
            requestHeaders: {
                'User-Agent': api.defaultHeaders['User-Agent'],
                Origin: api.defaultHeaders.Origin,
                Referer: api.defaultHeaders.Referer
            }
        });

        retention.addEvent('download_prepared', { filename: formattedFileName, key_count: keys.length });
        retention.addEvent('download_start', { filename: formattedFileName });
        await executeDownloadPlan(plan, { retention });
        retention.addEvent('download_complete', { filename: formattedFileName });

        retention.writeSummary(true, { video_url: videoUrl, video_id: videoInfo });
    } catch (error) {
        retention.addEvent('exception', { type: error.name, message: error.message });
        retention.writeSummary(false, { error: error.message, error_type: error.name });
        throw error;
    } finally {
        console.log(`${bcolors.OKBLUE}Retention artifacts saved to: ${retention.baseDir}${bcolors.ENDC}`);
    }
}

// Section: Provider contract integration
export async function runTvnzWorkflow(inputUrl, context = {}) {
    const downloadsPath = context.downloadsPath || './downloads';
    const wvdDevicePath = context.wvdDevicePath || './device.wvd';

    // Determine credentials source
    let credentials = context.credentials;

    // If no credentials provided, try to load from env or session file
    if (!credentials) {
        // Try env vars first
        credentials = loadFromEnv();

        // If still no tokens, try session file (env var or auto-detect)
        if (!credentials.accessToken && !credentials.refreshToken) {
            const sessionFile = process.env.TVNZ_SESSION_FILE || findMostRecentSessionFile();
            if (sessionFile && fs.existsSync(sessionFile)) {
                credentials = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            }
        }
    }

    // If still no credentials, check if we can do anonymous access
    if (!credentials || (!credentials.accessToken && !credentials.refreshToken)) {
        // Create anonymous API instance to try public content
        const api = new TVNZAPI();
        api.setRetention(context.retention);
        // Try to authorize without user auth for free content
    }

    await getDownloadCommand(inputUrl, downloadsPath, wvdDevicePath, credentials, {
        retention: context.retention,
        output: context.options?.output,
        selectVideo: context.options?.selectVideo,
        selectAudio: context.options?.selectAudio,
        selectSubtitle: context.options?.selectSubtitle,
        timeoutMs: context.options?.timeoutMs
    });
}

export class TvnzProvider extends MediaProvider {
    constructor() {
        super();
        this.auth = {};
    }

    get id() {
        return 'tvnz';
    }

    setAuth(auth = {}) {
        // Support both old format (username:password) and new format (object with tokens)
        this.auth = { ...auth };
        return this;
    }

    getAuth() {
        return { ...this.auth };
    }

    supports(inputUrl) {
        return typeof inputUrl === 'string' && /tvnz\.co\.nz/i.test(inputUrl);
    }

    async execute(inputUrl, context = {}) {
        const credentials = context.credentials
            || (this.auth.accessToken ? this.auth : undefined)
            || (this.auth.username && this.auth.password ? `${this.auth.username}:${this.auth.password}` : undefined);

        await runTvnzWorkflow(inputUrl, {
            ...context,
            credentials
        });

        return {
            provider: this.id,
            inputUrl,
            success: true,
            message: 'TVNZ workflow completed',
            artifacts: {
                downloadsPath: context.downloadsPath || './downloads',
                credentialsConfigured: Boolean(credentials)
            }
        };
    }

    async inspect(inputUrl, context = {}) {
        const retention = context.retention || new RetentionStore(context.downloadsPath || './downloads', inputUrl, this.id);
        const api = new TVNZAPI();
        api.setRetention(retention);

        // Load credentials
        let credentials = context.credentials
            || (this.auth.accessToken ? this.auth : null);

        if (!credentials || (!credentials.accessToken && !credentials.refreshToken)) {
            credentials = loadFromEnv();
            const sessionFile = process.env.TVNZ_SESSION_FILE || findMostRecentSessionFile();
            if (sessionFile && fs.existsSync(sessionFile)) {
                credentials = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            }
        }

        if (!credentials || (!credentials.accessToken && !credentials.refreshToken)) {
            throw new Error('Missing TVNZ credentials. Provide session tokens or email:OTP');
        }

        if (credentials.accessToken || credentials.refreshToken) {
            await api.loginWithSession(credentials);
        }

        const videoInfo = await api.getVideoIdFromUrl(inputUrl);
        const authorization = await api.authorizeContent(
            videoInfo.contentId,
            videoInfo.contentType,
            videoInfo.catalogType
        );

        const report = await inspectManifestUrl(authorization.contentUrl, {
            timeoutMs: context.options?.timeoutMs || 15000,
            headers: {
                'User-Agent': api.defaultHeaders['User-Agent'],
                Origin: api.defaultHeaders.Origin,
                Referer: api.defaultHeaders.Referer
            }
        });

        return {
            ...report,
            provider: this.id,
            pageUrl: inputUrl,
            resolvedFromUrl: inputUrl,
            sourceManifestUrl: authorization.contentUrl,
            status: report.status && report.status !== 'needs-resolution' ? report.status : 'ready'
        };
    }
}

export default TvnzProvider;
