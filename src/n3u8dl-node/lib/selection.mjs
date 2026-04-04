function wildcardToRegex(pattern) {
    const escaped = String(pattern)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

function parseMode(modeValue) {
    if (!modeValue) {
        return { mode: 'best', count: 1 };
    }

    const normalized = String(modeValue).trim().toLowerCase();
    const bestMatch = normalized.match(/^best(\d+)?$/);
    if (bestMatch) {
        return { mode: 'best', count: Number(bestMatch[1] || 1) };
    }

    const worstMatch = normalized.match(/^worst(\d+)?$/);
    if (worstMatch) {
        return { mode: 'worst', count: Number(worstMatch[1] || 1) };
    }

    if (normalized === 'all') {
        return { mode: 'all', count: Number.MAX_SAFE_INTEGER };
    }

    return { mode: 'best', count: 1 };
}

function splitSelectorParts(rawSelector) {
    const text = String(rawSelector || '').trim();
    if (!text) {
        return [];
    }

    const parts = [];
    let current = '';
    let quote = null;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if ((ch === '"' || ch === "'") && (i === 0 || text[i - 1] !== '\\')) {
            quote = quote === ch ? null : ch;
            current += ch;
            continue;
        }

        if (ch === ':' && !quote) {
            parts.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        parts.push(current.trim());
    }

    return parts;
}

function stripWrappingQuotes(value) {
    const text = String(value || '').trim();
    if (!text) {
        return text;
    }

    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return text.slice(1, -1);
    }
    return text;
}

export function parseSelectionExpression(rawSelector) {
    const selector = {
        raw: String(rawSelector || ''),
        mode: 'best',
        count: 1,
        filters: {}
    };

    const parts = splitSelectorParts(rawSelector);
    if (!parts.length) {
        return selector;
    }

    if (!parts[0].includes('=')) {
        const parsedMode = parseMode(parts[0]);
        selector.mode = parsedMode.mode;
        selector.count = parsedMode.count;
        parts.shift();
    }

    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx < 1) {
            continue;
        }

        const key = part.slice(0, idx).trim();
        const value = stripWrappingQuotes(part.slice(idx + 1));

        if (key === 'for') {
            const parsedMode = parseMode(value);
            selector.mode = parsedMode.mode;
            selector.count = parsedMode.count;
            continue;
        }

        selector.filters[key] = value;
    }

    return selector;
}

function matchRegexLike(target, regexLike) {
    if (!regexLike) {
        return true;
    }
    try {
        const pattern = new RegExp(regexLike, 'i');
        return pattern.test(String(target || ''));
    } catch {
        return wildcardToRegex(regexLike).test(String(target || ''));
    }
}

function normalizeResolutionValue(item) {
    const width = Number(item.width || 0);
    const height = Number(item.height || 0);
    if (width && height) {
        return `${width}x${height}`;
    }
    if (height) {
        return `${height}p`;
    }
    return '';
}

export function applySelectorFilters(items, selector) {
    const { filters } = selector;
    return items.filter((item) => {
        if (filters.id && !matchRegexLike(item.id, filters.id)) {
            return false;
        }
        if (filters.lang && !matchRegexLike(item.language || item.lang, filters.lang)) {
            return false;
        }
        if (filters.codecs && !matchRegexLike(item.codecs, filters.codecs)) {
            return false;
        }
        if (filters.res && !matchRegexLike(normalizeResolutionValue(item), filters.res)) {
            return false;
        }

        const bw = Number(item.bandwidth || 0);
        if (filters.bwMin && bw < Number(filters.bwMin)) {
            return false;
        }
        if (filters.bwMax && bw > Number(filters.bwMax)) {
            return false;
        }

        return true;
    });
}

export function selectItemsByMode(items, selector, scoreFn) {
    if (!items.length) {
        return [];
    }

    const sorted = [...items].sort((a, b) => scoreFn(b) - scoreFn(a));

    if (selector.mode === 'all') {
        return sorted;
    }

    if (selector.mode === 'worst') {
        const reversed = [...sorted].reverse();
        return reversed.slice(0, Math.max(1, selector.count));
    }

    return sorted.slice(0, Math.max(1, selector.count));
}

export default {
    parseSelectionExpression,
    applySelectorFilters,
    selectItemsByMode
};