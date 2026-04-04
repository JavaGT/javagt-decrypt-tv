import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DOMParser } from 'xmldom';
import { MediaProvider } from '../contracts/provider.mjs';
import { extractManifestWidevineData, fetchBrightcovePlayback, getWidevineKeys } from '../infra/brightcove-media.mjs';
import { buildDownloadPlan, executeDownloadPlan } from '../application/media-pipeline.mjs';
import { fetchJson, fetchText, createTimeoutSignal } from '../infra/http-client.mjs';
import RetentionStore from '../infra/retention-store.mjs';
import { inspectManifestUrl } from '../n3u8dl-node/index.mjs';

// Section: Provider constants and display helpers
const BRIGHTCOVE_KEY = 'BCpkADawqM0IurzupiJKMb49WkxM__ngDMJ3GOQBhN2ri2Ci_lHwDWIpf4sLFc8bANMc-AVGfGR8GJNgxGqXsbjP1gHsK2Fpkoj6BSpwjrKBnv1D5l5iGPvVYCo';
const BRIGHTCOVE_ACCOUNT = '963482467001';
const BRIGHTCOVE_HEADERS = {
    'BCOV-POLICY': BRIGHTCOVE_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.tvnz.co.nz',
    'Referer': 'https://www.tvnz.co.nz/'
};
const BRIGHTCOVE_API = (videoId) => `https://playback.brightcovecdn.com/playback/v1/accounts/${BRIGHTCOVE_ACCOUNT}/videos/${videoId}`;
const TOKEN_URL = 'https://login.tvnz.co.nz/v1/token';
const bcolors = {
    LIGHTBLUE: '\x1b[94m',
    RED: '\x1b[91m',
    GREEN: '\x1b[92m',
    YELLOW: '\x1b[93m',
    OKBLUE: '\x1b[94m',
    OKGREEN: '\x1b[92m',
    FAIL: '\x1b[91m',
    ENDC: '\x1b[0m'
};
// Section: TVNZ API resolver
export class TVNZAPI {
    constructor() {
        this.token = null;
        this.tokenExpires = 0;
        this.retention = null;
        this.manifestCache = new Map();
        this.manifestSummaryCache = new Map();
        this.defaultHeaders = {
            'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
            'Origin': 'https://www.tvnz.co.nz',
            'Referer': 'https://www.tvnz.co.nz/'
        };
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

    _authHeaders(extra = {}) {
        const headers = {
            ...this.defaultHeaders,
            ...extra
        };
        const cookieHeader = this._cookieHeader();
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }
        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        return headers;
    }

