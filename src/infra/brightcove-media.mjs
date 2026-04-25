import { DOMParser } from 'xmldom';
import { Cdm } from '../pywidevine-node/Cdm.mjs';
import { Device } from '../pywidevine-node/Device.mjs';
import { PSSH } from '../pywidevine-node/Pssh.mjs';
import { createTimeoutSignal } from './http-client.mjs';

function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableError(error) {
    if (!error) {
        return false;
    }
    return error.name === 'AbortError' || error.name === 'TypeError';
}

async function fetchWithRetry(url, requestFactory, {
    retries = 3,
    baseDelayMs = 400
} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(url, requestFactory());
            if (response.ok || !isRetryableStatus(response.status) || attempt === retries) {
                return response;
            }
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
            continue;
        } catch (error) {
            lastError = error;
            if (!isRetryableError(error) || attempt === retries) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
        }
    }

    throw lastError || new Error(`Request failed for ${url}`);
}

function getTextContentByTagName(node, tagName) {
    const directChildren = Array.from(node.getElementsByTagName(tagName) || []);
    for (const child of directChildren) {
        if (child?.textContent?.trim()) {
            return child.textContent.trim();
        }
    }

    const wildcardChildren = Array.from(node.getElementsByTagName('*') || []);
    for (const child of wildcardChildren) {
        if ((child.localName || child.nodeName) === tagName && child.textContent && child.textContent.trim()) {
            return child.textContent.trim();
        }
    }

    return null;
}

function getAttributeAny(node, attributeNames) {
    for (const name of attributeNames) {
        const value = node.getAttribute?.(name);
        if (value) {
            return value;
        }
    }

    if (node.attributes) {
        for (const name of attributeNames) {
            const attr = node.attributes.getNamedItem?.(name);
            if (attr?.value) {
                return attr.value;
            }
        }
    }

    return null;
}

function createBrightcoveHeaders({ policyKey, origin, referer, userAgent }) {
    return {
        'BCOV-POLICY': policyKey,
        'User-Agent': userAgent,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: origin,
        Referer: referer
    };
}

export function selectPlaybackManifest(playbackInfo) {
    let dashSource = null;
    let hlsSource = null;

    for (const source of playbackInfo?.sources || []) {
        if (source?.type === 'application/dash+xml' && !String(source.src || '').includes('playready')) {
            dashSource = [
                source.src,
                source?.key_systems?.['com.widevine.alpha']?.license_url || null
            ];
        } else if (source?.type === 'application/x-mpegURL') {
            hlsSource = [source.src, null];
        }
    }

    if (dashSource) {
        return dashSource;
    }

    if (hlsSource) {
        return hlsSource;
    }

    throw new Error('Manifest URL not found in playback info');
}

export function extractManifestWidevineData(manifestText, manifestUrl) {
    if (!manifestText) {
        throw new Error('MPD content is empty or invalid');
    }

    const root = new DOMParser().parseFromString(manifestText, 'application/xml');
    const contentProtections = Array.from(root.getElementsByTagName('ContentProtection') || []);
    let pssh = null;
    let licenseUrl = null;

    for (const element of contentProtections) {
        const schemeIdUri = element.getAttribute('schemeIdUri')?.toLowerCase();
        if (schemeIdUri !== 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed') {
            continue;
        }

        pssh = getTextContentByTagName(element, 'pssh');
        licenseUrl = getAttributeAny(element, ['bc:licenseAcquisitionUrl', 'licenseAcquisitionUrl']);
        if (pssh && licenseUrl) {
            break;
        }
    }

    const representations = Array.from(root.getElementsByTagName('Representation') || []);
    let maxHeight = 0;
    for (const representation of representations) {
        const height = Number(representation.getAttribute('height') || 0);
        maxHeight = Math.max(maxHeight, height);
    }

    return {
        manifestUrl,
        pssh,
        licenseUrl,
        maxHeight,
        resolution: maxHeight >= 1080 ? '1080p' : maxHeight >= 720 ? '720p' : 'SD'
    };
}

