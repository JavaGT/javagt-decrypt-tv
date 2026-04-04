export function translateFormatExpression(formatExpression) {
    const value = String(formatExpression || '').trim();
    if (!value) {
        return null;
    }

    const primary = value.toLowerCase().split('/')[0].trim();
    const parts = primary.split('+').map((part) => part.trim()).filter(Boolean);

    const formatFiltersFromBracket = (selector, bracketText) => {
        const filters = [];
        const rawFilters = bracketText.replace(/^\[|\]$/g, '').split(/[,:]/).map((item) => item.trim()).filter(Boolean);
        for (const filter of rawFilters) {
            const match = filter.match(/^([a-zA-Z]+)\s*(=)\s*(.+)$/);
            if (!match) {
                continue;
            }

            const [, key, , rawValue] = match;
            const cleanValue = rawValue.replace(/^['"]|['"]$/g, '');
            if (key === 'lang' || key === 'codecs' || key === 'id' || key === 'res' || key === 'resolution' || key === 'bwMin' || key === 'bwMax') {
                filters.push(`${key === 'resolution' ? 'res' : key}=${cleanValue}`);
            }
        }
        return filters.length ? `${selector}:${filters.join(':')}` : selector;
    };

    const parseFormatTerm = (term) => {
        const brackets = [...term.matchAll(/\[[^\]]+\]/g)].map((match) => match[0]);
        const base = term.replace(/\[[^\]]+\]/g, '').trim().toLowerCase();

        let selector = null;
        if (base === 'best' || base === 'bestvideo' || base === 'bv' || base === 'bv*') {
            selector = { stream: 'video', value: 'best' };
        } else if (base === 'worst' || base === 'worstvideo') {
            selector = { stream: 'video', value: 'worst' };
        } else if (base === 'bestaudio' || base === 'ba' || base === 'ba*') {
            selector = { stream: 'audio', value: 'best' };
        } else if (base === 'worstaudio') {
            selector = { stream: 'audio', value: 'worst' };
        } else if (base === 'all') {
            selector = { stream: 'all', value: 'all' };
        }

        if (!selector) {
            return null;
        }

        let termValue = selector.value;
        for (const bracket of brackets) {
            termValue = formatFiltersFromBracket(termValue, bracket);
        }

        return { ...selector, value: termValue };
    };

    const selection = {
        selectVideo: 'best',
        selectAudio: 'best',
        selectSubtitle: 'all'
    };

    let sawTerm = false;
    for (const part of parts) {
        const parsed = parseFormatTerm(part);
        if (!parsed) {
            continue;
        }
        sawTerm = true;

        if (parsed.stream === 'all') {
            selection.selectVideo = 'all';
            selection.selectAudio = 'all';
            selection.selectSubtitle = 'all';
            continue;
        }

        if (parsed.stream === 'video') {
            selection.selectVideo = parsed.value;
            selection.selectSubtitle = 'all';
            continue;
        }

        if (parsed.stream === 'audio') {
            selection.selectAudio = parsed.value;
            selection.selectSubtitle = 'none';
        }
    }

    if (sawTerm) {
        if (selection.selectVideo === 'best' && !parts.some((part) => /^(bestvideo|bv|bv\*)/i.test(part))) {
            selection.selectVideo = 'none';
        }
        if (selection.selectAudio === 'best' && !parts.some((part) => /^(bestaudio|ba|ba\*)/i.test(part))) {
            selection.selectAudio = 'none';
        }
        return selection;
    }

    if (primary.includes('[')) {
        return { selectVideo: primary, selectAudio: 'none', selectSubtitle: 'none' };
    }

    return null;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function sanitizeForJson(value, seen = new WeakSet()) {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof URL) {
        return value.toString();
    }

    if (value instanceof Map) {
        return Object.fromEntries(Array.from(value.entries()).map(([key, entryValue]) => [key, sanitizeForJson(entryValue, seen)]));
    }

    if (value instanceof Set) {
        return Array.from(value.values()).map((entryValue) => sanitizeForJson(entryValue, seen));
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return undefined;
        }
        seen.add(value);
        const output = value.map((entryValue) => sanitizeForJson(entryValue, seen));
        seen.delete(value);
        return output;
    }

    if (seen.has(value)) {
        return undefined;
    }

    if (!isPlainObject(value)) {
        return `[${value.constructor?.name || 'Object'}]`;
    }

    seen.add(value);
    const output = {};
    for (const [key, entryValue] of Object.entries(value)) {
        const sanitized = sanitizeForJson(entryValue, seen);
        if (sanitized !== undefined) {
            output[key] = sanitized;
        }
    }
    seen.delete(value);
    return output;
}

export function safeStem(value) {
    return String(value || 'output').replace(/[<>:"/\\|?*\x00-\x1F]/g, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '') || 'output';
}

export function normalizeOptions(rawOptions = {}) {
    const options = { ...rawOptions };
    const formatSelectors = translateFormatExpression(options.format);

    return {
        ...options,
        selectVideo: formatSelectors?.selectVideo || options.selectVideo || 'best',
        selectAudio: formatSelectors?.selectAudio || options.selectAudio || 'best',
        selectSubtitle: formatSelectors?.selectSubtitle || options.selectSubtitle || 'all',
        noMtime: Boolean(options.noMtime)
    };
}