    _captureCookies(response) {
        const raw = response.headers.get('set-cookie');
        if (!raw) {
            return;
        }

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
        if (!this.cookies.size) {
            return '';
        }
        return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    async _getManifestResponse(urlMpd) {
        if (!this.manifestCache.has(urlMpd)) {
            const text = await fetchText(urlMpd, {
                headers: this._authHeaders()
            });
            this.manifestCache.set(urlMpd, text);
            this._retainText('raw/manifest.mpd', text);
        }
        return this.manifestCache.get(urlMpd);
    }

    _parseIsoDuration(durationValue) {
        if (!durationValue) {
            return null;
        }
        const match = durationValue.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
        if (!match) {
            return null;
        }
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

        summary.available_resolutions = Array.from(new Set(summary.video_representations.map((x) => x.height).filter(Boolean))).sort((a, b) => b - a);
        summary.selected_resolution = summary.max_video_height >= 1080 ? '1080p' : summary.max_video_height >= 720 ? '720p' : 'SD';
        return summary;
    }

    _findVideoNode(data, targetVideoId) {
        if (Array.isArray(data)) {
            for (const item of data) {
                const found = this._findVideoNode(item, targetVideoId);
                if (found) {
                    return found;
                }
            }
            return null;
        }

        if (data && typeof data === 'object') {
            const pm = data.publisherMetadata;
            if (pm && String(pm.brightcoveVideoId) === String(targetVideoId)) {
                return data;
            }
            for (const value of Object.values(data)) {
                const found = this._findVideoNode(value, targetVideoId);
                if (found) {
                    return found;
                }
            }
        }

        return null;
    }

    _buildTVNZPageSummary(data, videoId, videoUrl) {
        const videoNode = this._findVideoNode(data, videoId);
        return {
            page: {
                id: data?.id,
                url: data?.url,
                title: data?.title,
                description: data?.description
            },
            video: videoNode || { video_id: videoId, video_url: videoUrl },
            breadcrumbs: Array.isArray(data?.breadcrumbs) ? data.breadcrumbs : [],
            data_layer: data?.dataLayer || {},
            availability: {
                episodes_available: data?.episodesAvailable,
                seasons_available: data?.seasonsAvailable,
                last_published_episode_date: data?.lastPublishedEpisodeDate
            }
        };
    }

    _buildBrightcoveSummary(response, videoUrl, videoId, resolution, mpdUrl, licUrl, pssh, keys, outputName) {
        return {
            video_url: videoUrl,
            video_id: videoId,
            output_name: outputName,
            resolution,
            mpd_url: mpdUrl,
            license_url: licUrl,
            pssh_length: pssh ? pssh.length : 0,
            key_count: keys.length,
            brightcove: {
                id: response?.id,
                name: response?.name,
                duration_ms: response?.duration,
                account_id: response?.account_id,
                published_at: response?.published_at,
                source_count: Array.isArray(response?.sources) ? response.sources.length : 0,
                source_types: Array.from(new Set((response?.sources || []).map((src) => src?.type).filter(Boolean)))
            }
        };
    }

    _buildEpisodeIndex(videoUrl, videoId, outputName, resolution, mpdUrl, licUrl, pssh, keys, tvnzPageSummary, brightcoveSummary, manifestSummary) {
        return {
            video_url: videoUrl,
            video_id: videoId,
            output_name: outputName,
            resolution,
            title: tvnzPageSummary?.video?.title || brightcoveSummary?.brightcove?.name || tvnzPageSummary?.page?.title,
            available_resolutions: manifestSummary?.available_resolutions || [],
            selected_resolution: manifestSummary?.selected_resolution,
            media_presentation_duration_seconds: manifestSummary?.media_presentation_duration_seconds,
            mpd_url: mpdUrl,
            license_url: licUrl,
            pssh_length: pssh ? pssh.length : 0,
            key_count: keys.length
        };
    }

    async _refreshToken() {
        this.token = null;
        this.tokenExpires = 0;

        const token = (await fetchText(TOKEN_URL, {
            headers: this._authHeaders()
        })).trim();
        this.token = token;
        this.tokenExpires = Date.now() + 3600 * 1000;
        this._retainText('raw/token_response.txt', token);
    }

    async login(email, password) {
        const loginUrl = 'https://login.tvnz.co.nz/co/authenticate';
        const payload = {
            client_id: 'tp5hyPrFuXLJV0jgRWy5l7lEtJlPN98R',
            credential_type: 'password',
            password,
            username: email
        };
        const headers = {
            ...this.defaultHeaders,
            'Content-Type': 'application/json',
            auth0Client: 'eyJuYW1lIjoiYXV0aDAuanMiLCJ2ZXJzaW9uIjoiOS4xMC4yIn0='
        };

        const loginRes = await fetch(loginUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: createTimeoutSignal()
        });
        this._captureCookies(loginRes);
        if (!loginRes.ok) {
            throw new Error(`Login authenticate failed: [${loginRes.status}] ${(await loginRes.text()).slice(0, 300)}`);
        }
        const loginData = await loginRes.json();
        this._retainJson('raw/login_authenticate_response.json', loginData);

        const authorizeUrl = new URL('https://login.tvnz.co.nz/authorize');
        const params = {
            client_id: 'tp5hyPrFuXLJV0jgRWy5l7lEtJlPN98R',
            response_type: 'token',
            redirect_uri: 'https://www.tvnz.co.nz/login',
            audience: 'tvnz-apis',
            state: crypto.randomBytes(24).toString('base64'),
            response_mode: 'web_message',
            login_ticket: loginData.login_ticket,
            prompt: 'none',
            auth0Client: 'eyJuYW1lIjoiYXV0aDAuanMiLCJ2ZXJzaW9uIjoiOS4xMC4yIn0='
        };
        for (const [k, v] of Object.entries(params)) {
            authorizeUrl.searchParams.set(k, v);
        }

        const authorizeRes = await fetch(authorizeUrl.toString(), {
            headers: {
                ...headers,
                Cookie: this._cookieHeader()
            },
            signal: createTimeoutSignal()
        });
        this._captureCookies(authorizeRes);
        if (!authorizeRes.ok) {
            throw new Error(`Authorize failed: [${authorizeRes.status}] ${(await authorizeRes.text()).slice(0, 300)}`);
        }
        const authorizeHtml = await authorizeRes.text();
        this._retainText('raw/login_authorize_response.html', authorizeHtml);

        const match = authorizeHtml.match(/authorizationResponse = \{type: "authorization_response",response: (.*?)\};/s);
        if (!match) {
            throw new Error('Authorization response not found.');
        }

        const authResponse = JSON.parse(match[1]);
        this._retainJson('raw/login_authorization_response.json', authResponse);
        if (authResponse.error) {
            throw new Error(`Authorization error: ${authResponse.error_description || authResponse.error}`);
        }

        this.token = authResponse.access_token;
        this.tokenExpires = Date.now() + 3600 * 1000;
        console.info(`${bcolors.OKGREEN}Login successful, token obtained${bcolors.ENDC}`);
    }

