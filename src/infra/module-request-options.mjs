export function buildModuleRequestOptions(rawOptions = {}) {
    return {
        downloadsPath: rawOptions.downloadsPath || './downloads',
        devicePath: rawOptions.devicePath || './device.wvd',
        providerId: rawOptions.providerId,
        credentials: rawOptions.credentials,
        retentionLevel: rawOptions.retentionLevel,
        format: rawOptions.format,
        output: rawOptions.output,
        noMtime: Boolean(rawOptions.noMtime),
        email: rawOptions.email
    };
}

export default {
    buildModuleRequestOptions
};
