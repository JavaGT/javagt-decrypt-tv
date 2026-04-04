import {
    createDownloaderContext,
    resolveSelectedTracks,
    obtainAndDecryptMedia,
    muxObtainedMedia
} from '../n3u8dl-node/index.mjs';

export function buildDownloadPlan({ mpdUrl, downloadsPath, saveName, keys = [], requestHeaders = {}, selectVideo = 'best', selectAudio = 'best', selectSubtitle = 'all' }) {
    const config = {
        inputUrl: mpdUrl,
        selectVideo,
        selectAudio,
        selectSubtitle,
        saveDir: downloadsPath,
        saveName,
        keys: [...keys],
        threadCount: 8,
        retries: 3,
        timeoutMs: 15000,
        mergeFormat: 'mkv',
        requestHeaders: { ...requestHeaders }
    };

    const args = [
        config.inputUrl,
        '--select-video', config.selectVideo,
        '--select-audio', config.selectAudio,
        '--select-subtitle', config.selectSubtitle,
        '--save-dir', config.saveDir,
        '--save-name', config.saveName,
        ...config.keys.flatMap((key) => ['--key', key])
    ];

    const summary = {
        type: 'native-node-download',
        inputUrl: config.inputUrl,
        saveDir: config.saveDir,
        saveName: config.saveName,
        keys: [...config.keys],
        selectors: {
            video: config.selectVideo,
            audio: config.selectAudio,
            subtitle: config.selectSubtitle
        }
    };

    return {
        mpdUrl: config.inputUrl,
        downloadsPath: config.saveDir,
        saveName: config.saveName,
        keys: [...config.keys],
        config,
        args,
        summary
    };
}

export async function executeDownloadPlan(plan, { retention, onStart, onComplete, onCommand, mux = true } = {}) {
    if (!plan || !Array.isArray(plan.args)) {
        throw new Error('A valid download plan must be provided');
    }

    if (retention) {
        retention.writeJson('parsed/download_plan.json', plan.summary || {
            type: 'native-node-download',
            inputUrl: plan.config?.inputUrl || plan.mpdUrl,
            saveDir: plan.config?.saveDir || plan.downloadsPath,
            saveName: plan.config?.saveName || plan.saveName,
            keys: plan.keys || []
        });
    }

    if (typeof onCommand === 'function') {
        onCommand(plan.summary || plan);
    }

    if (typeof onStart === 'function') {
        onStart(plan);
    }

    const timings = {};

    const context = createDownloaderContext(plan.config);

    const resolveStart = Date.now();
    const resolved = await resolveSelectedTracks(plan.config);
    timings.resolve_tracks_ms = Date.now() - resolveStart;

    const obtainStart = Date.now();
    const result = await obtainAndDecryptMedia(plan.config, { context, resolved });
    timings.obtain_and_decrypt_ms = Date.now() - obtainStart;

    let outputPath = null;
    const muxStart = Date.now();
    if (mux) {
        outputPath = muxObtainedMedia({
            videoPath: result.decryptedPaths.videoPath,
            audioPath: result.decryptedPaths.audioPath,
            saveDir: context.saveDir,
            safeName: context.safeName,
            mergeFormat: plan.config.mergeFormat
        });
    }
    timings.mux_ms = Date.now() - muxStart;

    const completedPlan = {
        ...plan,
        workDir: context.workDir,
        manifestType: result.manifestType,
        selected: result.selected,
        encryptedPaths: result.encryptedPaths,
        decryptedPaths: result.decryptedPaths,
        outputPath,
        muxed: Boolean(mux)
    };

    if (retention) {
        retention.writeJson('parsed/timings.json', {
            ...timings,
            completed_at: new Date().toISOString()
        });

        retention.writeJson('parsed/selected_tracks.json', {
            video: completedPlan.selected?.video
                ? {
                    id: completedPlan.selected.video.id,
                    bandwidth: completedPlan.selected.video.bandwidth,
                    width: completedPlan.selected.video.width,
                    height: completedPlan.selected.video.height,
                    codecs: completedPlan.selected.video.codecs,
                    language: completedPlan.selected.video.language
                }
                : null,
            audio: completedPlan.selected?.audio
                ? {
                    id: completedPlan.selected.audio.id,
                    bandwidth: completedPlan.selected.audio.bandwidth,
                    codecs: completedPlan.selected.audio.codecs,
                    language: completedPlan.selected.audio.language
                }
                : null,
            subtitles: (completedPlan.selected?.subtitles || []).map((track) => ({
                id: track.id,
                language: track.language,
                kind: track.kind,
                subtitleUrl: track.subtitleUrl
            }))
        });

        if (typeof retention.writeOutputFiles === 'function') {
            retention.writeOutputFiles([
                completedPlan.encryptedPaths?.videoPath,
                completedPlan.encryptedPaths?.audioPath,
                ...(completedPlan.encryptedPaths?.subtitlePaths || []),
                completedPlan.decryptedPaths?.videoPath,
                completedPlan.decryptedPaths?.audioPath,
                ...(completedPlan.decryptedPaths?.subtitlePaths || []),
                completedPlan.outputPath
            ]);
        }
    }

    if (typeof onComplete === 'function') {
        onComplete(completedPlan);
    }

    return completedPlan;
}

export default {
    buildDownloadPlan,
    executeDownloadPlan
};