    async getVideoIdFromUrl(videoUrl) {
        if (Date.now() > this.tokenExpires) {
            await this._refreshToken();
        }

        if (videoUrl.includes('sport/')) {
            const match = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
            if (!match) {
                return null;
            }
            const [_, category, subcategory, slug] = match;
            const apiUrl = `https://apis-public-prod.tech.tvnz.co.nz/api/v1/web/play/page/sport/${category}/${subcategory}/${slug}`;
            const data = await fetchJson(apiUrl, { headers: this._authHeaders() });
            this._retainJson('raw/tvnz_sport_page.json', data);
            return this.findVideoIdInSport(data);
        }

        const match = videoUrl.match(/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/);
        if (!match) {
            throw new Error('Could not extract video information from URL.');
        }

        const [_, seriesName, contentType, season, episode] = match;
        const apiUrl = `https://apis-public-prod.tech.tvnz.co.nz/api/v1/web/play/page/shows/${seriesName}/${contentType}/s${season}-e${episode}`;

        if (contentType === 'movie') {
            return this.findVideoIdInMovie(apiUrl, seriesName, season, episode);
        }
        return this.findVideoIdInShow(apiUrl, seriesName, season, episode);
    }

    findVideoIdInSport(data) {
        if (Array.isArray(data)) {
            for (const item of data) {
                const result = this.findVideoIdInSport(item);
                if (result) {
                    return result;
                }
            }
            return null;
        }

        if (data && typeof data === 'object') {
            const media = data.media || {};
            if (media.source === 'brightcove') {
                return `brightcove:${media.id}`;
            }
            if (media.source === 'mediakind') {
                return `mediakind:${media.id}`;
            }

            for (const value of Object.values(data)) {
                const result = this.findVideoIdInSport(value);
                if (result) {
                    return result;
                }
            }
        }

        return null;
    }

    async findVideoIdInShow(apiUrl, seriesName, season, episode) {
        const data = await fetchJson(apiUrl, { headers: this._authHeaders() });
        this._retainJson('raw/tvnz_show_page.json', data);
        const url = `/shows/${seriesName}/episodes/s${season}-e${episode}`;
        const href = `/api/v1/web/play/page/shows/${seriesName}/episodes/s${season}-e${episode}`;
        return this.findBrightcoveVideoId(data, url, href);
    }

    async findVideoIdInMovie(apiUrl, seriesName, season, episode) {
        const data = await fetchJson(apiUrl, { headers: this._authHeaders() });
        this._retainJson('raw/tvnz_movie_page.json', data);
        const url = `/shows/${seriesName}/movie/s${season}-e${episode}`;
        const href = `/api/v1/web/play/page/shows/${seriesName}/movie/s${season}-e${episode}`;
        return this.findBrightcoveVideoId(data, url, href);
    }

