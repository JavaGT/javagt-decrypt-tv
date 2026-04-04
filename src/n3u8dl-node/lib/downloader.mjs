import fs from 'fs';
import path from 'path';
import { fetchText } from '../../infra/http-client.mjs';
import { parseMpdManifest } from './mpd-parser.mjs';
import { parseHlsMasterPlaylist, parseHlsMediaPlaylist } from './hls-parser.mjs';
import { inspectManifestUrl, inspectManifestUrls } from './manifest-inspector.mjs';
import {
    fetchBuffer,
    fetchTextWithRetry,
    ensureDir,
    toSafeName,
    runPool,
    resolveExecutable,
    runCommand,
    applyManifestQueryParams
} from './downloader-utils.mjs';

async function downloadTrack(track, outputDir, config) {
    if (!track) {
        return null;
    }

    const trackDir = path.join(outputDir, track.id);
    ensureDir(trackDir);

    const parts = [];
    let index = 0;

    if (track.initializationUrl) {
        const initName = `${String(index).padStart(6, '0')}.part`;
        const initPath = path.join(trackDir, initName);
        const initBuffer = await fetchBuffer(track.initializationUrl, config);
        fs.writeFileSync(initPath, initBuffer);
        parts.push(initPath);
        index += 1;
    }

    const segmentUrls = Array.isArray(track.segmentUrls)
        ? track.segmentUrls
        : Array.isArray(track.segments)
            ? track.segments.map((segment) => segment.url)
            : [];

    const jobs = segmentUrls.map((segmentUrl, i) => ({
        i,
        segmentUrl,
        filePath: path.join(trackDir, `${String(index + i).padStart(6, '0')}.part`)
    }));

    await runPool(jobs, config.threadCount, async (job) => {
        const buffer = await fetchBuffer(job.segmentUrl, config);
        fs.writeFileSync(job.filePath, buffer);
    });

    for (const job of jobs) {
        parts.push(job.filePath);
    }

    const extension = track === config.selected.video ? 'video.mp4' : 'audio.m4a';
    const mergedPath = path.join(outputDir, extension);
    const handle = fs.openSync(mergedPath, 'w');
    try {
        for (const partPath of parts) {
            const content = fs.readFileSync(partPath);
            fs.writeSync(handle, content);
        }
    } finally {
        fs.closeSync(handle);
    }

    return mergedPath;
}

async function downloadSubtitleTrack(track, context, config) {
    if (!track) {
        return null;
    }

    const safeId = String(track.id || 'subtitle').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const subtitleName = `${context.safeName}.${safeId}.vtt`;
    const subtitlePath = path.join(context.saveDir, subtitleName);

    if (track.subtitleUrl) {
        const content = await fetchTextWithRetry(track.subtitleUrl, config);
        fs.writeFileSync(subtitlePath, content, 'utf8');
        return subtitlePath;
    }

    const segmentUrls = Array.isArray(track.segmentUrls)
        ? track.segmentUrls
        : Array.isArray(track.segments)
            ? track.segments.map((segment) => segment.url)
            : [];

    if (!segmentUrls.length) {
        return null;
    }

    const chunks = [];
    if (track.initializationUrl) {
        chunks.push(await fetchTextWithRetry(track.initializationUrl, config));
    }
    for (const segmentUrl of segmentUrls) {
        chunks.push(await fetchTextWithRetry(segmentUrl, config));
    }
    fs.writeFileSync(subtitlePath, chunks.join('\n'), 'utf8');
    return subtitlePath;
}

function decryptIfNeeded(filePath, keys, outputDir) {
    if (!filePath || !keys || !keys.length) {
        return filePath;
    }

    const mp4decrypt = resolveExecutable(process.env.MP4DECRYPT_PATH, 'mp4decrypt');
    const ext = path.extname(filePath);
    const name = path.basename(filePath, ext);
    const outPath = path.join(outputDir, `${name}.decrypted${ext}`);

    const args = [];
    for (const key of keys) {
        args.push('--key', key);
    }
    args.push(filePath, outPath);

    runCommand(mp4decrypt, args);
    return outPath;
}