export async function fetchBrightcovePlayback({
    videoId,
    accountId,
    policyKey,
    origin,
    referer,
    userAgent,
    retention,
    timeoutMs = 20000,
    apiBase = 'https://edge.api.brightcove.com'
}) {
    const playbackUrl = `${apiBase}/playback/v1/accounts/${accountId}/videos/${videoId}`;
    const response = await fetchWithRetry(playbackUrl, () => ({
        headers: createBrightcoveHeaders({ policyKey, origin, referer, userAgent }),
        signal: createTimeoutSignal(timeoutMs)
    }), {
        retries: 4,
        baseDelayMs: 500
    });

    const payload = await response.json();
    if (retention) {
        retention.writeJson('raw/brightcove_response.json', payload);
    }

    if (!response.ok) {
        throw new Error(`Brightcove playback request failed: [${response.status}] ${JSON.stringify(payload).slice(0, 300)}`);
    }

    return payload;
}

export async function fetchManifestWidevineData({ manifestUrl, retention, timeoutMs = 20000 }) {
    const response = await fetchWithRetry(manifestUrl, () => ({ signal: createTimeoutSignal(timeoutMs) }), {
        retries: 4,
        baseDelayMs: 500
    });
    const manifestText = await response.text();

    if (retention) {
        retention.writeText('raw/manifest.mpd', manifestText);
    }

    if (!response.ok) {
        throw new Error(`Manifest request failed: [${response.status}] ${manifestText.slice(0, 300)}`);
    }

    return extractManifestWidevineData(manifestText, manifestUrl);
}

export async function getWidevineKeys({
    pssh,
    licenseUrl,
    wvdDevicePath,
    origin,
    referer,
    userAgent,
    retention,
    timeoutMs = 20000,
    authorizationToken = null,
    accessToken = null
}) {
    const parsedPssh = new PSSH(pssh);
    const device = Device.load(wvdDevicePath);
    const cdm = Cdm.fromDevice(device);
    const sessionId = cdm.open();

    try {
        const challenge = cdm.getLicenseChallenge(sessionId, parsedPssh);
        if (retention) {
            retention.writeJson('parsed/license_challenge_summary.json', {
                challenge_bytes: challenge.length,
                license_url: licenseUrl,
                has_authorization_token: Boolean(authorizationToken)
            });
        }

        const headers = {
            Accept: '*/*',
            'Content-Type': 'application/octet-stream',
            'User-Agent': userAgent,
            Origin: origin,
            Referer: referer
        };

        // Add Authorization header with Bearer token if provided
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(licenseUrl, {
            method: 'POST',
            headers,
            body: challenge,
            signal: createTimeoutSignal(timeoutMs)
        });

        const licenseBytes = Buffer.from(await response.arrayBuffer());
        if (retention) {
            retention.writeJson('raw/license_response_headers.json', {
                status_code: response.status,
                headers: Object.fromEntries(response.headers.entries())
            });
            retention.writeText('raw/license_response.bin.b64', licenseBytes.toString('base64'));
        }

        if (!response.ok) {
            throw new Error(`License request failed: [${response.status}] ${licenseBytes.toString('utf8').slice(0, 400)}`);
        }

        cdm.parseLicense(sessionId, licenseBytes);
        const keys = cdm.getKeys(sessionId)
            .filter((key) => key.type === 'CONTENT')
            .map((key) => `${String(key.kid).replace(/-/g, '')}:${Buffer.from(key.key).toString('hex')}`);

        if (retention) {
            retention.writeJson('parsed/decryption_keys.json', {
                keys,
                key_count: keys.length,
                retrieved_at: new Date().toISOString()
            });
        }

        return keys;
    } finally {
        cdm.close(sessionId);
    }
}

export default {
    selectPlaybackManifest,
    extractManifestWidevineData,
    fetchBrightcovePlayback,
    fetchManifestWidevineData,
    getWidevineKeys
};