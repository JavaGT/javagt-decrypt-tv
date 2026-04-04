/**
 * Complete Options - Unified option normalization utility
 * 
 * Handles all option defaults in one place:
 * - Path-level defaults (downloadsPath, devicePath)
 * - Format-level defaults (selectVideo, selectAudio, selectSubtitle)
 * - Format expression translation
 * - Selective merge with user overrides
 */

import { translateFormatExpression } from './module-utils.mjs';

/**
 * Apply all option defaults and normalizations
 * @param {object} inputOptions - Raw options from CLI, HTTP, or programmatic API
 * @returns {object} Fully normalized options with all defaults applied
 */
export function completeOptions(inputOptions = {}) {
    // Handle null/undefined by treating as empty object
    const opts = inputOptions || {};

    // Translate format expression (if provided) to selection objects
    const formatSelections = {
        selectVideo: opts.selectVideo ||
            translateFormatExpression(opts.format || 'bestvideo'),
        selectAudio: opts.selectAudio ||
            translateFormatExpression(opts.format || 'bestaudio'),
        selectSubtitle: opts.selectSubtitle ||
            translateFormatExpression(opts.format || 'best')
    };

    return {
        // Path-level defaults
        downloadsPath: opts.downloadsPath || './downloads',
        devicePath: opts.devicePath || './device.wvd',

        // Format/selection defaults (from format expression or direct values)
        ...formatSelections,

        // Other explicit options (preserved from input)
        output: opts.output,
        providerId: opts.providerId,
        credentials: opts.credentials,
        retentionLevel: opts.retentionLevel,
        noMtime: opts.noMtime,
        format: opts.format,

        // Pass through any additional options not explicitly handled
        ...Object.fromEntries(
            Object.entries(opts).filter(([key]) => ![
                'downloadsPath',
                'devicePath',
                'selectVideo',
                'selectAudio',
                'selectSubtitle',
                'output',
                'providerId',
                'credentials',
                'retentionLevel',
                'noMtime',
                'format'
            ].includes(key))
        )
    };
}
