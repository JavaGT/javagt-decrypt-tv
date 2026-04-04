import fs from 'fs';
import { spawnSync } from 'child_process';
import { fetchText } from '../../infra/http-client.mjs';

export async function fetchBuffer(url, { timeoutMs, retries, headers = {} }) {
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Failed to download ${url}: ${lastError?.message || 'unknown error'}`);
}

export function createRetryConfig({ timeoutMs, retries, headers = {} } = {}) {
    return {
        timeoutMs,
        retries,
        headers
    };
}

export async function fetchTextWithRetry(url, { timeoutMs, retries, headers = {} }) {
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            return await fetchText(url, { timeoutMs, headers });
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Failed to download text ${url}: ${lastError?.message || 'unknown error'}`);
}

export function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function toSafeName(name) {
    return String(name || 'output').replace(/[<>:"/\\|?*\x00-\x1F]/g, '.').replace(/\.{2,}/g, '.').replace(/^\./, '');
}

export async function runPool(items, concurrency, worker) {
    const pending = [...items];
    const runners = [];

    const runOne = async () => {
        while (pending.length) {
            const item = pending.shift();
            await worker(item);
        }
    };

    const size = Math.max(1, Math.min(concurrency, items.length));
    for (let i = 0; i < size; i += 1) {
        runners.push(runOne());
    }

    await Promise.all(runners);
}

export function resolveExecutable(candidate, fallback) {
    if (candidate) {
        return candidate;
    }
    return fallback;
}

export function runCommand(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) {
        throw new Error(`Failed to execute ${command}: ${result.error.message}`);
    }
    if (typeof result.status === 'number' && result.status !== 0) {
        throw new Error(`${command} exited with code ${result.status}`);
    }
}

export function mergeManifestQueryParams(targetUrl, manifestUrl) {
    const manifest = new URL(manifestUrl);
    if (!manifest.searchParams.size) {
        return targetUrl;
    }

    const target = new URL(targetUrl);
    for (const [key, value] of manifest.searchParams.entries()) {
        if (!target.searchParams.has(key)) {
            target.searchParams.set(key, value);
        }
    }
    return target.toString();
}

export function applyManifestQueryParams(track, manifestUrl) {
    if (!track) {
        return track;
    }

    const withQuery = { ...track };
    if (withQuery.initializationUrl) {
        withQuery.initializationUrl = mergeManifestQueryParams(withQuery.initializationUrl, manifestUrl);
    }

    if (Array.isArray(withQuery.segmentUrls)) {
        withQuery.segmentUrls = withQuery.segmentUrls.map((url) => mergeManifestQueryParams(url, manifestUrl));
    }

    if (Array.isArray(withQuery.segments)) {
        withQuery.segments = withQuery.segments.map((segment) => ({
            ...segment,
            url: mergeManifestQueryParams(segment.url, manifestUrl)
        }));
    }

    return withQuery;
}

export default {
    createRetryConfig,
    fetchBuffer,
    fetchTextWithRetry,
    ensureDir,
    toSafeName,
    runPool,
    resolveExecutable,
    runCommand,
    mergeManifestQueryParams,
    applyManifestQueryParams
};
