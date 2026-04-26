/**
 * TVNZ Authentication Module
 *
 * Implements the Evergent OTP authentication flow used by TVNZ:
 * 1. searchAccountV2 - Check if account exists for email
 * 2. createOTP - Send one-time password to email
 * 3. confirmOTP - Verify OTP and receive access/refresh tokens
 *
 * Also includes Edge API OAuth2 client credentials flow.
 */

import crypto from 'crypto';
import { fetchJson, fetchText, postFormEncoded, createTimeoutSignal } from './http-client.mjs';
import { generateDeviceId } from './tvnz-session.mjs';

// Evergent API configuration
const EVERGENT_BASE = 'https://rest-prod-tvnz.evergentpd.com/tvnz';
const EVERGENT_API_USER = 'qpapiuser';
const EVERGENT_API_PASSWORD = 'Tv9z@pi2026$';
const CHANNEL_PARTNER_ID = 'TVNZ_NZ';

// Edge API configuration
const EDGE_API_BASE = 'https://watch-cdn.edge-api.tvnz.co.nz';
const EDGE_CLIENT_ID = 'webclient-ui-app';
const EDGE_CLIENT_SECRET = 'f99d00b8-5b20-4c27-983d-d2895f3e9fec';

// VOD Origin configuration
const VOD_ORIGIN_BASE = 'https://vod-origin-cdn.cms-api.tvnz.co.nz';

/**
 * Build common Evergent request headers
 * @param {string} accessToken - Optional access token for authenticated requests
 * @returns {Object} Headers object
 */
function evergentHeaders(accessToken = null) {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return headers;
}

/**
 * Build Evergent request body with common fields
 * @param {Object} additionalFields - Additional fields to include
 * @returns {Object} Request body
 */
function evergentRequestBody(additionalFields = {}) {
    return {
        ...additionalFields,
        channelPartnerID: CHANNEL_PARTNER_ID,
        apiUser: EVERGENT_API_USER,
        apiPassword: EVERGENT_API_PASSWORD
    };
}

/**
 * Search for an existing TVNZ account by email
 *
 * @param {string} email - Email address to search
 * @returns {Promise<{exists: boolean, response: Object}>}
 */
export async function searchAccount(email) {
    const url = `${EVERGENT_BASE}/searchAccountV2`;
    const body = evergentRequestBody({
        searchAccountV2RequestMessage: {
            email
        }
    });

    const data = await fetchJson(url, {
        method: 'POST',
        headers: evergentHeaders(),
        body: JSON.stringify(body),
        signal: createTimeoutSignal()
    });

    const response = data.searchAccountResponseMessage || data;
    return {
        exists: response.accountExists === true || response.responseCode === '1',
        response
    };
}

/**
 * Create (send) an OTP to the user's email
 *
 * @param {string} email - Email address
 * @param {string} recaptchaToken - Optional reCAPTCHA token
 * @returns {Promise<{sent: boolean, response: Object}>}
 */
export async function createOTP(email, recaptchaToken = null) {
    const url = `${EVERGENT_BASE}/createOTP`;
    const requestMessage = {
        email,
        sendEmail: true
    };

    if (recaptchaToken) {
        requestMessage.recaptchaToken = recaptchaToken;
    }

    const body = {
        createOTPRequestMessage: evergentRequestBody(requestMessage)
    };

    const data = await fetchJson(url, {
        method: 'POST',
        headers: evergentHeaders(),
        body: JSON.stringify(body),
        signal: createTimeoutSignal()
    });

    const response = data.createOTPResponseMessage || data;
    return {
        sent: response.otpSent === true || response.responseCode === '1',
        response
    };
}

/**
 * Confirm (verify) an OTP and receive access/refresh tokens
 *
 * @param {string} email - Email address
 * @param {string} otp - One-time password
 * @param {Object} options - Options
 * @param {string} options.deviceId - Device UUID (auto-generated if not provided)
 * @param {string} options.deviceName - Device name (default: "Chrome browser on macOS")
 * @param {string} options.accessToken - Existing access token (for refresh flow)
 * @param {string} options.refreshToken - Existing refresh token (for refresh flow)
 * @returns {Promise<Object>} Token response with accessToken, refreshToken, contactID, customerID, expiresAt
 */
