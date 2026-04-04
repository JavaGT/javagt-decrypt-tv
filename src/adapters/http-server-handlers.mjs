import { buildModuleRequestOptions } from '../infra/module-request-options.mjs';

export function buildRunRequest(body = {}) {
    const resolved = buildModuleRequestOptions({
        downloadsPath: body.downloadsPath,
        devicePath: body.devicePath,
        providerId: body.providerId,
        credentials: body.credentials
    });

    return {
        inputUrl: body.inputUrl,
        downloadsPath: resolved.downloadsPath,
        wvdDevicePath: resolved.devicePath,
        credentials: resolved.credentials,
        providerId: resolved.providerId,
        options: body.options || {}
    };
}

export function buildInspectRequest(body = {}) {
    return buildRunRequest(body);
}

export async function executeServiceAction({ service, action, rawBody }) {
    let body;
    try {
        body = JSON.parse(rawBody || '{}');
    } catch {
        return {
            statusCode: 400,
            payload: { error: 'Invalid JSON body' }
        };
    }

    try {
        const request = action === 'run' ? buildRunRequest(body) : buildInspectRequest(body);
        const result = action === 'run'
            ? await service.run(request)
            : await service.inspect(request);

        return {
            statusCode: 200,
            payload: result
        };
    } catch (error) {
        return {
            statusCode: 400,
            payload: { error: error.message }
        };
    }
}

export default {
    buildRunRequest,
    buildInspectRequest,
    executeServiceAction
};
