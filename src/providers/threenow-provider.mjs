import { MediaProvider } from '../contracts/provider.mjs';
import {
    extractManifestWidevineData,
    fetchBrightcovePlayback,
    fetchManifestWidevineData,
    getWidevineKeys,
    selectPlaybackManifest
} from '../infra/brightcove-media.mjs';
import { buildDownloadPlan, executeDownloadPlan } from '../application/media-pipeline.mjs';
import { fetchJson } from '../infra/http-client.mjs';
import RetentionStore from '../infra/retention-store.mjs';
import { inspectManifestUrl } from '../n3u8dl-node/index.mjs';

// Section: Provider constants and display helpers
const BRIGHTCOVE_KEY = 'BCpkADawqM2NDYVFYXV66rIDrq6i9YpFSTom-hlJ_pdoGkeWuItRDsn1Bhm7QVyQvFIF0OExqoywBvX5-aAFaxYHPlq9st-1mQ73ZONxFHTx0N7opvkHJYpbd_Hi1gJuPP5qCFxyxB8oevg-';
const BRIGHTCOVE_ACCOUNT = '3812193411001';
const BRIGHTCOVE_HEADERS = {
    'BCOV-POLICY': BRIGHTCOVE_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.threenow.co.nz',
    'Referer': 'https://www.threenow.co.nz/'
};

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

