import fs from 'fs';
import { TvnzClient } from '@javagt/tvnz-plus-api';
import { MediaProvider } from '../contracts/provider.mjs';
import { extractManifestWidevineData, getWidevineKeys } from '../infra/brightcove-media.mjs';
import { buildDownloadPlan, executeDownloadPlan } from '../application/media-pipeline.mjs';
import { fetchText } from '../infra/http-client.mjs';
import { inspectManifestUrl } from '../n3u8dl-node/index.mjs';
import RetentionStore from '../infra/retention-store.mjs';
import { loadFromEnv, findMostRecentSessionFile } from '../infra/tvnz-session.mjs';
import { automatedEmailLogin } from '../infra/automated-login.mjs';

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36',
    Origin: 'https://www.tvnz.co.nz',
    Referer: 'https://www.tvnz.co.nz/'
};

function parseUrl(inputUrl) {
    const url = new URL(inputUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const show = url.pathname.match(/\/shows\/([^/]+)\/(episodes|movie)\/s(\d+)-e(\d+)/i);
    if (show) {
        return {
            kind: show[2].toLowerCase() === 'movie' ? 'movie' : 'episode',
            slug: `${show[1]}/${show[2]}/s${show[3]}-e${show[4]}`,
            series: show[1],
            contentTypeId: show[2].toLowerCase() === 'movie' ? 'movie' : 'vod',
            catalogType: show[2].toLowerCase() === 'movie' ? 'movie' : 'tvepisode'
        };
    }
    const player = url.pathname.match(/\/player\/([^/]+)\/([^/]+)/i);
    if (player) return { kind: 'player', contentTypeId: 'vod', catalogType: player[1], slug: player[2] };
    const sport = url.pathname.match(/\/sport\/[^/]+\/[^/]+\/([^/]+)/i);
    if (sport) return { kind: 'sport', contentTypeId: 'sport', catalogType: 'sport', contentId: sport[1] };
    throw new Error(`Could not parse TVNZ URL: ${inputUrl}`);
}

function credentialsFrom(context, auth) {
    const supplied = context.credentials;
    if (supplied) {
        if (typeof supplied === 'string' && fs.existsSync(supplied)) {
            return JSON.parse(fs.readFileSync(supplied, 'utf8'));
        }
        if (typeof supplied === 'string') {
            throw new Error(`TVNZ credentials file not found: ${supplied}. Pass --credentials with a path to a session JSON file, or use --email.`);
        }
        return supplied;
    }
    if (auth?.accessToken || auth?.refreshToken) return auth;
    const env = loadFromEnv();
    if (env.accessToken || env.refreshToken) return env;
    const file = process.env.TVNZ_SESSION_FILE || findMostRecentSessionFile();
    return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function buildPlaybackRequestHeaders(client) {
    return { ...REQUEST_HEADERS, ...(client.auth?.playbackHeaders?.() || {}) };
}

function setClientSession(client, credentials) {
    if (typeof credentials === 'object' && credentials.accessToken) {
        client.setSession({
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken || '',
            deviceref: credentials.deviceref || credentials.deviceId || '',
            ...(credentials.contactId ? { contactId: credentials.contactId } : {})
        });
    }
}

export async function resolvePlayback(client, inputUrl) {
    const parsed = parseUrl(inputUrl);
    let contentId = parsed.contentId;
    if (parsed.kind === 'episode') {
        const episode = await client.series.getEpisode(parsed.slug);
        contentId = episode?.slug || episode?.raw?.nu;
        if (!contentId) throw new Error(`TVNZ episode was not found: ${parsed.slug}`);
    } else if (parsed.kind === 'movie') {
        const movie = await client.series.getMovie(parsed.slug);
        contentId = movie?.slug || movie?.raw?.nu;
        if (!contentId) throw new Error(`TVNZ movie was not found: ${parsed.slug}`);
    } else if (parsed.kind === 'player') {
        const episode = await client.series.getEpisode(parsed.slug);
        contentId = episode?.slug || episode?.raw?.nu || parsed.slug;
    }
    return client.playback.authorize(contentId, parsed.contentTypeId, parsed.catalogType);
}

async function prepareMedia(client, playback, wvdDevicePath, options, retention) {
    const requestHeaders = buildPlaybackRequestHeaders(client);
    const mpdUrl = await client.playback.resolveManifest(playback, { headers: requestHeaders });
    const manifestText = await fetchText(mpdUrl, { timeoutMs: options.timeoutMs || 15000, headers: requestHeaders });
    const widevine = extractManifestWidevineData(manifestText, mpdUrl);
    if (!widevine.pssh) throw new Error('Failed to extract PSSH data from manifest');
    const keys = await getWidevineKeys({
        pssh: widevine.pssh,
        licenseUrl: playback.licenseUrl,
        wvdDevicePath,
        origin: REQUEST_HEADERS.Origin,
        referer: REQUEST_HEADERS.Referer,
        userAgent: REQUEST_HEADERS['User-Agent'],
        requestHeaders,
        retention
    });
    const resolution = widevine.resolution;
    return { mpdUrl, keys, resolution, requestHeaders };
}

export async function runTvnzWorkflow(inputUrl, context = {}) {
    const credentials = credentialsFrom(context, context.auth);
    let client = context.client || context.options?.client || new TvnzClient(credentials?.deviceId || credentials?.deviceref);
    if (typeof credentials === 'string') throw new Error('TVNZ email:OTP credentials require the automated login flow');
    const loginEmail = context.options?.email || process.env.TVNZ_EMAIL;
    if (loginEmail) {
        const session = await (context.emailLogin || automatedEmailLogin)({
            email: loginEmail,
            sessionPath: context.options.sessionPath
        });
        setClientSession(client, session);
    } else if (credentials) {
        setClientSession(client, credentials);
    } else {
        throw new Error('Missing TVNZ credentials. Provide session tokens or --email.');
    }
    const retention = context.retention || new RetentionStore(context.downloadsPath || './downloads', inputUrl, 'tvnz');
    const playback = await resolvePlayback(client, inputUrl);
    const media = await prepareMedia(client, playback, context.wvdDevicePath || './device.wvd', context.options || {}, retention);
    const plan = buildDownloadPlan({
        mpdUrl: media.mpdUrl,
        downloadsPath: context.downloadsPath || './downloads',
        saveName: context.options?.output || `content.${media.resolution}.TVNZ.WEB-DL.AAC2.0.H.264`,
        keys: media.keys,
        selectVideo: context.options?.selectVideo || 'best',
        selectAudio: context.options?.selectAudio || 'best',
        selectSubtitle: context.options?.selectSubtitle || 'all',
        requestHeaders: media.requestHeaders
    });
    await executeDownloadPlan(plan, { retention });
}

export class TvnzProvider extends MediaProvider {
    constructor({ clientFactory, emailLogin = automatedEmailLogin } = {}) { super(); this.auth = {}; this.clientFactory = clientFactory; this.emailLogin = emailLogin; }
    get id() { return 'tvnz'; }
    setAuth(auth = {}) { this.auth = { ...auth }; return this; }
    getAuth() { return { ...this.auth }; }
    supports(inputUrl) { return typeof inputUrl === 'string' && /tvnz\.co\.nz/i.test(inputUrl); }
    async execute(inputUrl, context = {}) {
        const client = context.client || this.clientFactory?.(context) || undefined;
        await runTvnzWorkflow(inputUrl, { ...context, auth: this.auth, emailLogin: this.emailLogin, ...(client ? { client } : {}) });
        return { provider: this.id, inputUrl, success: true, message: 'TVNZ workflow completed', artifacts: { downloadsPath: context.downloadsPath || './downloads', credentialsConfigured: Boolean(context.credentials || this.auth.accessToken || this.auth.refreshToken) } };
    }
    async inspect(inputUrl, context = {}) {
        const credentials = credentialsFrom(context, this.auth);
        const client = context.client || this.clientFactory?.(context) || new TvnzClient(credentials?.deviceId || credentials?.deviceref);
        const loginEmail = context.options?.email || process.env.TVNZ_EMAIL;
        if (loginEmail) {
            const session = await this.emailLogin({
                email: loginEmail,
                sessionPath: context.options.sessionPath
            });
            setClientSession(client, session);
        } else if (credentials) {
            setClientSession(client, credentials);
        } else {
            throw new Error('Missing TVNZ credentials. Provide session tokens or --email.');
        }
        const playback = await resolvePlayback(client, inputUrl);
        const headers = buildPlaybackRequestHeaders(client);
        const mpdUrl = await client.playback.resolveManifest(playback, { headers });
        const report = await inspectManifestUrl(mpdUrl, { timeoutMs: context.options?.timeoutMs || 15000, headers });
        return { ...report, provider: this.id, pageUrl: inputUrl, resolvedFromUrl: inputUrl, sourceManifestUrl: mpdUrl, status: report.status && report.status !== 'needs-resolution' ? report.status : 'ready' };
    }
}

export { parseUrl, credentialsFrom };
export default TvnzProvider;
