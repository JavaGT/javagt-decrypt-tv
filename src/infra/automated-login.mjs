/**
 * Automated email-code login for the TVNZ downloader.
 *
 * Uses tvnz-plus-api's verified OTP flow: reCAPTCHA token (explicit env/file
 * token or automatic Playwright mint) → createOTP → the code
 * arrives in the self-hosted Postfix mailbox (~/Mail) → extracted → confirmOTP
 * → a session identical to what the old bookmarklet export produced.
 *
 * Returns the session in the downloader's credential shape and (optionally)
 * persists it as a tvnz-session JSON that runTvnzWorkflow auto-detects.
 */

import { mintCaptchaTokenVerbose, TvnzClient } from 'tvnz-plus-api';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { persistSessionFile } from './tvnz-session.mjs';

const CAPTCHA_MAX_AGE_MS = 90_000;

function hasFreshCaptchaFile() {
    const filePath = path.join(homedir(), '.tvnz-captcha');
    try {
        return existsSync(filePath) && Date.now() - statSync(filePath).mtimeMs < CAPTCHA_MAX_AGE_MS;
    } catch {
        return false;
    }
}

async function resolveCaptcha(captcha) {
    if (captcha) return captcha;
    if (process.env.TVNZ_CAPTCHA_TOKEN?.trim() || hasFreshCaptchaFile()) return { name: 'auto' };

    // tvnz-login performs this same step. Keep it in-process here so the
    // library/module API can recover without putting tokens in argv/stdout.
    const token = await mintCaptchaTokenVerbose({ channel: 'chrome' });
    if (!token) throw new Error('Could not mint a TVNZ reCAPTCHA token');
    return { name: 'static', token };
}

/**
 * @param {Object} opts
 * @param {string} opts.email - TVNZ+ account email (any @*.javagrant.ac.nz address)
 * @param {string} [opts.sessionPath] - write a session JSON here when set
 * @param {Object} [opts.captcha] - SDK captcha selection (default: auto-mint or auto token)
 * @param {(e: import('tvnz-plus-api').OtpProgressEvent) => void} [opts.onProgress]
 * @returns {Promise<{accessToken: string, refreshToken: string, deviceref: string, contactId?: string}>}
 */
export async function automatedEmailLogin({ email, sessionPath, captcha, onProgress } = {}) {
    if (!email) {
        throw new Error('automatedEmailLogin requires an email address');
    }

    const client = new TvnzClient();
    const captchaSelection = await resolveCaptcha(captcha);
    const result = await client
        .otpLogin({
            email,
            captcha: captchaSelection,
            onProgress,
        })
        .run();

    const session = {
        accessToken: result.session.accessToken,
        refreshToken: result.session.refreshToken,
        deviceref: result.session.deviceref,
        contactId: result.contactId,
    };

    if (sessionPath) {
        persistSessionFile(sessionPath, session);
    }

    return session;
}

export default { automatedEmailLogin };