    findBrightcoveVideoId(data, url, href) {
        if (!data || typeof data !== 'object') {
            return null;
        }

        for (const value of Object.values(data)) {
            if (value && typeof value === 'object') {
                const page = value.page || {};
                if (page.url === url && page.href === href) {
                    return value.publisherMetadata?.brightcoveVideoId || null;
                }
                const result = this.findBrightcoveVideoId(value, url, href);
                if (result) {
                    return result;
                }
            }
        }

        return null;
    }

    async getPssh(urlMpd) {
        const manifestText = await this._getManifestResponse(urlMpd);
        let summary = this.manifestSummaryCache.get(urlMpd);
        if (!summary) {
            summary = this._buildManifestSummary(urlMpd, manifestText);
            this.manifestSummaryCache.set(urlMpd, summary);
            this._retainJson('parsed/manifest_summary.json', summary);
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

    async getKeys(pssh, licUrl, wvdDevicePath, authorizationToken = null) {
        return getWidevineKeys({
            pssh,
            licenseUrl: licUrl,
            wvdDevicePath,
            origin: 'https://www.tvnz.co.nz',
            referer: 'https://www.tvnz.co.nz/',
            userAgent: BRIGHTCOVE_HEADERS['User-Agent'],
            authorizationToken,
            retention: this.retention
        });
    }

    async getHighestResolution(urlMpd) {
        const manifestText = await this._getManifestResponse(urlMpd);
        const summary = this._buildManifestSummary(urlMpd, manifestText);
        this.manifestSummaryCache.set(urlMpd, summary);
        this._retainJson('parsed/manifest_summary.json', summary);
        return summary.selected_resolution || 'SD';
    }

    async getHighestResolutionMediakind(urlMpd) {
        const text = await fetchText(urlMpd, { headers: this._authHeaders() });
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const reps = Array.from(doc.getElementsByTagName('Representation'));
        let maxHeight = 0;
        for (const rep of reps) {
            const height = Number(rep.getAttribute('height') || 0);
            maxHeight = Math.max(maxHeight, height);
        }
        return maxHeight >= 1080 ? '1080p' : maxHeight >= 720 ? '720p' : 'SD';
    }

    async getSecondaryAuthorizationToken(videoId) {
        const tokenUrl = `https://apis-public-prod.tvnz.io/playback/v1/${videoId}`;
        const data = await fetchJson(tokenUrl, {
            headers: this._authHeaders({
                Accept: 'application/json'
            })
        });
        this._retainJson('raw/secondary_token_response.json', data);
        if (!data?.encryption?.drmToken) {
            throw new Error('Secondary token not found in response');
        }
        return data.encryption.drmToken;
    }
}

// Section: TVNZ route-specific handlers
export async function handleMediakindSportVideo(api, videoUrl, downloadsPath, wvdDevicePath, options = {}) {
    const match = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!match) {
        throw new Error(`Regex match failed for the URL: ${videoUrl}`);
    }

    const [_, category, subcategory, videoSlug] = match;
    const apiUrl = `https://apis-public-prod.tech.tvnz.co.nz/api/v1/web/play/page/sport/${category}/${subcategory}/${videoSlug}`;
    const data = await fetchJson(apiUrl, {
        headers: api._authHeaders()
    });

    const findMediakindId = (node) => {
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = findMediakindId(item);
                if (found) {
                    return found;
                }
            }
            return null;
        }
        if (node && typeof node === 'object') {
            if (node.media?.source === 'mediakind') {
                return node.media.id;
            }
            for (const value of Object.values(node)) {
                const found = findMediakindId(value);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    };

    const videoId = findMediakindId(data);
    if (!videoId) {
        throw new Error('Failed to find Mediakind video ID');
    }

    const mpdUrl = `https://replay.vod-tvnz-prod.tvnz.io/dash-enc/${videoId}/manifest.mpd`;
    const pssh = await api.getPssh(mpdUrl);
    if (!pssh) {
        throw new Error('Failed to extract PSSH data');
    }

    const secondaryToken = await api.getSecondaryAuthorizationToken(videoId);
    const licUrl = 'https://apis-public-prod.tvnz.io/license/v1/wv';
    const keys = await api.getKeys(pssh, licUrl, wvdDevicePath, secondaryToken);
    const resolution = await api.getHighestResolutionMediakind(mpdUrl);
    const formattedFileName = `${subcategory}.${videoSlug}`.replace(/-/g, '.').replace(/\.{2,}/g, '.').replace(/^./, (ch) => ch.toUpperCase()) + `.${resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;

    console.log(`${bcolors.LIGHTBLUE}MPD URL: ${bcolors.ENDC}${mpdUrl}`);
    console.log(`${bcolors.RED}License URL: ${bcolors.ENDC}${licUrl}`);
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
            'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
            Origin: BRIGHTCOVE_HEADERS.Origin,
            Referer: BRIGHTCOVE_HEADERS.Referer
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

    if (!credentials || !credentials.includes(':')) {
        retention.addEvent('error', { reason: 'invalid_credentials' });
        retention.writeSummary(false, { error: 'Missing or invalid TVNZ credentials' });
        throw new Error('Missing or invalid TVNZ credentials. Use username:password.');
    }

    try {
        const [email, password] = credentials.split(':', 2);
        retention.addEvent('auth_start', { email });
        await api.login(email, password);
        retention.addEvent('auth_complete', { token_cached: Boolean(api.token) });

        let videoId = await api.getVideoIdFromUrl(videoUrl);
        retention.addEvent('video_id_resolved', { video_id: videoId });

        if (typeof videoId === 'string' && videoId.startsWith('mediakind:')) {
            retention.addEvent('route', { target: 'mediakind_handler' });
            await handleMediakindSportVideo(api, videoUrl, downloadsPath, wvdDevicePath, options);
            retention.writeSummary(true, { path: 'mediakind', video_id: videoId });
            return;
        }

        videoId = typeof videoId === 'string' ? videoId.split(':').pop() : videoId;
        const brightcove = await fetchBrightcovePlayback({
            videoId,
            accountId: BRIGHTCOVE_ACCOUNT,
            policyKey: BRIGHTCOVE_KEY,
            origin: 'https://www.tvnz.co.nz',
            referer: 'https://www.tvnz.co.nz/',
            userAgent: BRIGHTCOVE_HEADERS['User-Agent'],
            retention,
            timeoutMs: options.timeoutMs || 15000,
            apiBase: 'https://playback.brightcovecdn.com'
        });
        retention.writeJson('raw/brightcove_response.json', brightcove);
        retention.addEvent('brightcove_response', { source_count: (brightcove.sources || []).length });

        const matchShow = videoUrl.match(/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/);
        const matchSport = videoUrl.match(/sport\/([^/]+)\/([^/]+)\/([^/]+)/);
        const saveNameOverride = options.output || null;
        let formattedFileNameTemplate;

        if (matchSport) {
            const [, , subcategory, title] = matchSport;
            formattedFileNameTemplate = `${subcategory}.${title}`.replace(/-/g, '.').replace(/\.{2,}/g, '.').replace(/^./, (ch) => ch.toUpperCase()) + '.{resolution}.TVNZ.WEB-DL.AAC2.0.H.264';
        } else if (matchShow) {
            const [, seriesName, contentType, season, episode] = matchShow;
            const normalized = seriesName.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/ /g, '.');
            if (contentType === 'episodes') {
                formattedFileNameTemplate = `${normalized}.S${String(Number(season)).padStart(2, '0')}E${String(Number(episode)).padStart(2, '0')}.{resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
            } else {
                formattedFileNameTemplate = `${normalized}.{resolution}.TVNZ.WEB-DL.AAC2.0.H.264`;
            }
        } else {
            throw new Error('Invalid video URL format.');
        }

