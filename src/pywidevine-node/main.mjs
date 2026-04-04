#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { Device, DeviceTypes } from './Device.mjs';
import Cdm from './Cdm.mjs';
import { PSSH } from './Pssh.mjs';
import { Proto } from './Proto.mjs';
import { startServe } from './serve.mjs';

const VERSION = 'js-port-1.0.0';

function printHeader() {
    const year = new Date().getFullYear();
    console.info(`pywidevine JS port version ${VERSION} Copyright (c) 2022-${year}`);
    console.info('https://github.com/devine-dl/pywidevine');
}

function usage() {
    console.log([
        'Usage: node src/pywidevine-node/main.mjs [--version] [--debug] <command> [args] [options]',
        '',
        'Commands:',
        '  license <device_path> <pssh> <server> [--type STREAMING|OFFLINE|AUTOMATIC] [--privacy]',
        '  test <device_path> [--privacy]',
        '  create-device --type <CHROME|ANDROID> --level <1|2|3> --key <private_key> --client_id <client_id.bin> [--vmp <vmp.bin>] [--output <path>]',
        '  export-device <wvd_path> [--out_dir <dir>]',
        '  migrate <path_to_wvd_or_dir>',
        '  serve <config_path> [--host 127.0.0.1] [--port 8786]'
    ].join('\n'));
}

function parseFlags(argv) {
    const positional = [];
    const options = {};

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const [key, inlineValue] = token.split('=', 2);
            if (typeof inlineValue !== 'undefined') {
                options[key] = inlineValue;
            } else {
                const next = argv[i + 1];
                if (!next || next.startsWith('--')) {
                    options[key] = true;
                } else {
                    options[key] = next;
                    i += 1;
                }
            }
            continue;
        }

        if (token.startsWith('-')) {
            if (token === '-v') {
                options['--version'] = true;
            } else if (token === '-d') {
                options['--debug'] = true;
            } else if (token === '-p') {
                options['--privacy'] = true;
            } else if (token === '-t') {
                options['--type'] = argv[i + 1];
                i += 1;
            } else if (token === '-l') {
                options['--level'] = argv[i + 1];
                i += 1;
            } else if (token === '-k') {
                options['--key'] = argv[i + 1];
                i += 1;
            } else if (token === '-c') {
                options['--client_id'] = argv[i + 1];
                i += 1;
            } else if (token === '-o') {
                options['--output'] = argv[i + 1];
                options['--out_dir'] = argv[i + 1];
                i += 1;
            } else if (token === '-h') {
                options['--host'] = argv[i + 1];
                i += 1;
            } else {
                positional.push(token);
            }
            continue;
        }

        positional.push(token);
    }

    return { positional, options };
}

function sanitizeName(input) {
    return input
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_\-.]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) {
        crc ^= buffer[i];
        for (let j = 0; j < 8; j += 1) {
            const mask = -(crc & 1);
            crc = (crc >>> 1) ^ (0xedb88320 & mask);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function ensureFileExists(filePath, label) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`${label}: Not a path to a file, or it does not exist.`);
    }
}

function privateKeyToDer(privateKeyData) {
    const asText = privateKeyData.toString('utf8');
    if (asText.includes('-----BEGIN')) {
        const keyObj = crypto.createPrivateKey(asText);
        return keyObj.export({ format: 'der', type: 'pkcs1' });
    }
    return privateKeyData;
}

async function commandLicense(args, options) {
    const [devicePath, psshValue, server] = args;
    if (!devicePath || !psshValue || !server) {
        throw new Error('license requires <device_path> <pssh> <server>');
    }

    const licenseType = String(options['--type'] || 'STREAMING').toUpperCase();
    const privacy = Boolean(options['--privacy']);

    const device = Device.load(devicePath);
    console.info(`[+] Loaded Device (${device.systemId} L${device.securityLevel})`);

    const cdm = Cdm.fromDevice(device);
    console.info('[+] Loaded CDM');

    const sessionId = cdm.open();
    console.info(`[+] Opened CDM Session: ${Buffer.from(sessionId).toString('hex')}`);

    if (privacy) {
        const serviceCertRes = await fetch(server, {
            method: 'POST',
            body: Cdm.serviceCertificateChallenge
        });
        if (!serviceCertRes.ok) {
            throw new Error(`Failed to get Service Privacy Certificate: [${serviceCertRes.status}] ${await serviceCertRes.text()}`);
        }
        const serviceCert = Buffer.from(await serviceCertRes.arrayBuffer());
        const providerId = cdm.setServiceCertificate(sessionId, serviceCert);
        console.info(`[+] Set Service Privacy Certificate: ${providerId}`);
    }

    const pssh = new PSSH(psshValue);
    const challenge = cdm.getLicenseChallenge(sessionId, pssh, licenseType, privacy);
    console.info('[+] Created License Request Message (Challenge)');

    const licenseRes = await fetch(server, {
        method: 'POST',
        body: challenge
    });
    if (!licenseRes.ok) {
        throw new Error(`Failed to send challenge: [${licenseRes.status}] ${await licenseRes.text()}`);
    }

    const licenseBytes = Buffer.from(await licenseRes.arrayBuffer());
    console.info('[+] Got License Message');

    cdm.parseLicense(sessionId, licenseBytes);
    console.info('[+] License Parsed Successfully');

    for (const key of cdm.getKeys(sessionId)) {
        const kidHex = String(key.kid).replace(/-/g, '');
        console.info(`[${key.type}] ${kidHex}:${Buffer.from(key.key).toString('hex')}`);
    }

    cdm.close(sessionId);
}

