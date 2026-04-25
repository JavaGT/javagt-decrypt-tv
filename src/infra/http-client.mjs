const DEFAULT_TIMEOUT_MS = 15000;

function timeoutSignal(ms = DEFAULT_TIMEOUT_MS) {
    return AbortSignal.timeout(ms);
}

export async function fetchText(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        signal: options.signal || timeoutSignal(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${body.slice(0, 300)}`);
    }

    return response.text();
}

export async function fetchJson(url, options = {}) {
    return JSON.parse(await fetchText(url, options));
}

export async function postFormEncoded(url, body, options = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(options.headers || {})
        },
        body: new URLSearchParams(body).toString(),
        signal: options.signal || timeoutSignal(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    });

    if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${bodyText.slice(0, 300)}`);
    }

    return response.json();
}

export function createTimeoutSignal(ms = DEFAULT_TIMEOUT_MS) {
    return timeoutSignal(ms);
}

export default {
    fetchText,
    fetchJson,
    postFormEncoded,
    createTimeoutSignal
};
