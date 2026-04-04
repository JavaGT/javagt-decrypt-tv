/**
 * CLI Presenter - Output formatting for track information
 * Responsible for transforming track data into human-readable console output.
 * Pure functions except presentTracks which has console.log side effects.
 */

/**
 * Format a value as a fixed-width cell: pad with spaces or truncate
 * @param {*} value - Value to format (will be converted to string)
 * @param {number} width - Target cell width in characters
 * @returns {string} Fixed-width string (padded or truncated)
 */
export function formatCell(value, width) {
    const text = String(value ?? '');
    return text.length >= width ? text.slice(0, width) : text.padEnd(width, ' ');
}

/**
 * Summarize a track object into normalized fields for display
 * Handles multiple naming conventions for same logical field (e.g., bitrate vs bandwidth)
 * @param {object} track - Track metadata object from manifest
 * @returns {object} Normalized track summary with standard fields
 */
export function trackSummary(track) {
    const resolution = track?.width && track?.height ? `${track.width}x${track.height}` : track?.resolution || track?.size || '-';
    const bitrate = track?.bandwidth || track?.bitrate || track?.totalBitrate || '-';
    const language = track?.language || track?.lang || track?.locale || '-';
    const codecs = track?.codecs || track?.codec || '-';
    const label = track?.label || track?.name || track?.title || track?.id || '-';
    const tags = [];
    if (track?.default) tags.push('default');
    if (track?.forced) tags.push('forced');
    if (track?.autoselect) tags.push('autoselect');

    return {
        id: track?.id || '-',
        kind: track?.kind || track?.type || '-',
        label,
        resolution,
        bitrate,
        language,
        codecs,
        tags: tags.join(',') || '-'
    };
}

/**
 * Present track inspection report to console
 * Prints title, provider, manifest info, and formatted track tables by type (video/audio/subtitles)
 * @param {object} report - Inspection report from moduleAdapter.inspect()
 */
export function presentTracks(report) {
    const sections = [
        ['Video', report.tracks?.video || []],
        ['Audio', report.tracks?.audio || []],
        ['Subtitles', report.tracks?.subtitles || []]
    ];

    console.log(`Title: ${report.pageUrl || report.inputUrl}`);
    console.log(`Provider: ${report.provider || 'unknown'}`);
    console.log(`Manifest: ${report.manifestType || 'unknown'}`);
    if (report.sourceManifestUrl) {
        console.log(`Manifest URL: ${report.sourceManifestUrl}`);
    }
    console.log('');

    for (const [sectionName, tracks] of sections) {
        console.log(`${sectionName} formats:`);
        if (!tracks.length) {
            console.log('  (none)');
            console.log('');
            continue;
        }

        console.log(`  ${formatCell('ID', 18)}${formatCell('RES', 14)}${formatCell('BITRATE', 12)}${formatCell('LANG', 10)}${formatCell('CODECS', 18)}${formatCell('TAGS', 16)}LABEL`);
        for (const track of tracks) {
            const summary = trackSummary(track);
            console.log(`  ${formatCell(summary.id, 18)}${formatCell(summary.resolution, 14)}${formatCell(summary.bitrate, 12)}${formatCell(summary.language, 10)}${formatCell(summary.codecs, 18)}${formatCell(summary.tags, 16)}${summary.label}`);
        }
        console.log('');
    }
}
