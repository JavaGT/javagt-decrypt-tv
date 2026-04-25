/**
 * TVNZ Session Extraction Utility
 *
 * Helps users extract their TVNZ credentials from a browser session for use with this library.
 *
 * EXTRACTION METHODS:
 *
 * 1. Browser DevTools (Recommended)
 *    - Open https://www.tvnz.co.nz
 *    - Login with your email + OTP
 *    - Open DevTools (F12) → Application tab → Local Storage / Session Storage
 *    - Extract the required values (see below)
 *
 * 2. cookie-export Extension
 *    - Install cookie-export extension in your browser
 *    - Navigate to TVNZ and login
 *    - Export cookies in JSON format
 *
 * 3. HAR File Analysis
 *    - Use browser DevTools Network tab to capture HAR
 *    - Look for requests to evergentpd.com with Authorization headers
 *
 * REQUIRED STORAGE VALUES:
 *
 * Local Storage:
 *   - accessToken      : Evergent JWT access token (from /tvnz/confirmOTP)
 *   - refreshToken     : Evergent refresh token (long-lived)
 *   - deviceId        : Device UUID (generated on first login)
 *   - contactId        : User's contact ID from Evergent response
 *   - customerId       : Customer ID from Evergent response
 *
 * Session Storage:
 *   - edgeApiToken     : Edge API OAuth2 token (from /oauth2/token)
 *
 * Cookies:
 *   - Various TVNZ session cookies (for direct API access)
 *
 * CREDENTIALS FORMAT FOR LIBRARY:
 *
 * Option A: Full tokens
 *   Set environment variables or pass to library:
 *   TVNZ_ACCESS_TOKEN=<jwt>
 *   TVNZ_REFRESH_TOKEN=<token>
 *   TVNZ_EDGE_API_TOKEN=<token>
 *   TVNZ_DEVICE_ID=<uuid>
 *   TVNZ_CONTACT_ID=<id>
 *   TVNZ_CUSTOMER_ID=<id>
 *
 * Option B: JSON export file
 *   Create a JSON file with the above values and pass the file path
 *
 * Option C: Cookie export
 *   Export cookies in Netscape format and convert to header
 */

import fs from 'fs';
import path from 'path';

/**
 * Storage keys that TVNZ uses in browser localStorage/sessionStorage
 */
export const TVNZ_STORAGE_KEYS = {
    LOCAL: [
        'accessToken',
        'refreshToken',
        'deviceId',
        'contactId',
        'customerId',
        'profileId',
        'email',
        'oAuthToken',
        'itbl_auth_token',
        'deviceref'
    ],
    SESSION: [
        'edgeApiToken',
        'edgeApiTokenExpiry',
        'xAuthToken'
    ]
};

/**
 * Parse a TVNZ storage export JSON file (from browser DevTools Application > Storage)
 * @param {string} filePath - Path to the exported JSON file
 * @returns {Object} Parsed credentials object
 */
export function parseStorageExport(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const storage = JSON.parse(raw);

    const credentials = {
        accessToken: null,
        refreshToken: null,
        edgeApiToken: null,
        deviceId: null,
        contactId: null,
        customerId: null,
        profileId: null
    };

    // Handle both array format (from browser export) and object format
    if (Array.isArray(storage)) {
        for (const item of storage) {
            if (item.key && TVNZ_STORAGE_KEYS.LOCAL.includes(item.key)) {
                credentials[item.key] = item.value;
            }
        }
    } else if (typeof storage === 'object') {
        // Direct key-value format
        for (const [key, value] of Object.entries(storage)) {
            if (TVNZ_STORAGE_KEYS.LOCAL.includes(key) || TVNZ_STORAGE_KEYS.SESSION.includes(key)) {
                credentials[key] = value;
            }
        }
    }

    return credentials;
}

/**
 * Parse cookies from a cookie export file (Netscape or JSON format)
 * @param {string} filePath - Path to the cookie file
 * @returns {string} Cookie header string
 */
export function parseCookieExport(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n');

    // Check if JSON format
    if (raw.trim().startsWith('[')) {
        const cookies = JSON.parse(raw);
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    // Netscape format (first line is header, subsequent lines are cookies)
    const cookieParts = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length >= 6 && parts[0] !== 'localhost') {
            cookieParts.push(`${parts[5]}=${parts[6]}`);
        }
    }
    return cookieParts.join('; ');
}

/**
 * Validate that required credentials are present
 * @param {Object} credentials - Credentials object
 * @returns {Object} { valid: boolean, missing: string[], warnings: string[] }
 */
export function validateCredentials(credentials) {
    const missing = [];
    const warnings = [];

    if (!credentials.accessToken && !credentials.refreshToken) {
        missing.push('accessToken or refreshToken');
    }

    if (!credentials.deviceId) {
        warnings.push('deviceId - will be auto-generated');
    }

    if (!credentials.contactId) {
        warnings.push('contactId - may be needed for some API calls');
    }

    if (!credentials.edgeApiToken) {
        warnings.push('edgeApiToken - will use client credentials flow if missing');
    }

    return { valid: missing.length === 0, missing, warnings };
}

/**
 * Load credentials from environment variables
 * @returns {Object} Credentials from env vars
 */
export function loadFromEnv() {
    return {
        accessToken: process.env.TVNZ_ACCESS_TOKEN || null,
        refreshToken: process.env.TVNZ_REFRESH_TOKEN || null,
        edgeApiToken: process.env.TVNZ_EDGE_API_TOKEN || null,
        xAuthToken: process.env.TVNZ_X_AUTH_TOKEN || null,
        deviceId: process.env.TVNZ_DEVICE_ID || null,
        contactId: process.env.TVNZ_CONTACT_ID || null,
        customerId: process.env.TVNZ_CUSTOMER_ID || null,
        profileId: process.env.TVNZ_PROFILE_ID || null
    };
}

/**
 * Save credentials to a JSON file for later use
 * @param {string} filePath - Path to save credentials
 * @param {Object} credentials - Credentials to save
 */
export function saveCredentials(filePath, credentials) {
    fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2));
}

/**
 * Load credentials from a JSON file
 * @param {string} filePath - Path to credentials file
 * @returns {Object} Loaded credentials
 */
export function loadCredentials(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Find the most recent TVNZ session JSON file in a directory
 * @param {string} dirPath - Directory to search (defaults to ./downloads)
 * @returns {string|null} Path to most recent session file, or null if none found
 */
export function findMostRecentSessionFile(dirPath = './downloads') {
    if (!fs.existsSync(dirPath)) {
        return null;
    }

    let mostRecent = null;
    let mostRecentTime = 0;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        // Match tvnz-session*.json (from bookmarklet) or *tvnz*.json (general)
        if (!name.startsWith('tvnz-session') && !name.includes('tvnz')) continue;
        if (!name.endsWith('.json')) continue;

        const fullPath = path.join(dirPath, name);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > mostRecentTime) {
            mostRecentTime = stat.mtimeMs;
            mostRecent = fullPath;
        }
    }

    return mostRecent;
}

/**
 * Generate a new device ID (UUID v4)
 * @returns {string} UUID
 */
export function generateDeviceId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export default {
    TVNZ_STORAGE_KEYS,
    parseStorageExport,
    parseCookieExport,
    validateCredentials,
    loadFromEnv,
    saveCredentials,
    loadCredentials,
    generateDeviceId,
    findMostRecentSessionFile
};
