import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { DOMParser } from 'xmldom';

const BRIGHTCOVE_POLICY_KEY = 'BCpkADawqM0IurzupiJKMb49WkxM__ngDMJ3GOQBhN2ri2Ci_lHwDWIpf4sLFc8bANMc-AVGfGR8GJNgxGqXsbjP1gHsK2Fpkoj6BSpwjrKBnv1D5l5iGPvVYCo';
const BRIGHTCOVE_ACCOUNT_ID = '963482467001';

const TVNZ = {
    brightcove: {
        key: BRIGHTCOVE_POLICY_KEY,
        account: BRIGHTCOVE_ACCOUNT_ID,
        headers: {
            'BCOV-Policy': BRIGHTCOVE_POLICY_KEY,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://www.tvnz.co.nz',
            'Referer': 'https://www.tvnz.co.nz/'
        },
        tokenUrl: 'https://login.tvnz.co.nz/v1/token'
    }
}

const DEFAULT_TIMEOUT_MS = 15000;

function timeoutSignal(ms) {
    return AbortSignal.timeout(ms);
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        signal: options.signal || timeoutSignal(DEFAULT_TIMEOUT_MS)
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${body.slice(0, 300)}`);
    }

    return response.json();
}

async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        signal: options.signal || timeoutSignal(DEFAULT_TIMEOUT_MS)
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${body.slice(0, 300)}`);
    }

    return response.text();
}

function parseEpisodeFromUrl(videoUrl) {
    const match = videoUrl.match(/shows\/([^/]+)\/episodes\/s(\d+)-e(\d+)/i);
    if (!match) {
        return null;
    }

    return {
        seriesSlug: match[1],
        season: match[2],
        episode: match[3]
    };
}

function buildTVNZPageApiUrl(videoUrl) {
    const episode = parseEpisodeFromUrl(videoUrl);
    if (!episode) {
        return null;
    }

    return `https://apis-public-prod.tech.tvnz.co.nz/api/v1/web/play/page/shows/${episode.seriesSlug}/episodes/s${episode.season}-e${episode.episode}`;
}

function extractBrightcoveVideoId(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const currentVideoHref = payload?.layout?.video?.href;
    if (currentVideoHref && payload?._embedded?.[currentVideoHref]?.publisherMetadata?.brightcoveVideoId) {
        return String(payload._embedded[currentVideoHref].publisherMetadata.brightcoveVideoId);
    }

    const ssaiParams = payload?.layout?.video?.advertising?.ssaiParams;
    if (typeof ssaiParams === 'string') {
        const vidMatch = ssaiParams.match(/(?:^|&)vid=(\d{8,})/);
        if (vidMatch) {
            return vidMatch[1];
        }
    }

    const asText = JSON.stringify(payload);
    const directMatch = asText.match(/"brightcoveVideoId"\s*:\s*"?(\d{8,})"?/i);
    if (directMatch) {
        return directMatch[1];
    }

    return null;
}

function parseMpdMetadata(mpdXml, mpdUrl) {
    const doc = new DOMParser().parseFromString(mpdXml, 'application/xml');
    const adaptationSets = Array.from(doc.getElementsByTagName('AdaptationSet'));

    const videoStreams = [];
    const audioStreams = [];

    for (const adaptSet of adaptationSets) {
        const mimeType = adaptSet.getAttribute('mimeType') || '';
        const reps = Array.from(adaptSet.getElementsByTagName('Representation'));

        if (mimeType.startsWith('video')) {
            for (const rep of reps) {
                videoStreams.push({
                    width: rep.getAttribute('width'),
                    height: rep.getAttribute('height'),
                    bandwidth: rep.getAttribute('bandwidth')
                });
            }
        }

        if (mimeType.startsWith('audio')) {
            for (const rep of reps) {
                audioStreams.push({
                    language: adaptSet.getAttribute('lang') || null,
                    bandwidth: rep.getAttribute('bandwidth')
                });
            }
        }
    }

    let resolution = 'unknown';
    const heights = videoStreams
        .map(v => Number(v.height))
        .filter(Number.isFinite)
        .sort((a, b) => b - a);

    if (heights.length) {
        resolution = `${heights[0]}p`;
    }

    return {
        mpd_url: mpdUrl,
        duration: doc.documentElement?.getAttribute('mediaPresentationDuration') || null,
        video_streams: videoStreams,
        audio_streams: audioStreams,
        total_representations: videoStreams.length + audioStreams.length,
        top_resolution: resolution
    };
}

