import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { aesCmac } from 'node-aes-cmac';
import { Session } from './Session.mjs';
import { Key } from './Key.mjs';
import { Proto } from './Proto.mjs';
import { DeviceTypes } from './Device.mjs';
import { getBinaryPath } from './Utils.mjs';

function toBuffer(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    return Buffer.from(value || []);
}

function normalizeLicenseType(licenseType) {
    if (typeof licenseType !== 'string') {
        throw new TypeError(`Expected licenseType to be a string, got ${typeof licenseType}`);
    }

    const upper = licenseType.toUpperCase();
    if (!(upper in Proto.LicenseType.values)) {
        throw new Error(`Invalid licenseType '${licenseType}'. Available: ${Object.keys(Proto.LicenseType.values).join(', ')}`);
    }
    return upper;
}

export class Cdm {
    static uuid = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
    static urn = `urn:uuid:${Cdm.uuid}`;
    static keyFormat = Cdm.urn;
    static serviceCertificateChallenge = Buffer.from([0x08, 0x04]);
    static MAX_NUM_OF_SESSIONS = 16;

    constructor(deviceType, systemId, securityLevel, clientId = null, rsaKey = null) {
        if (!deviceType) {
            throw new Error('Device Type must be provided');
        }
        if (!Number.isInteger(systemId)) {
            throw new TypeError('systemId must be an integer');
        }
        if (!Number.isInteger(securityLevel)) {
            throw new TypeError('securityLevel must be an integer');
        }
        if (!clientId || !Buffer.isBuffer(clientId)) {
            throw new TypeError('clientId must be a Buffer');
        }
        if (!rsaKey || !Buffer.isBuffer(rsaKey)) {
            throw new TypeError('rsaKey must be a Buffer');
        }

        this.deviceType = deviceType;
        this.systemId = systemId;
        this.securityLevel = securityLevel;
        this.clientId = clientId;
        this.clientIdMessage = Proto.ClientIdentification.decode(clientId);
        this.rsaPrivateKey = crypto.createPrivateKey({
            key: rsaKey,
            format: 'der',
            type: 'pkcs1'
        });
        this.sessions = new Map();
    }

    static fromDevice(device) {
        return new Cdm(
            device.type,
            device.systemId || 0,
            device.securityLevel,
            device.clientId,
            device.privateKey
        );
    }

    open() {
        if (this.sessions.size >= Cdm.MAX_NUM_OF_SESSIONS) {
            throw new Error(`Too many Sessions open (${Cdm.MAX_NUM_OF_SESSIONS}).`);
        }

        const session = new Session(this.sessions.size + 1);
        this.sessions.set(session.id.toString('hex'), session);
        return session.id;
    }

    close(sessionId) {
        const key = Buffer.from(sessionId).toString('hex');
        if (!this.sessions.has(key)) {
            throw new Error(`Session identifier ${key} is invalid.`);
        }
        this.sessions.delete(key);
    }

    setServiceCertificate(sessionId, certificate) {
        const session = this._getSession(sessionId);

        if (certificate == null) {
            const providerId = session.serviceCertificateProviderId;
            session.serviceCertificate = null;
            session.serviceCertificateProviderId = null;
            return providerId;
        }

        let data;
        if (typeof certificate === 'string') {
            data = Buffer.from(certificate, 'base64');
        } else if (Buffer.isBuffer(certificate)) {
            data = certificate;
        } else {
            throw new TypeError('certificate must be base64 string, Buffer, or null');
        }

        let signed;
        try {
            const asSignedMessage = Proto.SignedMessage.decode(data);
            signed = Proto.SignedDrmCertificate.decode(asSignedMessage.msg);
        } catch {
            signed = Proto.SignedDrmCertificate.decode(data);
        }

        const drmCertificate = Proto.DrmCertificate.decode(signed.drmCertificate);
        session.serviceCertificate = signed;
        session.serviceCertificateProviderId = drmCertificate.providerId || null;
        return session.serviceCertificateProviderId;
    }

    getServiceCertificate(sessionId) {
        return this._getSession(sessionId).serviceCertificate;
    }