async function commandTest(args, options) {
    const [devicePath] = args;
    if (!devicePath) {
        throw new Error('test requires <device_path>');
    }

    const pssh = 'AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQ62dqu8s0Xpa7z2FmMPGj2hoNd2lkZXZpbmVfdGVzdCIQZmtqM2xqYVNkZmFsa3IzaioCSEQyAA==';
    const server = 'https://cwip-shaka-proxy.appspot.com/no_auth';
    const privacy = Boolean(options['--privacy']);

    await commandLicense([devicePath, pssh, server], {
        '--type': 'STREAMING',
        '--privacy': privacy
    });
}

async function commandCreateDevice(_args, options) {
    const type = String(options['--type'] || '').toUpperCase();
    const level = Number(options['--level']);
    const keyPath = options['--key'];
    const clientIdPath = options['--client_id'];
    const vmpPath = options['--vmp'];
    const output = options['--output'];

    if (!type || !(type in DeviceTypes)) {
        throw new Error('create-device requires --type CHROME|ANDROID');
    }
    if (!Number.isInteger(level) || level < 1 || level > 3) {
        throw new Error('create-device requires --level 1|2|3');
    }

    ensureFileExists(keyPath, 'key');
    ensureFileExists(clientIdPath, 'client_id');
    if (vmpPath) {
        ensureFileExists(vmpPath, 'vmp');
    }

    const privateKeyDer = Buffer.from(privateKeyToDer(fs.readFileSync(keyPath)));
    const clientIdBuffer = fs.readFileSync(clientIdPath);
    const clientIdMessage = Proto.ClientIdentification.decode(clientIdBuffer);

    if (vmpPath) {
        const newVmpData = fs.readFileSync(vmpPath);
        if (clientIdMessage.vmpData && Buffer.compare(Buffer.from(clientIdMessage.vmpData), newVmpData) !== 0) {
            console.warn('Client ID already has Verified Media Path data');
        }
        clientIdMessage.vmpData = newVmpData;
    }

    const device = new Device({
        type,
        securityLevel: level,
        flags: 0,
        privateKey: privateKeyDer,
        clientId: Buffer.from(Proto.ClientIdentification.encode(clientIdMessage).finish())
    });

    const wvdBin = device.dumps();

    const clientInfo = {};
    for (const entry of clientIdMessage.clientInfo || []) {
        clientInfo[entry.name] = entry.value;
    }

    let name = `${clientInfo.companyName || clientInfo.company_name || 'device'} ${clientInfo.modelName || clientInfo.model_name || ''}`.trim();
    const cdmVer = clientInfo.widevineCdmVersion || clientInfo.widevine_cdm_version;
    if (cdmVer) {
        name += ` ${cdmVer}`;
    }

    const crcHex = crc32(wvdBin).toString(16).padStart(8, '0');
    name = sanitizeName(`${name} ${crcHex}`);

    let outPath;
    if (output && path.extname(output)) {
        outPath = output;
        if (path.extname(output).toLowerCase() !== '.wvd') {
            console.warn(`Saving WVD with the file extension '${path.extname(output)}' but '.wvd' is recommended.`);
        }
    } else {
        const outDir = output || process.cwd();
        outPath = path.join(outDir, `${name}_${device.systemId}_l${device.securityLevel}.wvd`);
    }

    if (fs.existsSync(outPath)) {
        throw new Error(`A file already exists at '${outPath}', cannot overwrite.`);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, wvdBin);

    console.info(`Created Widevine Device (.wvd) file, ${path.basename(outPath)}`);
    console.info(` + Type: ${device.type}`);
    console.info(` + System ID: ${device.systemId}`);
    console.info(` + Security Level: ${device.securityLevel}`);
    console.info(` + Flags: ${device.flags}`);
    console.info(` + Private Key: ${Boolean(device.privateKey)} (${device.privateKey.length * 8} bit)`);
    console.info(` + Client ID: ${Boolean(device.clientId)} (${device.clientId.length} bytes)`);
    if (clientIdMessage.vmpData && clientIdMessage.vmpData.length) {
        const fileHashes = Proto.FileHashes.decode(clientIdMessage.vmpData);
        console.info(` + VMP: True (${(fileHashes.signatures || []).length} signatures)`);
    } else {
        console.info(' + VMP: False');
    }
    console.info(` + Saved to: ${path.resolve(outPath)}`);
}