function muxTracks({ videoPath, audioPath, outputPath }) {
    if (!videoPath && !audioPath) {
        throw new Error('No audio/video tracks available to mux');
    }

    if (videoPath && !audioPath) {
        fs.copyFileSync(videoPath, outputPath);
        return outputPath;
    }

    if (audioPath && !videoPath) {
        fs.copyFileSync(audioPath, outputPath);
        return outputPath;
    }

    const ffmpeg = resolveExecutable(process.env.FFMPEG_PATH, 'ffmpeg');
    const args = ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath];
    runCommand(ffmpeg, args);
    return outputPath;
}

function selectTracksFromReport(report, selection = {}) {
    const tracks = report?.tracks || { video: [], audio: [], subtitles: [] };

    const videoIds = selection.videoIds?.length ? selection.videoIds : report?.defaultSelection?.videoIds || [];
    const audioIds = selection.audioIds?.length ? selection.audioIds : report?.defaultSelection?.audioIds || [];
    const subtitleIds = selection.subtitleIds?.length ? selection.subtitleIds : report?.defaultSelection?.subtitleIds || [];

    const pick = (items, ids) => ids.length ? items.filter((item) => ids.includes(item.id)) : [];

    return {
        video: pick(tracks.video || [], videoIds),
        audio: pick(tracks.audio || [], audioIds),
        subtitles: pick(tracks.subtitles || [], subtitleIds)
    };
}

async function materializeSelectedTrack(track, config, kind) {
    if (!track) {
        return null;
    }

    if (track.playbackType === 'playlist' && track.uri) {
        const playlistText = await fetchText(track.uri, { timeoutMs: config.timeoutMs, headers: config.headers || {} });
        const media = parseHlsMediaPlaylist({
            manifestUrl: track.uri,
            manifestText: playlistText
        });
        return {
            ...track,
            initializationUrl: media.initializationUrl,
            segmentUrls: media.segments.map((segment) => segment.url),
            segments: media.segments
        };
    }

    if (kind === 'subtitle' && track.subtitleUrl) {
        return track;
    }

    return track;
}

export async function downloadSelection(report, selection = {}, options = {}) {
    if (!report?.tracks) {
        throw new Error('A report from inspectManifestUrl() is required');
    }

    const context = options.context || createDownloaderContext({
        saveDir: options.saveDir || process.cwd(),
        saveName: options.saveName || report.inputUrl || 'output'
    });
    const config = {
        inputUrl: report.sourceManifestUrl || report.inputUrl,
        saveDir: context.saveDir,
        saveName: context.safeName,
        keys: options.keys || [],
        timeoutMs: options.timeoutMs || 15000,
        retries: options.retries || 3,
        threadCount: options.threadCount || 8,
        headers: options.headers || {}
    };

    const chosen = selectTracksFromReport(report, selection);
    const chosenVideo = chosen.video[0] || null;
    const chosenAudio = chosen.audio[0] || null;
    const chosenSubtitles = chosen.subtitles || [];

    const materializedVideo = await materializeSelectedTrack(chosenVideo, config, 'video');
    const materializedAudio = await materializeSelectedTrack(chosenAudio, config, 'audio');

    const videoPath = await downloadTrack(materializedVideo, context.workDir, {
        ...config,
        selected: { video: materializedVideo }
    });
    const audioPath = await downloadTrack(materializedAudio, context.workDir, {
        ...config,
        selected: { video: materializedVideo }
    });

    const subtitlePaths = [];
    for (const subtitle of chosenSubtitles) {
        const subtitlePath = await downloadSubtitleTrack(subtitle, context, config);
        if (subtitlePath) {
            subtitlePaths.push(subtitlePath);
        }
    }

    const decryptedVideo = decryptIfNeeded(videoPath, config.keys, context.workDir);
    const decryptedAudio = decryptIfNeeded(audioPath, config.keys, context.workDir);

    return {
        report,
        context,
        selection: chosen,
        downloadedPaths: {
            videoPath: decryptedVideo,
            audioPath: decryptedAudio,
            subtitlePaths
        }
    };
}