function buildOutputName(videoUrl, resolution) {
    const episode = parseEpisodeFromUrl(videoUrl);
    if (!episode) {
        return `TVNZ.Video.${resolution}.metadata.json`;
    }

    const series = episode.seriesSlug.replace(/-/g, ' ').trim().replace(/\s+/g, '.');
    const season = episode.season.padStart(2, '0');
    const ep = episode.episode.padStart(2, '0');
    return `${series}.S${season}E${ep}.${resolution}.metadata.json`;
}

function buildMediaBaseName(videoUrl, resolution) {
    const metadataName = buildOutputName(videoUrl, resolution);
    return metadataName.replace(/\.metadata\.json$/i, '');
}

function saveMetadata(downloadsPath, outputName, metadata) {
    fs.mkdirSync(downloadsPath, { recursive: true });
    const outPath = path.join(downloadsPath, outputName);
    fs.writeFileSync(outPath, JSON.stringify(metadata, null, 2));
    return outPath;
}

function parseWidevineKeysFromEnv() {
    const raw = process.env.TVNZ_WIDEVINE_KEYS || '';
    if (!raw.trim()) {
        return [];
    }

    return raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

function runDownloader(mpdUrl, downloadsPath, mediaBaseName, keys) {
    const args = [
        mpdUrl,
        '--select-video', 'best',
        '--select-audio', 'best',
        '--select-subtitle', 'all',
        '-mt',
        '-M', 'format=mkv',
        '--save-dir', downloadsPath,
        '--save-name', mediaBaseName
    ];

    for (const key of keys) {
        args.push('--key', key);
    }

    console.info(`Starting downloader: N_m3u8DL-RE ${args.join(' ')}`);
    const result = spawnSync('N_m3u8DL-RE', args, { stdio: 'inherit' });

    if (result.error) {
        throw new Error(`Failed to start N_m3u8DL-RE: ${result.error.message}`);
    }

    if (typeof result.status === 'number' && result.status !== 0) {
        throw new Error(`N_m3u8DL-RE exited with code ${result.status}`);
    }
}

async function getBrightcovePlayback(videoId) {
    const accountId = process.env.BRIGHTCOVE_ACCOUNT_ID || TVNZ.brightcove.account;
    const policyKey = process.env.BRIGHTCOVE_POLICY_KEY || TVNZ.brightcove.key;

    if (!accountId || !policyKey) {
        return { skipped: true, reason: 'Missing BRIGHTCOVE_ACCOUNT_ID or BRIGHTCOVE_POLICY_KEY configuration' };
    }

    const url = `https://edge.api.brightcove.com/playback/v1/accounts/${accountId}/videos/${videoId}`;
    const data = await fetchJson(url, {
        headers: {
            Accept: 'application/json;pk=' + policyKey,
            'BCOV-Policy': policyKey
        }
    });

    return { skipped: false, data };
}

async function run() {
    dotenv.config();

    if (process.argv.length < 4) {
        console.error('Usage: node index.mjs <TVNZ_URL> <downloads_path> [wvd_device_path]');
        process.exit(1);
    }

    const videoUrl = process.argv[2];
    const downloadsPath = process.argv[3];
    const wvdDevicePath = process.argv[4] || null;

    const metadata = {
        collection_timestamp: new Date().toISOString(),
        input: {
            video_url: videoUrl,
            downloads_path: downloadsPath,
            wvd_device_path: wvdDevicePath
        },
        tvnz_platform: null,
        brightcove_playback: null,
        dash_manifest: null,
        notes: []
    };

    const tvnzApiUrl = buildTVNZPageApiUrl(videoUrl);
    if (!tvnzApiUrl) {
        throw new Error('URL format not recognized. Expected TVNZ episode URL like /shows/<series>/episodes/sYYYY-eNN');
    }

    console.info(`Fetching TVNZ page API: ${tvnzApiUrl}`);
    const tvnzData = await fetchJson(tvnzApiUrl);
    metadata.tvnz_platform = {
        api_url: tvnzApiUrl,
        title: tvnzData?.title || null,
        type: tvnzData?.type || null,
        key_count: Object.keys(tvnzData || {}).length
    };

    const brightcoveVideoId = extractBrightcoveVideoId(tvnzData);
    if (!brightcoveVideoId) {
        metadata.notes.push('Could not find Brightcove video id in TVNZ API response.');
        const outputPath = saveMetadata(downloadsPath, buildOutputName(videoUrl, 'unknown'), metadata);
        console.info(`Metadata saved: ${outputPath}`);
        console.info('Run completed without MPD parsing because Brightcove video id was not found.');
        return;
    }

    console.info(`Found Brightcove video id: ${brightcoveVideoId}`);
    const brightcoveResult = await getBrightcovePlayback(brightcoveVideoId);

    if (brightcoveResult.skipped) {
        metadata.notes.push(brightcoveResult.reason);
        metadata.brightcove_playback = { video_id: brightcoveVideoId, skipped: true };
        const outputPath = saveMetadata(downloadsPath, buildOutputName(videoUrl, 'unknown'), metadata);
        console.info(`Metadata saved: ${outputPath}`);
        console.info(brightcoveResult.reason);
        console.info('Set BRIGHTCOVE_ACCOUNT_ID and BRIGHTCOVE_POLICY_KEY to enable playback source lookup.');
        return;
    }

    const brightcoveData = brightcoveResult.data;
    metadata.brightcove_playback = {
        video_id: brightcoveVideoId,
        id: brightcoveData?.id || null,
        name: brightcoveData?.name || null,
        duration_ms: brightcoveData?.duration || null,
        source_count: Array.isArray(brightcoveData?.sources) ? brightcoveData.sources.length : 0
    };

    const sources = Array.isArray(brightcoveData?.sources) ? brightcoveData.sources : [];
    const widevineSource = sources.find(source =>
        source?.src && source?.type === 'application/dash+xml' && source?.key_systems?.['com.widevine.alpha']
    );

    if (!widevineSource) {
        metadata.notes.push('No DASH Widevine source found in Brightcove sources.');
        const outputPath = saveMetadata(downloadsPath, buildOutputName(videoUrl, 'unknown'), metadata);
        console.info(`Metadata saved: ${outputPath}`);
        console.info('Run completed without MPD parsing because no Widevine DASH source was available.');
        return;
    }

    const mpdUrl = widevineSource.src;
    console.info(`Fetching MPD: ${mpdUrl}`);
    const mpdXml = await fetchText(mpdUrl);
    const mpdMeta = parseMpdMetadata(mpdXml, mpdUrl);
    metadata.dash_manifest = mpdMeta;

    const mediaBaseName = buildMediaBaseName(videoUrl, mpdMeta.top_resolution);
    const keys = parseWidevineKeysFromEnv();
    metadata.download = {
        downloader: 'N_m3u8DL-RE',
        media_base_name: mediaBaseName,
        key_count: keys.length,
        note: keys.length
            ? 'Using TVNZ_WIDEVINE_KEYS from environment.'
            : 'No TVNZ_WIDEVINE_KEYS provided. Download may fail for DRM-protected content.'
    };

    const outputPath = saveMetadata(downloadsPath, buildOutputName(videoUrl, mpdMeta.top_resolution), metadata);
    console.info(`Metadata saved: ${outputPath}`);

    if (!keys.length) {
        console.info('No TVNZ_WIDEVINE_KEYS set. Attempting download anyway.');
    }

    runDownloader(mpdUrl, downloadsPath, mediaBaseName, keys);
    console.info('Run completed successfully.');
}

run().catch(error => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
});
