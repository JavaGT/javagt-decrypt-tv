import { resolveUrl } from './xml.mjs';
import {
    parseSelectionExpression,
    applySelectorFilters,
    selectItemsByMode
} from './selection.mjs';

function parseAttributes(attrText) {
    const attrs = {};
    let current = '';
    let quote = null;
    const parts = [];

    for (let i = 0; i < attrText.length; i += 1) {
        const ch = attrText[i];
        if ((ch === '"' || ch === "'") && (i === 0 || attrText[i - 1] !== '\\')) {
            quote = quote === ch ? null : ch;
            current += ch;
            continue;
        }

        if (ch === ',' && !quote) {
            parts.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        parts.push(current.trim());
    }

    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx < 1) {
            continue;
        }
        const key = part.slice(0, idx).trim();
        let value = part.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        attrs[key] = value;
    }

    return attrs;
}

function scoreVariant(item) {
    return Number(item.height || 0) * 1000000 + Number(item.bandwidth || 0);
}

function scoreAudio(item) {
    return Number(item.bandwidth || 0);
}

export function parseHlsMasterPlaylist({ manifestUrl, manifestText, selectVideo = 'best', selectAudio = 'best' }) {
    const lines = String(manifestText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const variants = [];
    const audios = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
            const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : '';
            if (!uri) {
                continue;
            }

            const resolution = String(attrs.RESOLUTION || '').match(/^(\d+)x(\d+)$/i);
            variants.push({
                id: attrs.NAME || attrs.BANDWIDTH || `variant-${variants.length + 1}`,
                uri: resolveUrl(manifestUrl, uri),
                bandwidth: Number(attrs.BANDWIDTH || 0),
                codecs: attrs.CODECS || '',
                audioGroupId: attrs.AUDIO || '',
                width: resolution ? Number(resolution[1]) : 0,
                height: resolution ? Number(resolution[2]) : 0,
                language: ''
            });
            i += 1;
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA:')) {
            const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
            if (String(attrs.TYPE).toUpperCase() !== 'AUDIO') {
                continue;
            }

            if (!attrs.URI) {
                continue;
            }

            audios.push({
                id: attrs.NAME || attrs.LANGUAGE || `audio-${audios.length + 1}`,
                uri: resolveUrl(manifestUrl, attrs.URI),
                lang: attrs.LANGUAGE || '',
                language: attrs.LANGUAGE || '',
                groupId: attrs['GROUP-ID'] || '',
                name: attrs.NAME || '',
                bandwidth: 0,
                codecs: ''
            });
        }
    }

    if (!variants.length) {
        throw new Error('No HLS variants found in master playlist');
    }

    const videoSelector = parseSelectionExpression(selectVideo);
    const filteredVariants = applySelectorFilters(variants, videoSelector);
    const variantPool = filteredVariants.length ? filteredVariants : variants;
    const selectedVariant = selectItemsByMode(variantPool, videoSelector, scoreVariant)[0];

    const audioSelector = parseSelectionExpression(selectAudio);
    const matchingAudios = audios.filter((track) => {
        if (!selectedVariant.audioGroupId) {
            return true;
        }
        return track.groupId === selectedVariant.audioGroupId;
    });
    const filteredAudios = applySelectorFilters(matchingAudios, audioSelector);
    const audioPool = filteredAudios.length ? filteredAudios : matchingAudios;
    const selectedAudio = audioPool.length ? selectItemsByMode(audioPool, audioSelector, scoreAudio)[0] : null;

    return {
        type: 'master',
        variants,
        audios,
        selected: {
            video: selectedVariant,
            audio: selectedAudio
        }
    };
}

export function parseHlsMediaPlaylist({ manifestUrl, manifestText }) {
    const lines = String(manifestText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const segments = [];
    let initializationUrl = null;
    let currentKey = null;

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
            if (attrs.URI) {
                initializationUrl = resolveUrl(manifestUrl, attrs.URI);
            }
            continue;
        }

        if (line.startsWith('#EXT-X-KEY:')) {
            currentKey = parseAttributes(line.slice('#EXT-X-KEY:'.length));
            continue;
        }

        if (line.startsWith('#')) {
            continue;
        }

        segments.push({
            url: resolveUrl(manifestUrl, line),
            key: currentKey
        });
    }

    if (!segments.length) {
        throw new Error('No HLS segments found in media playlist');
    }

    return {
        type: 'media',
        initializationUrl,
        segments
    };
}

export default {
    parseHlsMasterPlaylist,
    parseHlsMediaPlaylist
};