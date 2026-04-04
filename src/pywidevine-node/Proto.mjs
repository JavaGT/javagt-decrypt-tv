import path from 'path';
import { fileURLToPath } from 'url';
import protobuf from 'protobufjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = protobuf.loadSync(path.join(__dirname, 'examples', 'license_protocol.proto'));

const ns = 'pywidevine_license_protocol';

export const Proto = {
    root,
    LicenseRequest: root.lookupType(`${ns}.LicenseRequest`),
    SignedMessage: root.lookupType(`${ns}.SignedMessage`),
    License: root.lookupType(`${ns}.License`),
    ClientIdentification: root.lookupType(`${ns}.ClientIdentification`),
    EncryptedClientIdentification: root.lookupType(`${ns}.EncryptedClientIdentification`),
    DrmCertificate: root.lookupType(`${ns}.DrmCertificate`),
    SignedDrmCertificate: root.lookupType(`${ns}.SignedDrmCertificate`),
    FileHashes: root.lookupType(`${ns}.FileHashes`),
    WidevinePsshData: root.lookupType(`${ns}.WidevinePsshData`),
    LicenseType: root.lookupEnum(`${ns}.LicenseType`),
    MessageType: root.lookupEnum(`${ns}.SignedMessage.MessageType`),
    RequestType: root.lookupEnum(`${ns}.LicenseRequest.RequestType`),
    ProtocolVersion: root.lookupEnum(`${ns}.ProtocolVersion`),
    KeyType: root.lookupEnum(`${ns}.License.KeyContainer.KeyType`)
};

export default Proto;
