import { takeOptionValue } from '../../infra/arg-utils.mjs';

export function parseN3u8LikeArgs(argv) {
    if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('Input URL is required');
    }

    const config = {
        inputUrl: argv[0],
        selectVideo: 'best',
        selectAudio: 'best',
        selectSubtitle: 'none',
        saveDir: process.cwd(),
        saveName: 'output',
        keys: [],
        threadCount: 8,
        retries: 3,
        timeoutMs: 15000,
        mergeFormat: 'mkv'
    };

    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--select-video' || arg === '-sv') {
            config.selectVideo = takeOptionValue(argv, i, arg);
            i += 1;
            continue;
        }

        if (arg === '--select-audio' || arg === '-sa') {
            config.selectAudio = takeOptionValue(argv, i, arg);
            i += 1;
            continue;
        }

        if (arg === '--select-subtitle' || arg === '-ss') {
            config.selectSubtitle = takeOptionValue(argv, i, arg);
            i += 1;
            continue;
        }

        if (arg === '--save-dir') {
            config.saveDir = takeOptionValue(argv, i, arg);
            i += 1;
            continue;
        }

        if (arg === '--save-name') {
            config.saveName = takeOptionValue(argv, i, arg);
            i += 1;
            continue;
        }

        if (arg === '--key') {
            config.keys.push(takeOptionValue(argv, i, arg));
            i += 1;
            continue;
        }

        if (arg === '--thread-count') {
            config.threadCount = Number(takeOptionValue(argv, i, arg)) || config.threadCount;
            i += 1;
            continue;
        }

        if (arg === '--download-retry-count') {
            config.retries = Number(takeOptionValue(argv, i, arg)) || config.retries;
            i += 1;
            continue;
        }

        if (arg === '--http-request-timeout') {
            const seconds = Number(takeOptionValue(argv, i, arg));
            if (Number.isFinite(seconds) && seconds > 0) {
                config.timeoutMs = Math.round(seconds * 1000);
            }
            i += 1;
            continue;
        }

        if (arg === '-M' || arg === '--mux-after-done') {
            const muxArg = takeOptionValue(argv, i, arg);
            const formatMatch = muxArg.match(/(?:^|:)format=([^:]+)/);
            if (formatMatch) {
                config.mergeFormat = formatMatch[1];
            }
            i += 1;
            continue;
        }

        if (arg === '-mt' || arg === '--concurrent-download') {
            continue;
        }
    }

    return config;
}

export default {
    parseN3u8LikeArgs
};
