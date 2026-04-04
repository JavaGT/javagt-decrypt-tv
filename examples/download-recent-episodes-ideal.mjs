#!/usr/bin/env node

/**
 * IDEAL API Example:
 * 1) Import decrypt module class and provider classes.
 * 2) Instantiate module with runtime settings only (no quality preferences).
 * 3) Instantiate providers, set auth on providers, add providers to module.
 * 4) Use separate episode-listing API (placeholder in this script) to get latest episodes.
 * 5) Inspect each episode first, then download with explicit low-res/low-bitrate preferences.
 */

import { DecryptModule } from '../src/index.mjs';
import { TvnzProvider } from '../src/providers/tvnz-provider.mjs';
import { ThreeNowProvider } from '../src/providers/threenow-provider.mjs';

function now() {
    return new Date().toISOString();
}

const log = {
    info(message) {
        console.log(`[${now()}] INFO  ${message}`);
    },
    step(message) {
        console.log(`[${now()}] STEP  ${message}`);
    },
    ok(message) {
        console.log(`[${now()}] OK    ${message}`);
    },
    warn(message) {
        console.warn(`[${now()}] WARN  ${message}`);
    },
    error(message) {
        console.error(`[${now()}] ERROR ${message}`);
    }
};

class DebugRetainer {
    constructor({ dumpDir, verbose = false }) {
        this.dumpDir = dumpDir;
        this.verbose = verbose;
    }

    dump(eventName, payload) {
        const alwaysShow = eventName === 'summary';
        if (!this.verbose && !alwaysShow) {
            return;
        }

        const preview = JSON.stringify(payload).slice(0, 180);
        console.log(`[${now()}] RETAINER ${eventName}: ${preview}`);
    }
}

// Placeholder for a separate module, e.g.:
// import { listEpisodesForShow } from './episode-listing-api.mjs';
async function listEpisodesForShow(showUrl, options = {}) {
    void showUrl;
    void options;
    // In the real separate module, this would return normalized episode objects.
    // Keeping this as placeholder per request.
    return [
        {
            id: 'episode-1',
            title: 'Most Recent Episode',
            publishedAt: '2026-04-04T18:30:00.000Z',
            playbackUrl: 'https://www.tvnz.co.nz/shows/shortland-street/episodes/s2025-e137'
        },
        {
            id: 'episode-2',
            title: 'Second Most Recent Episode',
            publishedAt: '2026-04-03T18:30:00.000Z',
            playbackUrl: 'https://www.tvnz.co.nz/shows/shortland-street/episodes/s2025-e138'
        }
    ];
}

async function main() {
    const runStartedAt = Date.now();
    const verboseRetainerLogs = process.env.VERBOSE_RETAINER_LOGS === '1';

    const decrypt_module = new DecryptModule({
        downloadsDir: './episodes',
        tempDir: './tmp',
        retainer: new DebugRetainer({
            dumpDir: './retained-debug',
            verbose: verboseRetainerLogs
        })
    });

    const tvnzAuth = {
        username: process.env.TVNZ_USERNAME,
        password: process.env.TVNZ_PASSWORD
    };

    if (!tvnzAuth.username || !tvnzAuth.password) {
        throw new Error('Missing TVNZ auth. Set TVNZ_USERNAME and TVNZ_PASSWORD in .env');
    }

    log.info(`Starting ideal download flow. Retainer verbose mode: ${verboseRetainerLogs ? 'on' : 'off'}`);

    // Providers are always explicit instances, even built-in ones.
    const tvnz_provider = new TvnzProvider();
    const threenow_provider = new ThreeNowProvider();

    // Provider-level auth configuration (service-specific secrets stay on providers).
    tvnz_provider.setAuth(tvnzAuth);

    threenow_provider.setAuth({
        username: process.env.THREENOW_USERNAME,
        password: process.env.THREENOW_PASSWORD,
    });

    decrypt_module.addProvider(tvnz_provider);
    decrypt_module.addProvider(threenow_provider);
    log.ok('Providers registered: tvnz, threenow');

    const showUrl = 'https://www.tvnz.co.nz/shows/shortland-street';
    log.step(`Fetching episodes for ${showUrl}`);

    // Episode discovery API is separate from decrypt module.
    const allEpisodes = await listEpisodesForShow(showUrl, {
        provider: 'tvnz',
        sort: 'publishedAt:desc'
    });

    const recentTwoEpisodes = allEpisodes
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, 2);

    log.ok(`Found ${recentTwoEpisodes.length} most recent episodes`);
    recentTwoEpisodes.forEach((ep, i) => {
        log.info(`${i + 1}. ${ep.title} (published ${ep.publishedAt})`);
    });

    log.step('Starting episode download loop');

    for (let i = 0; i < recentTwoEpisodes.length; i += 1) {
        const episode = recentTwoEpisodes[i];
        const itemStartedAt = Date.now();
        const downloadName = `shortland-street-${episode.id}`;

        log.step(`[${i + 1}/${recentTwoEpisodes.length}] Inspecting ${episode.title}`);

        // Inspect first to discover available tracks/options.
        const inspectReport = await decrypt_module.inspect(episode.playbackUrl, {
            providerId: 'tvnz'
        });
        // or 
        // const inspectReport = await tvnz_provider.inspect(episode.playbackUrl);

        log.info(`Manifest type: ${inspectReport.manifestType || 'unknown'} | Tracks: v=${inspectReport.tracks?.video?.length || 0}, a=${inspectReport.tracks?.audio?.length || 0}, s=${inspectReport.tracks?.subtitles?.length || 0}`);

        // Example preference object from inspect results.
        // Low resolution + low bitrate selected at download time, not module creation time.
        const lowQualityPreferences = {
            video: {
                strategy: ['lowest-bitrate', 'lowest-resolution'],
                maxHeight: 540
            },
            audio: {
                strategy: 'lowest-bitrate',
                preferredLanguages: ['en', 'en-NZ']
            },
            subtitle: {
                strategy: 'all', // download all subtitles available
                preferredLanguages: ['en', 'en-NZ']
            }
        };

        log.step(`[${i + 1}/${recentTwoEpisodes.length}] Downloading ${downloadName}`);

        const result = await decrypt_module.download(episode.playbackUrl, {
            providerId: 'tvnz',
            output: downloadName,
            preferences: lowQualityPreferences,
            inspectContext: inspectReport,
            saveMetadata: true,
            preserveTimestamp: false,
            retentionLevel: 'safe'
        });
//         or         
//         const result = await tvnz_provider.download(episode.playbackUrl, {
//             output: downloadName,
//             preferences: lowQualityPreferences,
//             inspectContext: inspectReport,
//             saveMetadata: true,
//             preserveTimestamp: false,
//             retentionLevel: 'safe'
//         });

        const elapsedSeconds = ((Date.now() - itemStartedAt) / 1000).toFixed(1);
        log.ok(`Downloaded ${downloadName} in ${elapsedSeconds}s`);
        log.info(`Output: ${result.outputPath}`);
        if (result.metadataPath) {
            log.info(`Metadata: ${result.metadataPath}`);
        }
    }

    const totalSeconds = ((Date.now() - runStartedAt) / 1000).toFixed(1);
    log.ok(`All episodes downloaded successfully in ${totalSeconds}s`);
}

// ============================================================================
main().catch((error) => {
    log.error(error.message);
    if (process.env.DEBUG_STACKS === '1' && error?.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