        const source = (brightcove.sources || []).find((src) => src?.key_systems?.['com.widevine.alpha']);
        if (!source) {
            retention.addEvent('error', { reason: 'widevine_source_missing' });
            throw new Error('No Widevine-protected source found');
        }

        const mpdUrl = source.src;
        const resolution = await api.getHighestResolution(mpdUrl);
        const formattedFileName = saveNameOverride || formattedFileNameTemplate.replace('{resolution}', resolution);
        const licUrl = source.key_systems['com.widevine.alpha'].license_url;
        const pssh = await api.getPssh(mpdUrl);
        if (!pssh) {
            retention.addEvent('error', { reason: 'pssh_not_found' });
            throw new Error('Failed to extract PSSH data');
        }

        const keys = await api.getKeys(pssh, licUrl, wvdDevicePath);
        const manifestSummary = api.manifestSummaryCache.get(mpdUrl) || {};

        let tvnzPageSummary = {};
        for (const candidate of ['raw/tvnz_show_page.json', 'raw/tvnz_movie_page.json', 'raw/tvnz_sport_page.json']) {
            const fullPath = path.join(retention.baseDir, candidate);
            if (fs.existsSync(fullPath)) {
                const pageData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                tvnzPageSummary = api._buildTVNZPageSummary(pageData, videoId, videoUrl);
                retention.writeJson('parsed/tvnz_page_summary.json', tvnzPageSummary);
                break;
            }
        }