    getLicenseChallenge(sessionId, pssh, licenseType = 'STREAMING', privacyMode = true) {
        const session = this._getSession(sessionId);
        if (!pssh || !pssh.initData) {
            throw new Error('A valid pssh must be provided.');
        }

        const normalizedLicenseType = normalizeLicenseType(licenseType);

        let requestId;
        if (this.deviceType === 'ANDROID' || this.deviceType === DeviceTypes.ANDROID) {
            const partA = crypto.randomBytes(4);
            const partB = Buffer.alloc(4, 0);
            const partC = Buffer.alloc(8);
            partC.writeBigUInt64LE(BigInt(session.number));
            requestId = Buffer.from(Buffer.concat([partA, partB, partC]).toString('hex').toUpperCase(), 'ascii');
        } else {
            requestId = crypto.randomBytes(16);
        }

        const usePrivacy = Boolean(privacyMode && session.serviceCertificate);

        const widevinePsshData = {
            psshData: [toBuffer(pssh.initData)],
            licenseType: Proto.LicenseType.values[normalizedLicenseType],
            requestId
        };

        const licenseRequestPayload = {
            contentId: {
                widevinePsshData
            },
            type: Proto.RequestType.values.NEW,
            requestTime: Math.floor(Date.now() / 1000),
            protocolVersion: Proto.ProtocolVersion.values.VERSION_2_1,
            keyControlNonce: Math.floor(Math.random() * (2 ** 31 - 1)) + 1
        };

        if (usePrivacy) {
            licenseRequestPayload.encryptedClientId = this.encryptClientId(this.clientIdMessage, session.serviceCertificate);
        } else {
            licenseRequestPayload.clientId = this.clientIdMessage;
        }

        const licenseRequestMessage = Proto.LicenseRequest.create(licenseRequestPayload);
        const licenseRequestBytes = Buffer.from(Proto.LicenseRequest.encode(licenseRequestMessage).finish());

        const sign = crypto.createSign('RSA-SHA1');
        sign.update(licenseRequestBytes);
        sign.end();
        const signature = sign.sign({
            key: this.rsaPrivateKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        });

        const signedMessage = Proto.SignedMessage.create({
            type: Proto.MessageType.values.LICENSE_REQUEST,
            msg: licenseRequestBytes,
            signature
        });

        session.context.set(requestId.toString('hex'), this.deriveContext(licenseRequestBytes));

        return Buffer.from(Proto.SignedMessage.encode(signedMessage).finish());
    }

    parseLicense(sessionId, licenseMessage) {
        const session = this._getSession(sessionId);

        if (!licenseMessage) {
            throw new Error('Cannot parse an empty license message');
        }

        let data;
        if (typeof licenseMessage === 'string') {
            data = Buffer.from(licenseMessage, 'base64');
        } else {
            data = toBuffer(licenseMessage);
        }

        const signed = Proto.SignedMessage.decode(data);
        if (signed.type !== Proto.MessageType.values.LICENSE) {
            throw new Error('Expected a LICENSE message');
        }

        const license = Proto.License.decode(signed.msg);
        const requestId = toBuffer(license.id?.requestId).toString('hex');

        const context = session.context.get(requestId);
        if (!context) {
            throw new Error('Cannot parse a license without matching challenge context');
        }

        const decryptedSessionKey = crypto.privateDecrypt(
            {
                key: this.rsaPrivateKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
            },
            toBuffer(signed.sessionKey)
        );

        const [encKey, macKeyServer] = this.deriveKeys(context.encContext, context.macContext, decryptedSessionKey);

        const hmac = crypto.createHmac('sha256', macKeyServer);
        if (signed.oemcryptoCoreMessage && signed.oemcryptoCoreMessage.length) {
            hmac.update(toBuffer(signed.oemcryptoCoreMessage));
        }
        hmac.update(toBuffer(signed.msg));
        const computed = hmac.digest();
        const signature = toBuffer(signed.signature);

        if (computed.length !== signature.length || !crypto.timingSafeEqual(computed, signature)) {
            throw new Error('Signature mismatch on license message');
        }

        session.keys = (license.key || []).map((keyContainer) => Key.fromKeyContainer(keyContainer, encKey));
        session.context.delete(requestId);
    }

    getKeys(sessionId, type = null) {
        const session = this._getSession(sessionId);
        if (!type) {
            return session.keys;
        }

        const typeName = typeof type === 'number' ? Proto.KeyType.valuesById[type] : String(type).toUpperCase();
        return session.keys.filter((key) => key.type === typeName);
    }

