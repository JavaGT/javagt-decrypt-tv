import Cdm from './Cdm.mjs';
import { PSSH } from './Pssh.mjs';

export class RemoteCdm extends Cdm {
    constructor(deviceType, systemId, securityLevel, host, secret, deviceName) {
        super(deviceType, systemId, securityLevel, null, null);
        if (!host || !secret || !deviceName) {
            throw new Error('host, secret, and deviceName are required');
        }
        this.host = host.replace(/\/$/, '');
        this.secret = secret;
        this.deviceName = deviceName;
    }

    async open() {
        const response = await fetch(`${this.host}/${this.deviceName}/open`, {
            headers: { 'X-Secret-Key': this.secret }
        });
        const body = await response.json();
        if (body.status !== 200) {
            throw new Error(`Cannot open CDM session: ${body.message} [${body.status}]`);
        }
        return Buffer.from(body.data.session_id, 'hex');
    }

    async close(sessionId) {
        const response = await fetch(`${this.host}/${this.deviceName}/close/${Buffer.from(sessionId).toString('hex')}`, {
            headers: { 'X-Secret-Key': this.secret }
        });
        const body = await response.json();
        if (body.status !== 200) {
            throw new Error(`Cannot close CDM session: ${body.message} [${body.status}]`);
        }
    }

    async getLicenseChallenge(sessionId, pssh, licenseType = 'STREAMING', privacyMode = true) {
        if (!(pssh instanceof PSSH)) {
            throw new TypeError('pssh must be a PSSH instance');
        }

        const response = await fetch(`${this.host}/${this.deviceName}/get_license_challenge/${licenseType}`, {
            method: 'POST',
            headers: {
                'X-Secret-Key': this.secret,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                session_id: Buffer.from(sessionId).toString('hex'),
                init_data: pssh.dumps(),
                privacy_mode: privacyMode
            })
        });

        const body = await response.json();
        if (body.status !== 200) {
            throw new Error(`Cannot get challenge: ${body.message} [${body.status}]`);
        }

        return Buffer.from(body.data.challenge_b64, 'base64');
    }
}

export default RemoteCdm;
