/**
 * Widevine DRM key fetching service.
 * Handles license requests and key extraction for Widevine-protected content.
 */

import { Cdm } from '../../src/pywidevine-node/Cdm.mjs'
import { Device } from '../../src/pywidevine-node/Device.mjs'
import { PSSH } from '../../src/pywidevine-node/Pssh.mjs'

/**
 * Create an AbortSignal that times out after the specified milliseconds.
 * @param {number} ms
 * @returns {AbortSignal}
 */
function createTimeoutSignal(ms = 20000) {
  return AbortSignal.timeout(ms)
}

/**
 * Fetch Widevine DRM decryption keys.
 * @param {Object} params
 * @param {string} params.pssh - Base64-encoded PSSH box
 * @param {string} params.licenseUrl - Widevine license server URL
 * @param {string} [params.wvdDevicePath='./device.wvd'] - Path to .wvd device file
 * @param {string} [params.origin='https://www.tvnz.co.nz'] - Origin header
 * @param {string} [params.referer='https://www.tvnz.co.nz/'] - Referer header
 * @param {string} [params.userAgent] - User-Agent header
 * @param {Object} [params.retention] - Retention object for logging
 * @param {number} [params.timeoutMs=20000] - Request timeout
 * @param {string} [params.accessToken] - Bearer token for Authorization header
 * @returns {Promise<Array<string>>} Array of 'kid:key' strings
 */
export async function getWidevineKeys({
  pssh,
  licenseUrl,
  wvdDevicePath = './device.wvd',
  origin = 'https://www.tvnz.co.nz',
  referer = 'https://www.tvnz.co.nz/',
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  retention,
  timeoutMs = 20000,
  accessToken = null
}) {
  const parsedPssh = new PSSH(pssh)
  const device = Device.load(wvdDevicePath)
  const cdm = Cdm.fromDevice(device)
  const sessionId = cdm.open()

  try {
    const challenge = cdm.getLicenseChallenge(sessionId, parsedPssh)
    if (retention) {
      retention.writeJson('parsed/license_challenge_summary.json', {
        challenge_bytes: challenge.length,
        license_url: licenseUrl,
        has_authorization_token: Boolean(accessToken)
      })
    }

    const headers = {
      Accept: '*/*',
      'Content-Type': 'application/octet-stream',
      'User-Agent': userAgent,
      Origin: origin,
      Referer: referer
    }

    // Add Authorization header with Bearer token if provided
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`
    }

    const response = await fetch(licenseUrl, {
      method: 'POST',
      headers,
      body: challenge,
      signal: createTimeoutSignal(timeoutMs)
    })

    const licenseBytes = Buffer.from(await response.arrayBuffer())
    if (retention) {
      retention.writeJson('raw/license_response_headers.json', {
        status_code: response.status,
        headers: Object.fromEntries(response.headers.entries())
      })
      retention.writeText('raw/license_response.bin.b64', licenseBytes.toString('base64'))
    }

    if (!response.ok) {
      throw new Error(`License request failed: [${response.status}] ${licenseBytes.toString('utf8').slice(0, 400)}`)
    }

    cdm.parseLicense(sessionId, licenseBytes)
    const keys = cdm.getKeys(sessionId)
      .filter((key) => key.type === 'CONTENT')
      .map((key) => `${String(key.kid).replace(/-/g, '')}:${Buffer.from(key.key).toString('hex')}`)

    if (retention) {
      retention.writeJson('parsed/decryption_keys.json', {
        keys,
        key_count: keys.length,
        retrieved_at: new Date().toISOString()
      })
    }

    return keys
  } finally {
    cdm.close(sessionId)
  }
}

export default { getWidevineKeys }