    decrypt(sessionId, inputFile, outputFile, tempDir = null, existsOk = false) {
        const session = this._getSession(sessionId);

        if (!session.keys.length) {
            throw new Error('No keys are loaded yet, cannot decrypt');
        }

        const packager = getBinaryPath('shaka-packager', 'packager-osx', 'packager-linux', 'packager-win');
        if (!packager) {
            throw new Error('Shaka Packager executable not found');
        }

        const args = [
            `input=${inputFile},stream=0,output=${outputFile}`,
            '--enable_raw_key_decryption'
        ];

        const labels = [];
        for (let i = 0; i < session.keys.length; i += 1) {
            const key = session.keys[i];
            if (key.type !== 'CONTENT') {
                continue;
            }
            const kidHex = key.kid.replace(/-/g, '');
            const keyHex = Buffer.from(key.key).toString('hex');
            labels.push(`label=1_${i}:key_id=${kidHex}:key=${keyHex}`);
            labels.push(`label=2_${i}:key_id=${'0'.repeat(32)}:key=${keyHex}`);
        }

        if (!labels.length) {
            throw new Error('No CONTENT keys loaded to decrypt');
        }

        args.push('--keys', labels.join(','));

        if (tempDir) {
            args.push('--temp_dir', String(tempDir));
        }

        if (!existsOk) {
            if (fs.existsSync(outputFile)) {
                throw new Error(`Output file already exists: ${outputFile}`);
            }
        }

        const result = spawnSync(packager, args, { stdio: 'inherit' });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`Shaka Packager exited with code ${result.status}`);
        }
        return result.status;
    }

    encryptClientId(clientIdMessage, signedServiceCertificate, key = null, iv = null) {
        const drmCertificate = Proto.DrmCertificate.decode(signedServiceCertificate.drmCertificate);
        const privacyKey = key || crypto.randomBytes(16);
        const privacyIv = iv || crypto.randomBytes(16);

        const clientBytes = Buffer.from(Proto.ClientIdentification.encode(clientIdMessage).finish());

        const cipher = crypto.createCipheriv('aes-128-cbc', privacyKey, privacyIv);
        cipher.setAutoPadding(true);
        const encryptedClientId = Buffer.concat([cipher.update(clientBytes), cipher.final()]);

        const servicePublicKey = crypto.createPublicKey({
            key: toBuffer(drmCertificate.public_key),
            format: 'der',
            type: 'pkcs1'
        });

        const encryptedPrivacyKey = crypto.publicEncrypt(
            {
                key: servicePublicKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
            },
            privacyKey
        );

        return Proto.EncryptedClientIdentification.create({
            providerId: drmCertificate.providerId,
            serviceCertificateSerialNumber: drmCertificate.serialNumber,
            encryptedClientId,
            encryptedClientIdIv: privacyIv,
            encryptedPrivacyKey
        });
    }

    deriveContext(message) {
        const msg = toBuffer(message);

        const encLabel = Buffer.from('ENCRYPTION', 'ascii');
        const macLabel = Buffer.from('AUTHENTICATION', 'ascii');
        const zero = Buffer.from([0x00]);

        const encBits = Buffer.alloc(4);
        encBits.writeUInt32BE(16 * 8);

        const macBits = Buffer.alloc(4);
        macBits.writeUInt32BE(32 * 8 * 2);

        return {
            encContext: Buffer.concat([encLabel, zero, msg, encBits]),
            macContext: Buffer.concat([macLabel, zero, msg, macBits])
        };
    }

    deriveKeys(encContext, macContext, key) {
        const derive = (context, counter) => {
            return Buffer.from(aesCmac(toBuffer(key), Buffer.concat([Buffer.from([counter]), toBuffer(context)]), { returnAsBuffer: true }));
        };

        const encKey = derive(encContext, 1);
        const macKeyServer = Buffer.concat([derive(macContext, 1), derive(macContext, 2)]);
        const macKeyClient = Buffer.concat([derive(macContext, 3), derive(macContext, 4)]);

        return [encKey, macKeyServer, macKeyClient];
    }

    _getSession(sessionId) {
        const key = Buffer.from(sessionId).toString('hex');
        const session = this.sessions.get(key);
        if (!session) {
            throw new Error(`Session identifier ${key} is invalid.`);
        }
        return session;
    }
}

export default Cdm;
