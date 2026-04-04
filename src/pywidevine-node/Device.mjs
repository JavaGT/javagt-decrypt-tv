import fs from 'fs';
import path from 'path';
import { Proto } from './Proto.mjs';

export const DeviceTypes = Object.freeze({
    CHROME: 1,
    ANDROID: 2
});

function assertBuffer(data, name) {
    if (!Buffer.isBuffer(data)) {
        throw new TypeError(`${name} must be a Buffer`);
    }
}

function readU16BE(buffer, offset) {
    return buffer.readUInt16BE(offset);
}

function parseType(typeByte) {
    const entry = Object.entries(DeviceTypes).find(([, value]) => value === typeByte);
    if (!entry) {
        throw new Error(`Unsupported device type byte: ${typeByte}`);
    }
    return entry[0];
}

function parseWvdV2(buffer) {
    assertBuffer(buffer, 'buffer');

    if (buffer.length < 9) {
        throw new Error('WVD data is too short');
    }

    if (buffer.subarray(0, 3).toString('ascii') !== 'WVD') {
        throw new Error('Invalid WVD signature');
    }

    const version = buffer.readUInt8(3);
    if (version !== 2) {
        throw new Error(`Unsupported WVD version: ${version}`);
    }

    const typeByte = buffer.readUInt8(4);
    const securityLevel = buffer.readUInt8(5);
    const flags = buffer.readUInt8(6);

    const privateKeyLen = readU16BE(buffer, 7);
    const privateKeyStart = 9;
    const privateKeyEnd = privateKeyStart + privateKeyLen;
    if (privateKeyEnd > buffer.length) {
        throw new Error('Invalid WVD private key length');
    }
    const privateKey = buffer.subarray(privateKeyStart, privateKeyEnd);

    const clientIdLenOffset = privateKeyEnd;
    if (clientIdLenOffset + 2 > buffer.length) {
        throw new Error('Missing WVD client id length');
    }

    const clientIdLen = readU16BE(buffer, clientIdLenOffset);
    const clientIdStart = clientIdLenOffset + 2;
    const clientIdEnd = clientIdStart + clientIdLen;
    if (clientIdEnd > buffer.length) {
        throw new Error('Invalid WVD client id length');
    }

    return {
        version,
        type: parseType(typeByte),
        typeByte,
        securityLevel,
        flags,
        privateKey,
        clientId
            : buffer.subarray(clientIdStart, clientIdEnd)
    };
}

function migrateV1ToV2(buffer) {
    assertBuffer(buffer, 'buffer');
    if (buffer.length < 11) {
        throw new Error('WVD v1 data is too short');
    }
    if (buffer.subarray(0, 3).toString('ascii') !== 'WVD') {
        throw new Error('Invalid WVD signature');
    }
    if (buffer.readUInt8(3) !== 1) {
        throw new Error('Input is not WVD v1');
    }

    const typeByte = buffer.readUInt8(4);
    const securityLevel = buffer.readUInt8(5);
    const privateKeyLen = buffer.readUInt16BE(7);
    const privateKeyStart = 9;
    const privateKeyEnd = privateKeyStart + privateKeyLen;
    if (privateKeyEnd > buffer.length) {
        throw new Error('Invalid v1 private key length');
    }

    const clientIdLenOffset = privateKeyEnd;
    if (clientIdLenOffset + 2 > buffer.length) {
        throw new Error('Missing v1 client id length');
    }
    const clientIdLen = buffer.readUInt16BE(clientIdLenOffset);
    const clientIdStart = clientIdLenOffset + 2;
    const clientIdEnd = clientIdStart + clientIdLen;
    if (clientIdEnd > buffer.length) {
        throw new Error('Invalid v1 client id length');
    }

    const privateKey = buffer.subarray(privateKeyStart, privateKeyEnd);
    const clientId = buffer.subarray(clientIdStart, clientIdEnd);

    return Device.build({
        typeByte,
        securityLevel,
        flags: 0,
        privateKey,
        clientId
    });
}

export class Device {
    constructor({ type, securityLevel, flags = 0, privateKey, clientId, systemId = null }) {
        if (!type) {
            throw new Error('type is required');
        }
        if (!Number.isInteger(securityLevel)) {
            throw new TypeError('securityLevel must be an integer');
        }
        assertBuffer(privateKey, 'privateKey');
        assertBuffer(clientId, 'clientId');

        this.type = type;
        this.typeByte = DeviceTypes[type];
        this.securityLevel = securityLevel;
        this.flags = flags;
        this.privateKey = privateKey;
        this.clientId = clientId;

        this.clientIdMessage = Proto.ClientIdentification.decode(clientId);
        this.vmp = null;
        if (this.clientIdMessage.vmpData && this.clientIdMessage.vmpData.length > 0) {
            this.vmp = Proto.FileHashes.decode(this.clientIdMessage.vmpData);
        }

        const signedDrmCertificate = Proto.SignedDrmCertificate.decode(this.clientIdMessage.token);
        const drmCertificate = Proto.DrmCertificate.decode(signedDrmCertificate.drmCertificate);
        this.systemId = systemId ?? drmCertificate.systemId ?? null;
    }

    static loads(data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
        const version = buffer.readUInt8(3);
        if (version === 1) {
            return Device.loads(migrateV1ToV2(buffer));
        }
        const parsed = parseWvdV2(buffer);
        return new Device({
            type: parsed.type,
            securityLevel: parsed.securityLevel,
            flags: parsed.flags,
            privateKey: parsed.privateKey,
            clientId: parsed.clientId
        });
    }

    static load(filePath) {
        const data = fs.readFileSync(filePath);
        return Device.loads(data);
    }

    static build({ typeByte, securityLevel, flags = 0, privateKey, clientId }) {
        const privateKeyLen = privateKey.length;
        const clientIdLen = clientId.length;
        const total = 3 + 1 + 1 + 1 + 1 + 2 + privateKeyLen + 2 + clientIdLen;

        const out = Buffer.alloc(total);
        out.write('WVD', 0, 3, 'ascii');
        out.writeUInt8(2, 3);
        out.writeUInt8(typeByte, 4);
        out.writeUInt8(securityLevel, 5);
        out.writeUInt8(flags, 6);
        out.writeUInt16BE(privateKeyLen, 7);
        privateKey.copy(out, 9);
        out.writeUInt16BE(clientIdLen, 9 + privateKeyLen);
        clientId.copy(out, 11 + privateKeyLen);
        return out;
    }

    dumps() {
        return Device.build({
            typeByte: this.typeByte,
            securityLevel: this.securityLevel,
            flags: this.flags,
            privateKey: this.privateKey,
            clientId: this.clientId
        });
    }

    dump(filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, this.dumps());
    }

    static migrate(data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
        const version = buffer.readUInt8(3);
        if (version === 2) {
            return Device.loads(buffer);
        }
        if (version !== 1) {
            throw new Error(`Unsupported WVD version: ${version}`);
        }
        return Device.loads(migrateV1ToV2(buffer));
    }
}

export default Device;