export async function inspectAndDownload(input, selection = {}, options = {}) {
    const report = await inspectManifestUrl(input, options);
    return downloadSelection(report, selection, options);
}

export function createDownloaderContext(config = {}) {
    const safeName = toSafeName(config.saveName || 'output');
    const saveDir = path.resolve(config.saveDir || process.cwd());
    const workDir = path.join(saveDir, `${safeName}.work`);
    ensureDir(workDir);
    return {
        safeName,
        saveDir,
        workDir
    };
}

export async function resolveSelectedTracks(config, options = {}) {
    const manifestText = options.manifestText || await fetchText(config.inputUrl, {
        timeoutMs: config.timeoutMs
    });

    const isHls = String(config.inputUrl).toLowerCase().includes('.m3u8') || manifestText.includes('#EXTM3U');

    let selectedTracks;
    if (isHls) {
        if (manifestText.includes('#EXT-X-STREAM-INF')) {
            const parsedMaster = parseHlsMasterPlaylist({
                manifestUrl: config.inputUrl,
                manifestText,
                selectVideo: config.selectVideo,
                selectAudio: config.selectAudio
            });

            const videoManifestText = await fetchText(parsedMaster.selected.video.uri, {
                timeoutMs: config.timeoutMs
            });

            const videoPlaylist = parseHlsMediaPlaylist({
                manifestUrl: parsedMaster.selected.video.uri,
                manifestText: videoManifestText
            });

            let audioPlaylist = null;
            if (parsedMaster.selected.audio?.uri) {
                const audioManifestText = await fetchText(parsedMaster.selected.audio.uri, {
                    timeoutMs: config.timeoutMs
                });
                audioPlaylist = parseHlsMediaPlaylist({
                    manifestUrl: parsedMaster.selected.audio.uri,
                    manifestText: audioManifestText
                });
            }

            selectedTracks = {
                video: {
                    id: parsedMaster.selected.video.id || 'video',
                    initializationUrl: videoPlaylist.initializationUrl,
                    segments: videoPlaylist.segments
                },
                audio: audioPlaylist
                    ? {
                        id: parsedMaster.selected.audio?.id || 'audio',
                        initializationUrl: audioPlaylist.initializationUrl,
                        segments: audioPlaylist.segments
                    }
                    : null
            };
        } else {
            const mediaPlaylist = parseHlsMediaPlaylist({
                manifestUrl: config.inputUrl,
                manifestText
            });
            selectedTracks = {
                video: {
                    id: 'video',
                    initializationUrl: mediaPlaylist.initializationUrl,
                    segments: mediaPlaylist.segments
                },
                audio: null
            };
        }

        for (const track of [selectedTracks.video, selectedTracks.audio]) {
            if (!track?.segments?.length) {
                continue;
            }
            const encrypted = track.segments.find((segment) => {
                const method = String(segment?.key?.METHOD || '').toUpperCase();
                return method && method !== 'NONE';
            });
            if (encrypted) {
                throw new Error('HLS segment encryption tags are detected. This stream type is not supported yet in the Node downloader module.');
            }
        }
    } else {
        const parsedMpd = parseMpdManifest({
            manifestUrl: config.inputUrl,
            manifestText,
            selectVideo: config.selectVideo,
            selectAudio: config.selectAudio,
            selectSubtitle: config.selectSubtitle
        });
        selectedTracks = {
            video: applyManifestQueryParams(parsedMpd.selected.video, config.inputUrl),
            audio: applyManifestQueryParams(parsedMpd.selected.audio, config.inputUrl),
            subtitles: parsedMpd.selected.subtitles || []
        };
    }

    return {
        selectedTracks,
        manifestType: isHls ? 'hls' : 'mpd',
        manifestText
    };
}

