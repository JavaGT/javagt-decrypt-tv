import { randomUUID } from 'crypto';

function isHexString(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value);
}

function uuidToBytes(uuid) {
    return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes) {
    const hex = Buffer.from(bytes).toString('hex').padStart(32, '0').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parsePsshBox(data) {
    const box = Buffer.from(data);
    if (box.length < 32) {
        throw new Error('PSSH box too short');
    }

    const size = box.readUInt32BE(0);
    const type = box.subarray(4, 8).toString('ascii');
    if (type !== 'pssh') {
        throw new Error('Not a pssh box');
    }

    if (size !== box.length) {
        throw new Error('Invalid pssh size');
    }

    const version = box.readUInt8(8);
    const flags = box.readUIntBE(9, 3);
    const systemId = bytesToUuid(box.subarray(12, 28));

    let offset = 28;
    let keyIds = [];

    if (version > 0) {
        const keyIdCount = box.readUInt32BE(offset);
        offset += 4;
        for (let i = 0; i < keyIdCount; i += 1) {
            keyIds.push(bytesToUuid(box.subarray(offset, offset + 16)));
            offset += 16;
        }
    }

    const initDataSize = box.readUInt32BE(offset);
    offset += 4;
    const initData = box.subarray(offset, offset + initDataSize);

    return {
        version,
        flags,
        systemId,
        keyIds,
        initData
    };
}

function buildPsshBox({ version, flags, systemId, keyIds, initData }) {
    const keyIdBuffers = version > 0 ? keyIds.map(uuidToBytes) : [];
    const keyIdsLen = version > 0 ? 4 + keyIdBuffers.length * 16 : 0;
    const initDataBuffer = Buffer.from(initData || []);

    const total = 4 + 4 + 1 + 3 + 16 + keyIdsLen + 4 + initDataBuffer.length;
    const out = Buffer.alloc(total);
    let offset = 0;

    out.writeUInt32BE(total, offset);
    offset += 4;
    out.write('pssh', offset, 4, 'ascii');
    offset += 4;
    out.writeUInt8(version, offset);
    offset += 1;
    out.writeUIntBE(flags, offset, 3);
    offset += 3;
    uuidToBytes(systemId).copy(out, offset);
    offset += 16;

    if (version > 0) {
        out.writeUInt32BE(keyIdBuffers.length, offset);
        offset += 4;
        for (const kid of keyIdBuffers) {
            kid.copy(out, offset);
            offset += 16;
        }
    }

    out.writeUInt32BE(initDataBuffer.length, offset);
    offset += 4;
    initDataBuffer.copy(out, offset);
    return out;
}

export class PSSH {
    static SystemId = Object.freeze({
        Widevine: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
        PlayReady: '9a04f079-9840-4286-ab92-e65be0885f95'
    });

    constructor(data, strict = false) {
        if (!data) {
            throw new Error('Data must not be empty');
        }

        let bytes;
        if (typeof data === 'string') {
            bytes = isHexString(data) ? Buffer.from(data, 'hex') : Buffer.from(data, 'base64');
        } else if (Buffer.isBuffer(data)) {
            bytes = data;
        } else if (data && data.type === 'pssh') {
            bytes = buildPsshBox(data);
        } else {
            throw new TypeError('Expected data to be Buffer, base64 string, hex string, or pssh-like object');
        }

        try {
            const parsed = parsePsshBox(bytes);
            this.version = parsed.version;
            this.flags = parsed.flags;
            this.systemId = parsed.systemId;
            this.keyIdsInternal = parsed.keyIds;
            this.initData = parsed.initData;
        } catch (error) {
            if (strict) {
                throw error;
            }
            this.version = 0;
            this.flags = 0;
            this.systemId = PSSH.SystemId.Widevine;
            this.keyIdsInternal = [];
            this.initData = bytes;
        }
    }

    static create(systemId, keyIds = null, initData = null, version = 0, flags = 0) {
        if (!systemId) {
            throw new Error('A System ID must be specified');
        }
        if (![0, 1].includes(version)) {
            throw new Error('Version must be 0 or 1');
        }

        const box = new PSSH(buildPsshBox({
            version,
            flags,
            systemId,
            keyIds: [],
            initData: initData || Buffer.alloc(0)
        }));

        if (Array.isArray(keyIds) && keyIds.length > 0) {
            box.setKeyIds(keyIds);
        }
        return box;
    }

    get keyIds() {
        return this.keyIdsInternal;
    }

    dump() {
        return buildPsshBox({
            version: this.version,
            flags: this.flags,
            systemId: this.systemId,
            keyIds: this.version > 0 ? this.keyIdsInternal : [],
            initData: this.initData
        });
    }

    dumps() {
        return this.dump().toString('base64');
    }

    toWidevine() {
        this.systemId = PSSH.SystemId.Widevine;
    }

    toPlayready() {
        this.systemId = PSSH.SystemId.PlayReady;
    }

    setKeyIds(keyIds) {
        if (this.systemId !== PSSH.SystemId.Widevine) {
            throw new Error(`Only Widevine PSSH boxes are supported, not ${this.systemId}`);
        }

        this.keyIdsInternal = PSSH.parseKeyIds(keyIds);
        if (this.version === 0) {
            this.version = 1;
        }
    }

    static parseKeyIds(keyIds) {
        if (!Array.isArray(keyIds)) {
            throw new TypeError('Expected keyIds to be an array');
        }

        return keyIds.map((kid) => {
            if (typeof kid === 'string') {
                if (/^[0-9a-fA-F-]{32,36}$/.test(kid)) {
                    return kid.includes('-') ? kid.toLowerCase() : bytesToUuid(Buffer.from(kid, 'hex'));
                }
                return bytesToUuid(Buffer.from(kid, 'base64'));
            }
            if (Buffer.isBuffer(kid)) {
                return bytesToUuid(kid);
            }
            if (kid && kid.bytes) {
                return bytesToUuid(Buffer.from(kid.bytes));
            }
            if (kid == null) {
                return randomUUID();
            }
            throw new TypeError(`Unsupported key ID: ${String(kid)}`);
        });
    }
}

export default PSSH;