async function commandExportDevice(args, options) {
    const [wvdPath] = args;
    if (!wvdPath) {
        throw new Error('export-device requires <wvd_path>');
    }
    ensureFileExists(wvdPath, 'wvd_path');

    const outDirOption = options['--out_dir'];
    const baseOut = outDirOption || process.cwd();
    const outPath = path.join(baseOut, path.parse(wvdPath).name);

    if (fs.existsSync(outPath)) {
        const entries = fs.readdirSync(outPath);
        if (entries.length) {
            throw new Error('Output directory is not empty, cannot overwrite.');
        }
        console.warn('Output directory already exists, but is empty.');
    } else {
        fs.mkdirSync(outPath, { recursive: true });
    }

    const device = Device.load(wvdPath);
    console.info(`Exporting Widevine Device (.wvd) file, ${path.parse(wvdPath).name}`);
    console.info(`L${device.securityLevel} ${device.systemId} ${device.type}`);
    console.info(`Saving to: ${outPath}`);

    const clientInfo = {};
    for (const entry of device.clientIdMessage.clientInfo || []) {
        clientInfo[entry.name] = entry.value;
    }

    const metadata = {
        wvd: {
            device_type: device.type,
            security_level: device.securityLevel
        },
        client_info: clientInfo,
        capabilities: device.clientIdMessage.clientCapabilities || {}
    };

    fs.writeFileSync(path.join(outPath, 'metadata.yml'), YAML.stringify(metadata), 'utf8');
    console.info('Exported Device Metadata as metadata.yml');

    if (device.privateKey) {
        const keyObj = crypto.createPrivateKey({
            key: device.privateKey,
            format: 'der',
            type: 'pkcs1'
        });

        fs.writeFileSync(path.join(outPath, 'private_key.pem'), keyObj.export({ format: 'pem', type: 'pkcs1' }));
        fs.writeFileSync(path.join(outPath, 'private_key.der'), keyObj.export({ format: 'der', type: 'pkcs1' }));
        console.info('Exported Private Key as private_key.der and private_key.pem');
    } else {
        console.warn('No Private Key available');
    }

    if (device.clientId) {
        fs.writeFileSync(path.join(outPath, 'client_id.bin'), device.clientId);
        console.info('Exported Client ID as client_id.bin');
    } else {
        console.warn('No Client ID available');
    }

    if (device.clientIdMessage.vmpData && device.clientIdMessage.vmpData.length) {
        fs.writeFileSync(path.join(outPath, 'vmp.bin'), Buffer.from(device.clientIdMessage.vmpData));
        console.info('Exported VMP (File Hashes) as vmp.bin');
    } else {
        console.info('No VMP (File Hashes) available');
    }
}

async function commandMigrate(args) {
    const [targetPath] = args;
    if (!targetPath) {
        throw new Error('migrate requires <path_to_wvd_or_dir>');
    }
    if (!fs.existsSync(targetPath)) {
        throw new Error(`path: '${targetPath}' does not exist.`);
    }

    const stat = fs.statSync(targetPath);
    const devices = stat.isDirectory()
        ? fs.readdirSync(targetPath).filter((name) => name.endsWith('.wvd')).map((name) => path.join(targetPath, name))
        : [targetPath];

    let migrated = 0;
    for (const devicePath of devices) {
        const name = path.basename(devicePath);
        console.info(`Migrating ${name}...`);
        try {
            const migratedDevice = Device.migrate(fs.readFileSync(devicePath));
            migratedDevice.dump(devicePath);
            console.info(' + Success');
            migrated += 1;
        } catch (error) {
            console.error(` - ${error.message}`);
        }
    }

    console.info(`Migrated ${migrated}/${devices.length} devices!`);
}

async function commandServe(args, options) {
    const [configPath] = args;
    if (!configPath) {
        throw new Error('serve requires <config_path>');
    }
    ensureFileExists(configPath, 'config_path');

    const host = String(options['--host'] || '127.0.0.1');
    const port = Number(options['--port'] || 8786);

    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    const server = startServe({ host, port, config });

    console.info(`Serving on http://${host}:${port}`);
    console.info('Note: JS serve implementation is lightweight and not full pywidevine parity.');

    await new Promise((resolve) => {
        server.on('close', resolve);
    });
}

async function main() {
    const { positional, options } = parseFlags(process.argv.slice(2));

    const debug = Boolean(options['--debug']);
    if (debug) {
        process.env.DEBUG = '1';
    }

    printHeader();

    if (options['--version']) {
        return;
    }

    const [command, ...args] = positional;
    if (!command) {
        usage();
        return;
    }

    if (command === 'license') {
        await commandLicense(args, options);
        return;
    }
    if (command === 'test') {
        await commandTest(args, options);
        return;
    }
    if (command === 'create-device') {
        await commandCreateDevice(args, options);
        return;
    }
    if (command === 'export-device') {
        await commandExportDevice(args, options);
        return;
    }
    if (command === 'migrate') {
        await commandMigrate(args, options);
        return;
    }
    if (command === 'serve') {
        await commandServe(args, options);
        return;
    }

    usage();
    throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