export async function obtainMediaData(config, options = {}) {
    const context = options.context || createDownloaderContext(config);
    const resolved = options.resolved || await resolveSelectedTracks(config);

    const runConfig = {
        ...config,
        headers: config.requestHeaders || config.headers || {},
        selected: resolved.selectedTracks
    };

    const videoPath = await downloadTrack(resolved.selectedTracks.video, context.workDir, runConfig);
    const audioPath = await downloadTrack(resolved.selectedTracks.audio, context.workDir, runConfig);
    const subtitlePaths = [];
    for (const subtitleTrack of resolved.selectedTracks.subtitles || []) {
        const subtitlePath = await downloadSubtitleTrack(subtitleTrack, context, runConfig);
        if (subtitlePath) {
            subtitlePaths.push(subtitlePath);
        }
    }

    return {
        context,
        manifestType: resolved.manifestType,
        selected: resolved.selectedTracks,
        encryptedPaths: {
            videoPath,
            audioPath,
            subtitlePaths
        }
    };
}

export function decryptObtainedMedia({ encryptedPaths, keys = [], workDir }) {
    return {
        videoPath: decryptIfNeeded(encryptedPaths?.videoPath, keys, workDir),
        audioPath: decryptIfNeeded(encryptedPaths?.audioPath, keys, workDir),
        subtitlePaths: Array.isArray(encryptedPaths?.subtitlePaths) ? [...encryptedPaths.subtitlePaths] : []
    };
}

export function muxObtainedMedia({ videoPath, audioPath, saveDir, safeName, mergeFormat = 'mkv' }) {
    const finalExt = mergeFormat === 'mp4' ? 'mp4' : 'mkv';
    const outputPath = path.join(saveDir, `${safeName}.${finalExt}`);
    muxTracks({ videoPath, audioPath, outputPath });
    return outputPath;
}

export async function obtainAndDecryptMedia(config, options = {}) {
    const context = options.context || createDownloaderContext(config);
    const obtained = await obtainMediaData(config, { context, resolved: options.resolved });
    const decryptedPaths = decryptObtainedMedia({
        encryptedPaths: obtained.encryptedPaths,
        keys: config.keys,
        workDir: context.workDir
    });

    return {
        context,
        manifestType: obtained.manifestType,
        selected: obtained.selected,
        encryptedPaths: obtained.encryptedPaths,
        decryptedPaths
    };
}

export async function runNodeDownloader(config) {
    const context = createDownloaderContext(config);
    const result = await obtainAndDecryptMedia(config, { context });
    const outputPath = muxObtainedMedia({
        videoPath: result.decryptedPaths.videoPath,
        audioPath: result.decryptedPaths.audioPath,
        saveDir: context.saveDir,
        safeName: context.safeName,
        mergeFormat: config.mergeFormat
    });

    return {
        outputPath,
        workDir: context.workDir,
        selected: result.selected,
        manifestType: result.manifestType,
        encryptedPaths: result.encryptedPaths,
        decryptedPaths: result.decryptedPaths
    };
}

export const inspectUrl = inspectManifestUrl;
export const inspectUrls = inspectManifestUrls;


export { inspectManifestUrl, inspectManifestUrls };
export default {
    createDownloaderContext,
    inspectManifestUrl,
    inspectManifestUrl,
    inspectManifestUrls,
    inspectManifestUrls,
    inspectUrl,
    inspectUrls,
    downloadSelection,
    inspectAndDownload,
    resolveSelectedTracks,
    obtainMediaData,
    decryptObtainedMedia,
    muxObtainedMedia,
    obtainAndDecryptMedia,
    runNodeDownloader
};