// Section: Provider-specific naming helpers
function stripQuery(value) {
    return typeof value === 'string' ? value.split(/[?#]/, 1)[0] : value;
}

function sanitizeShowTitle(showTitle) {
    return String(showTitle || '')
        .replace(/[ ,\-]/g, '.')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

function monthNameToNumber(month) {
    const months = {
        january: '01',
        february: '02',
        march: '03',
        april: '04',
        may: '05',
        june: '06',
        july: '07',
        august: '08',
        september: '09',
        october: '10',
        november: '11',
        december: '12'
    };

    return months[String(month).toLowerCase()] || null;
}

// Section: ThreeNow API resolver
export class ThreeNowAPI {
    constructor() {
        this.retention = null;
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
        return {
            ...BRIGHTCOVE_HEADERS,
            ...extra
        };
    }

    async getVideoInfo(videoUrl) {
        const match = String(videoUrl).match(/shows\/[^/]+\/(?:[^/]+\/)*([^/]+)\/([^/]+)(?:[?#].*)?$/i);
        if (!match) {
            throw new Error('Could not extract show_id and videoId from the URL. Enter the full video URL please.');
        }

        const [, showId, videoId] = match;
        const apiUrl = `https://now-api.fullscreen.nz/v5/shows/${showId}`;
        const data = await fetchJson(apiUrl, { timeoutMs: 20000 });
        this._retainJson('raw/show.json', data);

        const genres = Array.isArray(data?.genres) ? data.genres : [];
        const hasSpecialGenre = genres.some((genre) => ['movie', 'current-affairs', 'comedy'].includes(String(genre)));

        if (data?.easyWatch && data.easyWatch.externalMediaId && String(data.easyWatch.videoId) === String(videoId)) {
            return { ...data.easyWatch, showId, videoId, videoUrl };
        }

        const searchEpisode = (episode) => {
            if (!episode || typeof episode !== 'object') {
                return null;
            }
            const episodeVideoId = episode.videoId ?? episode.externalMediaId;
            if (String(episodeVideoId) === String(videoId)) {
                return { ...episode, showId, videoId, videoUrl };
            }
            return null;
        };

        if (hasSpecialGenre) {
            for (const episode of data?.episodes || []) {
                const found = searchEpisode(episode);
                if (found) {
                    return found;
                }
            }
        }

        for (const season of data?.seasons || []) {
            for (const episode of season?.episodes || []) {
                const found = searchEpisode(episode);
                if (found) {
                    return found;
                }
            }
        }

        throw new Error('Could not find the video ID in the API response.');
    }

    async getAdditionalVideoInfo(showId, videoId) {
        const apiUrl = `https://now-api.fullscreen.nz/v5/shows/${showId}/${videoId}`;
        const data = await fetchJson(apiUrl, { timeoutMs: 20000 });
        this._retainJson('raw/video.json', data);
        return data;
    }

    async getPlaybackInfo(brightcoveVideoId) {
        return fetchBrightcovePlayback({
            videoId: brightcoveVideoId,
            accountId: BRIGHTCOVE_ACCOUNT,
            policyKey: BRIGHTCOVE_KEY,
            origin: 'https://www.threenow.co.nz',
            referer: 'https://www.threenow.co.nz/',
            userAgent: BRIGHTCOVE_HEADERS['User-Agent'],
            retention: this.retention
        });
    }

    getManifestUrl(playbackInfo) {
        return selectPlaybackManifest(playbackInfo);
    }

    async getPsshAndLicense(urlMpd) {
        const details = await fetchManifestWidevineData({
            manifestUrl: urlMpd,
            retention: this.retention
        });

        if (!details.pssh || !details.licenseUrl) {
            throw new Error('Could not find the correct ContentProtection element in the MPD content.');
        }

        this._retainJson('parsed/pssh_summary.json', {
            pssh_length: details.pssh.length,
            pssh_preview: `${details.pssh.slice(0, 32)}...`,
            manifest_url: urlMpd
        });

        return [details.pssh, details.licenseUrl];
    }

    async getKeys(pssh, licUrl, wvdDevicePath) {
        return getWidevineKeys({
            pssh,
            licenseUrl: licUrl,
            wvdDevicePath,
            origin: 'https://www.threenow.co.nz',
            referer: 'https://www.threenow.co.nz/',
            userAgent: BRIGHTCOVE_HEADERS['User-Agent'],
            retention: this.retention
        });
    }

    async getBestVideoHeight(urlMpd) {
        const details = await fetchManifestWidevineData({
            manifestUrl: urlMpd,
            retention: this.retention
        });

        return details.resolution;
    }

    async getFormattedFilename(showId, videoId, bestHeight) {
        const showInfo = await this.getAdditionalVideoInfo(showId, videoId);
        const showTitle = sanitizeShowTitle(showInfo.showTitle);
        const name = String(showInfo.name || '');

        if (/^Season \d+ Ep \d+$/i.test(name)) {
            const seasonEpisode = name.replace(/Season (\d+) Ep (\d+)/i, (_, season, episode) => `S${String(Number(season)).padStart(2, '0')}E${String(Number(episode)).padStart(2, '0')}`);
            return `${showTitle}.${seasonEpisode}.${bestHeight}.ThreeNow.WEB-DL.AAC2.0.H.264`;
        }

        if (/^Season \d{4} Ep \d+$/i.test(name)) {
            const seasonEpisode = name.replace(/Season (\d{4}) Ep (\d+)/i, (_, season, episode) => `S${season}E${String(Number(episode)).padStart(2, '0')}`);
            return `${showTitle}.${seasonEpisode}.${bestHeight}.ThreeNow.WEB-DL.AAC2.0.H.264`;
        }

        if (/^\w+ \d+ \w+ \d{4}$/.test(name)) {
            const match = name.match(/^\w+ (\d{1,2}) (\w+) (\d{4})$/);
            if (match) {
                const [, day, month, year] = match;
                const monthNumber = monthNameToNumber(month);
                if (monthNumber) {
                    return `${showTitle}.${year}${monthNumber}${String(Number(day)).padStart(2, '0')}.${bestHeight}.ThreeNow.WEB-DL.AAC2.0.H.264`;
                }
            }
        }

        return `${showTitle}.${bestHeight}.ThreeNow.WEB-DL.AAC2.0.H.264`;
    }
}

// Section: ThreeNow provider workflow
export async function getDownloadCommand(videoUrl, downloadsPath, wvdDevicePath, options = {}) {
    const retention = options.retention || new RetentionStore(downloadsPath, videoUrl, 'threenow');
    retention.addEvent('start', { video_url: videoUrl, downloads_path: downloadsPath });

    const api = new ThreeNowAPI();
    api.setRetention(retention);

    try {
        const videoInfo = await api.getVideoInfo(videoUrl);
        retention.addEvent('video_info_resolved', {
            show_id: videoInfo.showId,
            video_id: videoInfo.videoId,
            title: videoInfo.title || null
        });

        const saveNameOverride = options.output || null;

        const playbackInfo = await api.getPlaybackInfo(videoInfo.externalMediaId);
        const [manifestUrl, licUrl] = api.getManifestUrl(playbackInfo);
        retention.addEvent('playback_resolved', {
            manifest_url: manifestUrl,
            has_license_url: Boolean(licUrl)
        });

        if (stripQuery(manifestUrl).endsWith('master.m3u8')) {
            const formattedFilename = saveNameOverride || await api.getFormattedFilename(videoInfo.showId, videoInfo.videoId, '720p');
            const plan = buildDownloadPlan({
                mpdUrl: manifestUrl,
                downloadsPath,
                saveName: formattedFilename,
                selectVideo: options.selectVideo || 'best',
                selectAudio: options.selectAudio || 'best',
                selectSubtitle: options.selectSubtitle || 'all',
                requestHeaders: {
                    'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
                    Origin: BRIGHTCOVE_HEADERS.Origin,
                    Referer: BRIGHTCOVE_HEADERS.Referer
                }
            });

            retention.addEvent('download_start', { filename: formattedFilename, mode: 'hls' });
            await executeDownloadPlan(plan, { retention });
            retention.addEvent('download_complete', { filename: formattedFilename, mode: 'hls' });
            retention.writeSummary(true, { video_url: videoUrl, video_id: videoInfo.videoId, mode: 'hls' });
            return;
        }

        let pssh;
        let resolvedLicenseUrl = licUrl;

        try {
            const result = await api.getPsshAndLicense(manifestUrl);
            pssh = result[0];
            resolvedLicenseUrl = result[1];
        } catch (error) {
            const fallbackSource = (playbackInfo.sources || []).find((source) => source?.type === 'application/x-mpegURL');
            if (!fallbackSource) {
                throw error;
            }

            const formattedFilename = saveNameOverride || await api.getFormattedFilename(videoInfo.showId, videoInfo.videoId, '720p');
            const plan = buildDownloadPlan({
                mpdUrl: fallbackSource.src,
                downloadsPath,
                saveName: formattedFilename,
                selectVideo: options.selectVideo || 'best',
                selectAudio: options.selectAudio || 'best',
                selectSubtitle: options.selectSubtitle || 'all',
                requestHeaders: {
                    'User-Agent': BRIGHTCOVE_HEADERS['User-Agent'],
                    Origin: BRIGHTCOVE_HEADERS.Origin,
                    Referer: BRIGHTCOVE_HEADERS.Referer
                }
            });

            console.log(`${bcolors.LIGHTBLUE}M3U8 URL: ${bcolors.ENDC}${fallbackSource.src}`);
            retention.addEvent('download_start', { filename: formattedFilename, mode: 'hls_fallback' });
            await executeDownloadPlan(plan, { retention });
            retention.addEvent('download_complete', { filename: formattedFilename, mode: 'hls_fallback' });
            retention.writeSummary(true, { video_url: videoUrl, video_id: videoInfo.videoId, mode: 'hls_fallback' });
            return;
        }

        const bestHeight = await api.getBestVideoHeight(manifestUrl);
        const formattedFilename = saveNameOverride || await api.getFormattedFilename(videoInfo.showId, videoInfo.videoId, bestHeight);
        const keys = await api.getKeys(pssh, resolvedLicenseUrl, wvdDevicePath);

        console.log(`${bcolors.LIGHTBLUE}MPD URL: ${bcolors.ENDC}${manifestUrl}`);
        console.log(`${bcolors.RED}License URL: ${bcolors.ENDC}${resolvedLicenseUrl}`);
        console.log(`${bcolors.LIGHTBLUE}PSSH: ${bcolors.ENDC}${pssh}`);
        for (const key of keys) {
            console.log(`${bcolors.GREEN}KEYS: ${bcolors.ENDC}--key ${key}`);
        }

        const plan = buildDownloadPlan({
            mpdUrl: manifestUrl,
            downloadsPath,
            saveName: formattedFilename,
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

        retention.addEvent('download_start', { filename: formattedFilename, key_count: keys.length });
        await executeDownloadPlan(plan, { retention });
        retention.addEvent('download_complete', { filename: formattedFilename, key_count: keys.length });
        retention.writeSummary(true, { video_url: videoUrl, video_id: videoInfo.videoId });
    } catch (error) {
        retention.addEvent('exception', { type: error.name, message: error.message });
        retention.writeSummary(false, { error: error.message, error_type: error.name });
        throw error;
    } finally {
        console.log(`${bcolors.OKBLUE}Retention artifacts saved to: ${retention.baseDir}${bcolors.ENDC}`);
    }
}

// Section: Provider contract integration
export async function runThreeNowWorkflow(inputUrl, context = {}) {
    const downloadsPath = context.downloadsPath || './downloads';
    const wvdDevicePath = context.wvdDevicePath || './device.wvd';
    await getDownloadCommand(inputUrl, downloadsPath, wvdDevicePath, {
        retention: context.retention,
        output: context.options?.output
    });
}

export class ThreeNowProvider extends MediaProvider {
    constructor() {
        super();
        this.auth = {};
    }

    get id() {
        return 'threenow';
    }

    setAuth(auth = {}) {
        this.auth = { ...auth };
        return this;
    }

    getAuth() {
        return { ...this.auth };
    }

    supports(inputUrl) {
        return typeof inputUrl === 'string' && /threenow\.co\.nz/i.test(inputUrl);
    }

    async execute(inputUrl, context = {}) {
        await runThreeNowWorkflow(inputUrl, context);

        return {
            provider: this.id,
            inputUrl,
            success: true,
            message: 'ThreeNow workflow completed',
            artifacts: {
                downloadsPath: context.downloadsPath || './downloads',
                credentialsConfigured: Boolean(this.auth.username || this.auth.sessionToken)
            }
        };
    }

    async inspect(inputUrl, context = {}) {
        const retention = context.retention || new RetentionStore(context.downloadsPath || './downloads', inputUrl, this.id);
        const api = new ThreeNowAPI();
        api.setRetention(retention);

        const videoInfo = await api.getVideoInfo(inputUrl);
        const playbackInfo = await api.getPlaybackInfo(videoInfo.externalMediaId);
        const [manifestUrl] = api.getManifestUrl(playbackInfo);

        const report = await inspectManifestUrl(manifestUrl, {
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
            sourceManifestUrl: manifestUrl,
            status: report.status && report.status !== 'needs-resolution' ? report.status : 'ready'
        };
    }
}

export default ThreeNowProvider;