        const brightcoveSummary = api._buildBrightcoveSummary(brightcove, videoUrl, videoId, resolution, mpdUrl, licUrl, pssh, keys, formattedFileName);
        retention.writeJson('parsed/metadata_bundle.json', {
            video_url: videoUrl,
            video_id: videoId,
            output_name: formattedFileName,
            resolution,
            mpd_url: mpdUrl,
            license_url: licUrl,
            pssh,
            keys,
            brightcove: brightcoveSummary
        });
        retention.writeJson('parsed/episode_index.json', api._buildEpisodeIndex(videoUrl, videoId, formattedFileName, resolution, mpdUrl, licUrl, pssh, keys, tvnzPageSummary, brightcoveSummary, manifestSummary));

        console.log(`${bcolors.LIGHTBLUE}MPD URL: ${bcolors.ENDC}${mpdUrl}`);
        console.log(`${bcolors.RED}License URL: ${bcolors.ENDC}${licUrl}`);
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
                'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
                Origin: BRIGHTCOVE_HEADERS.Origin,
                Referer: BRIGHTCOVE_HEADERS.Referer
            }
        });
        retention.addEvent('download_prepared', { filename: formattedFileName, key_count: keys.length });

        retention.addEvent('download_start', { filename: formattedFileName });
        await executeDownloadPlan(plan, { retention });
        retention.addEvent('download_complete', { filename: formattedFileName });

        retention.writeSummary(true, { video_url: videoUrl, video_id: videoId });
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
    const envCredentials = process.env.OZIVINE_TVNZ_CREDENTIALS
        || ((process.env.TVNZ_USERNAME && process.env.TVNZ_PASSWORD)
            ? `${process.env.TVNZ_USERNAME}:${process.env.TVNZ_PASSWORD}`
            : '');
    const credentials = context.credentials || envCredentials || '';
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
        const credentials = context.credentials || (this.auth.username && this.auth.password ? `${this.auth.username}:${this.auth.password}` : undefined);
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

        const credentials = context.credentials
            || (this.auth.username && this.auth.password ? `${this.auth.username}:${this.auth.password}` : '')
            || envCredentials
            || '';
        if (!credentials || !credentials.includes(':')) {
            throw new Error('Missing or invalid TVNZ credentials. Use username:password.');
        }

        const [email, password] = credentials.split(':', 2);
        await api.login(email, password);

        let videoId = await api.getVideoIdFromUrl(inputUrl);
        if (typeof videoId === 'string' && videoId.startsWith('mediakind:')) {
            throw new Error('TVNZ Mediakind inspection is not supported yet');
        }

        videoId = typeof videoId === 'string' ? videoId.split(':').pop() : videoId;
        const brightcove = await fetchJson(BRIGHTCOVE_API(videoId), {
            headers: BRIGHTCOVE_HEADERS
        });

        const source = (brightcove.sources || []).find((src) => src?.key_systems?.['com.widevine.alpha']);
        if (!source) {
            throw new Error('No Widevine-protected source found');
        }

        const report = await inspectManifestUrl(source.src, {
            timeoutMs: context.options?.timeoutMs || 15000,
            headers: {
                'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
                Origin: BRIGHTCOVE_HEADERS.Origin,
                Referer: BRIGHTCOVE_HEADERS.Referer
            }
        });

        return {
            ...report,
            provider: this.id,
            pageUrl: inputUrl,
            resolvedFromUrl: inputUrl,
            sourceManifestUrl: source.src,
            status: report.status && report.status !== 'needs-resolution' ? report.status : 'ready'
        };
    }
}

export default TvnzProvider;