export async function confirmOTP(email, otp, options = {}) {
    const url = `${EVERGENT_BASE}/confirmOTP`;
    const deviceId = options.deviceId || generateDeviceId();

    const deviceDetails = {
        deviceType: 'web',
        deviceName: options.deviceName || 'Chrome browser on macOS',
        modelNo: 'Chrome',
        appType: 'web',
        serialNo: deviceId,
        userAgent: 'NZ'
    };

    // If refreshing, use refreshToken instead of OTP
    const isRefresh = Boolean(options.refreshToken && !otp);

    const requestMessage = {
        country: 'NZ',
        email,
        canCreateAccount: false,
        deviceDetails,
        isGenerateJWT: true
    };

    if (isRefresh) {
        requestMessage.refreshToken = options.refreshToken;
    } else {
        requestMessage.otp = otp;
    }

    const body = {
        ConfirmOTPRequestMessage: evergentRequestBody(requestMessage)
    };

    const data = await fetchJson(url, {
        method: 'POST',
        headers: evergentHeaders(options.accessToken),
        body: JSON.stringify(body),
        signal: createTimeoutSignal()
    });

    const response = data.ConfirmOTPResponseMessage || data;

    if (response.responseCode !== '1' && response.responseCode !== 1) {
        throw new Error(`OTP confirm failed: ${response.message || response.responseCode}`);
    }

    // Extract tokens from params array
    const params = Array.isArray(response.params) ? response.params : [];
    const getParam = (name) => params.find(p => p.paramName === name)?.paramValue;

    return {
        accessToken: getParam('accessToken'),
        refreshToken: getParam('refreshToken'),
        expiresAt: getParam('expiresIn') ? Number(getParam('expiresIn')) : null,
        contactID: response.contactID,
        customerID: response.cpCustomerID,
        email: response.email,
        deviceId,
        response
    };
}

/**
 * Get Edge API OAuth2 token using client credentials flow
 *
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
export async function getEdgeApiToken() {
    const data = await postFormEncoded(
        `${EDGE_API_BASE}/oauth2/token`,
        {
            grant_type: 'client_credentials',
            client_id: EDGE_CLIENT_ID,
            client_secret: EDGE_CLIENT_SECRET,
            audience: 'edge-service',
            scope: 'offline openid'
        }
    );

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in
    };
}

/**
 * Generate a device token JWT for playback authorization
 * This is a JWT signed with HMAC-SHA256 using the device secret
 *
 * @param {string} deviceId - Device UUID
 * @param {string} deviceSecret - Device secret from registration
 * @param {number} expiresIn - Token expiry time in seconds (default 30)
 * @returns {string} JWT device token
 */
export function generateDeviceTokenJwt(deviceId, deviceSecret, expiresIn = 30) {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + expiresIn;

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        deviceId,
        aud: 'playback-auth-service',
        iat: now,
        exp: expiry
    };

    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signingInput = `${base64Header}.${base64Payload}`;
    // Device secret is stored as base64 encoded - decode before using as HMAC key
    const decodedSecret = Buffer.from(deviceSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', decodedSecret)
        .update(signingInput)
        .digest('base64url');

    return `${base64Header}.${base64Payload}.${signature}`;
}

/**
 * Register a device with the Edge API
 *
 * @param {string} deviceId - Device UUID
 * @param {string} edgeApiToken - Edge API access token
 * @param {string} xAuthToken - X-Authorization token (optional, for existing devices)
 * @returns {Promise<{secret: string, deviceId: string}>}
 */
