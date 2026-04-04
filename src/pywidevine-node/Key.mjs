import crypto from 'crypto';
import { Proto } from './Proto.mjs';

function formatUuidFromBuffer(buffer) {
    const hex = Buffer.from(buffer).toString('hex').padEnd(32, '0').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function aesCbcPkcs7Decrypt(encrypted, key, iv) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(Buffer.from(encrypted)), decipher.final()]);
}

export class Key {
    constructor(type, kid, key, permissions = []) {
        this.type = type;
        this.kid = kid;
        this.key = Buffer.from(key);
        this.permissions = permissions;
    }

    static fromKeyContainer(keyContainer, encKey) {
        const keyTypeName = Proto.KeyType.valuesById[keyContainer.type] || String(keyContainer.type);

        const permissions = [];
        const operatorPerms = keyContainer.operatorSessionKeyPermissions;
        if (operatorPerms && keyTypeName === 'OPERATOR_SESSION') {
            for (const [name, value] of Object.entries(operatorPerms)) {
                if (value === true) {
                    permissions.push(name);
                }
            }
        }

        const decryptedKey = aesCbcPkcs7Decrypt(keyContainer.key, encKey, keyContainer.iv);

        return new Key(
            keyTypeName,
            Key.kidToUuid(keyContainer.id),
            decryptedKey,
            permissions
        );
    }

    static kidToUuid(kid) {
        let value = kid;

        if (typeof value === 'string') {
            value = Buffer.from(value, 'base64');
        }

        if (!value || value.length === 0) {
            value = Buffer.alloc(16, 0);
        }

        const asAscii = Buffer.from(value).toString('utf8');
        if (/^\d+$/.test(asAscii)) {
            const bigint = BigInt(asAscii);
            const hex = bigint.toString(16).padStart(32, '0');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        }

        let buffer = Buffer.from(value);
        if (buffer.length < 16) {
            buffer = Buffer.concat([buffer, Buffer.alloc(16 - buffer.length, 0)]);
        }

        return formatUuidFromBuffer(buffer);
    }
}

export default Key;
