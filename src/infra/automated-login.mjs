/**
 * Automated email-code login for the TVNZ downloader.
 *
 * Uses tvnz-plus-api's verified OTP flow: Playwright-minted reCAPTCHA
 * token (env TVNZ_CAPTCHA_TOKEN or ~/.tvnz-captcha) → createOTP → the code
 * arrives in the self-hosted Postfix mailbox (~/Mail) → extracted → confirmOTP
 * → a session identical to what the old bookmarklet export produced.
 *
 * Returns the session in the downloader's credential shape and (optionally)
 * persists it as a tvnz-session JSON that runTvnzWorkflow auto-detects.
 */

import { TvnzClient } from 'tvnz-plus-api';
import fs from 'fs';
import path from 'path';

/**
 * @param {Object} opts
 * @param {string} opts.email - TVNZ+ account email (any @*.javagrant.ac.nz address)
 * @param {string} [opts.sessionPath] - write a session JSON here when set
 * @param {Object} [opts.captcha] - SDK captcha selection (default { name: 'auto' })
 * @param {(e: import('tvnz-plus-api').OtpProgressEvent) => void} [opts.onProgress]
 * @returns {Promise<{accessToken: string, refreshToken: string, deviceref: string, contactId?: string}>}
 */
export async function automatedEmailLogin({ email, sessionPath, captcha, onProgress } = {}) {
    if (!email) {
        throw new Error('automatedEmailLogin requires an email address');
    }

    const client = new TvnzClient();
    const result = await client
        .otpLogin({
            email,
            captcha: captcha ?? { name: 'auto' },
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
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    }

    return session;
}

export default { automatedEmailLogin };