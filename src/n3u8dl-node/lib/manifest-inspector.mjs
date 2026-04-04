import { fetchText } from '../../infra/http-client.mjs';
import { parseMpdManifest } from './mpd-parser.mjs';
import { parseHlsMasterPlaylist, parseHlsMediaPlaylist } from './hls-parser.mjs';

export function buildDefaultSelection(tracks) {
    return {
        videoIds: tracks.video[0] ? [tracks.video[0].id] : [],
        audioIds: tracks.audio[0] ? [tracks.audio[0].id] : [],
        subtitleIds: tracks.subtitles.length ? tracks.subtitles.map((track) => track.id) : []
    };
}

export function normalizeInspectionInput(input, options = {}) {
    if (typeof input === 'string') {
        return { inputUrl: input, ...options };
    }

    return {
        ...(input || {}),
        ...options
    };
}

export function mapMpdTracks(parsed) {
    return {
        video: (parsed.representations.video || []).map((track) => ({
            id: track.id,
            kind: 'video',
            playbackType: 'segments',
            bandwidth: track.bandwidth,
            width: track.width,
            height: track.height,
            codecs: track.codecs,
            language: track.language,
            baseUrl: track.baseUrl,
            segmentCount: Array.isArray(track.segmentUrls) ? track.segmentUrls.length : 0,
            initializationUrl: track.initializationUrl,
            segmentUrls: track.segmentUrls
        })),
        audio: (parsed.representations.audio || []).map((track) => ({
            id: track.id,
            kind: 'audio',
            playbackType: 'segments',
            bandwidth: track.bandwidth,
            codecs: track.codecs,
            language: track.language,
            baseUrl: track.baseUrl,
            segmentCount: Array.isArray(track.segmentUrls) ? track.segmentUrls.length : 0,
            initializationUrl: track.initializationUrl,
            segmentUrls: track.segmentUrls
        })),
        subtitles: (parsed.representations.subtitle || []).map((track) => ({
            id: track.id,
            kind: 'subtitle',
            playbackType: 'direct',
            language: track.language,
            mimeType: track.mimeType,
            subtitleUrl: track.subtitleUrl,
            baseUrl: track.baseUrl
        }))
    };
}

export function mapHlsMasterTracks(parsed) {
    return {
        video: parsed.variants.map((track) => ({
            id: track.id,
            kind: 'video',
            playbackType: 'playlist',
            bandwidth: track.bandwidth,
            width: track.width,
            height: track.height,
            codecs: track.codecs,
            language: track.language,
            uri: track.uri,
            audioGroupId: track.audioGroupId
        })),
        audio: parsed.audios.map((track) => ({
            id: track.id,
            kind: 'audio',
            playbackType: 'playlist',
            language: track.language,
            codecs: track.codecs,
            uri: track.uri,
            groupId: track.groupId
        })),
        subtitles: []
    };
}

export function mapHlsMediaTracks(parsed, manifestUrl) {
    return {
        video: [{
            id: 'video',
            kind: 'video',
            playbackType: 'segments',
            uri: manifestUrl,
            initializationUrl: parsed.initializationUrl,
            segmentCount: parsed.segments.length
        }],
        audio: [],
        subtitles: []
    };
}

export async function buildManifestInspectionReport(config) {
    const manifestText = config.manifestText || await fetchText(config.inputUrl, {
        timeoutMs: config.timeoutMs
    });

    const isHls = String(config.inputUrl).toLowerCase().includes('.m3u8') || manifestText.includes('#EXTM3U');

    if (isHls) {
        if (manifestText.includes('#EXT-X-STREAM-INF')) {
            const parsed = parseHlsMasterPlaylist({
                manifestUrl: config.inputUrl,
                manifestText,
                selectVideo: config.selectVideo || 'best',
                selectAudio: config.selectAudio || 'best'
            });

            const tracks = mapHlsMasterTracks(parsed);
            return {
                inputUrl: config.inputUrl,
                manifestType: 'hls-master',
                sourceManifestUrl: config.inputUrl,
                tracks,
                defaultSelection: buildDefaultSelection(tracks),
                defaults: parsed.selected
            };
        }

        const parsed = parseHlsMediaPlaylist({
            manifestUrl: config.inputUrl,
            manifestText
        });
        const tracks = mapHlsMediaTracks(parsed, config.inputUrl);
        return {
            inputUrl: config.inputUrl,
            manifestType: 'hls-media',
            sourceManifestUrl: config.inputUrl,
            tracks,
            defaultSelection: buildDefaultSelection(tracks),
            defaults: { video: tracks.video[0] }
        };
    }

    const parsed = parseMpdManifest({
        manifestUrl: config.inputUrl,
        manifestText,
        selectVideo: config.selectVideo || 'best',
        selectAudio: config.selectAudio || 'best',
        selectSubtitle: config.selectSubtitle || 'all'
    });

    const tracks = mapMpdTracks(parsed);
    return {
        inputUrl: config.inputUrl,
        manifestType: 'mpd',
        sourceManifestUrl: config.inputUrl,
        tracks,
        defaultSelection: buildDefaultSelection(tracks),
        defaults: parsed.selected
    };
}

export async function inspectManifestUrl(input, options = {}) {
    const config = normalizeInspectionInput(input, options);
    if (!config.inputUrl) {
        throw new Error('An inputUrl is required to inspect a URL');
    }

    try {
        return await buildManifestInspectionReport(config);
    } catch (error) {
        return {
            inputUrl: config.inputUrl,
            manifestType: 'unknown',
            sourceManifestUrl: null,
            tracks: {
                video: [],
                audio: [],
                subtitles: []
            },
            defaultSelection: {
                videoIds: [],
                audioIds: [],
                subtitleIds: []
            },
            defaults: null,
            status: 'needs-resolution',
            error: {
                message: error.message,
                name: error.name
            }
        };
    }
}

export async function inspectManifestUrls(urls, options = {}) {
    if (!Array.isArray(urls)) {
        throw new Error('An array of urls is required');
    }

    const reports = [];
    for (const url of urls) {
        reports.push(await inspectManifestUrl(url, options));
    }
    return reports;
}

    export const inspectUrl = inspectManifestUrl;
    export const inspectUrls = inspectManifestUrls;

export default {
    buildDefaultSelection,
    normalizeInspectionInput,
    mapMpdTracks,
    mapHlsMasterTracks,
    mapHlsMediaTracks,
    inspectManifestUrl,
    inspectManifestUrls,
    inspectUrl,
    inspectUrls,
    buildManifestInspectionReport
};