export async function registerDevice(deviceId, edgeApiToken, xAuthToken = null) {
    const headers = {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Authorization': `Bearer ${edgeApiToken}`,
        'x-client-id': 'tvnz-tvnz-web'
    };
    if (xAuthToken) {
        headers['x-authorization'] = xAuthToken;
    }
    const data = await fetchJson(
        `${EDGE_API_BASE}/device/app/register`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({ uniqueId: deviceId }),
            signal: createTimeoutSignal()
        }
    );

    if (!data.data?.secret) {
        throw new Error(`Device registration failed: no secret returned. Response: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return {
        secret: data.data.secret,
        deviceId: data.data.deviceId
    };
}

/**
 * Full OTP authentication flow: search -> createOTP -> confirmOTP
 *
 * @param {string} email - Email address
 * @param {string} otp - One-time password
 * @param {Object} options - Options (passed to confirmOTP)
 * @returns {Promise<Object>} Complete auth result with all tokens
 */
export async function authenticateWithOTP(email, otp, options = {}) {
    // Step 1: Search for account
    const searchResult = await searchAccount(email);

    // Step 2: Create OTP
    const createResult = await createOTP(email);

    if (!createResult.sent) {
        throw new Error('Failed to send OTP - email may not be registered');
    }

    // Step 3: Confirm OTP
    const confirmResult = await confirmOTP(email, otp, options);

    // Step 4: Get Edge API token
    const edgeResult = await getEdgeApiToken();

    return {
        search: searchResult,
        create: createResult,
        auth: confirmResult,
        edge: edgeResult,
        deviceId: confirmResult.deviceId
    };
}

/**
 * Refresh an expired access token using refresh token
 *
 * @param {string} refreshToken - The refresh token
 * @param {string} email - Email address (needed for Evergent)
 * @param {Object} options - Options
 * @returns {Promise<Object>} New token response
 */
export async function refreshAccessToken(refreshToken, email, options = {}) {
    return confirmOTP(email, null, {
        ...options,
        refreshToken,
        accessToken: options.accessToken
    });
}

/**
 * Validate that credentials are present and not expired
 *
 * @param {Object} credentials - Credentials object
 * @returns {Object} { valid: boolean, expired: boolean, missing: string[] }
 */
export function validateAuthCredentials(credentials) {
    const missing = [];
    const expired = false;

    if (!credentials.accessToken && !credentials.refreshToken) {
        missing.push('accessToken or refreshToken');
    }

    if (credentials.accessToken && credentials.expiresAt) {
        // Check if token is expired (with 5 minute buffer)
        const bufferMs = 5 * 60 * 1000;
        if (Date.now() > credentials.expiresAt - bufferMs) {
            return { valid: true, expired: true, missing: [] };
        }
    }

    return { valid: missing.length === 0, expired, missing };
}

/**
 * Create SSAI session to resolve ad placeholders in manifest URLs
 * This POSTs to the mtSessionUrl to get a clean manifest without ~placeholder~ values
 *
 * @param {string} mtSessionUrl - The session manifest URL from authorization
 * @param {Object} playerParams - Player parameters from authorization response
 * @param {Object} options - Options including headers
 * @returns {Promise<string>} Resolved manifest URL with placeholders filled in
 */
export async function createSsaiSession(mtSessionUrl, playerParams, options = {}) {
    // The mtSessionUrl IS the session endpoint - POST to it directly with playerParams
    const url = mtSessionUrl;

    const payload = {
        playerParams: playerParams || {}
    };

    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    const startTime = Date.now();
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: createTimeoutSignal(options.timeoutMs || 20000)
    });

    // Log to HAR if enabled
    if (this.httpClient?.logHarResponse) {
        await this.httpClient.logHarResponse(
            response,
            url,
            'POST',
            headers,
            JSON.stringify(payload),
            startTime
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SSAI session creation failed: [${response.status}] ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    let resolvedUrl = data.manifestUrl || data.data?.manifestUrl;
    // SSAI session returns a relative URL - prepend VOD_ORIGIN_BASE
    if (resolvedUrl && resolvedUrl.startsWith('/')) {
        resolvedUrl = VOD_ORIGIN_BASE + resolvedUrl;
    }
    console.log(`[DEBUG] SSAI session raw response: ${JSON.stringify(data).slice(0, 500)}`);
    console.log(`[DEBUG] SSAI resolved URL: ${resolvedUrl}`);
    return resolvedUrl;
}

export default {
    searchAccount,
    createOTP,
    confirmOTP,
    getEdgeApiToken,
    registerDevice,
    authenticateWithOTP,
    refreshAccessToken,
    validateAuthCredentials
};
