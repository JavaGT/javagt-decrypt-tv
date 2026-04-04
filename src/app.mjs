import createHttpServerAdapter from './adapters/http-server.mjs';
import moduleAdapter, { DecryptModuleAdapter } from './adapters/module.mjs';

export function createModule(options = {}) {
    return new DecryptModuleAdapter(options);
}

export function createModuleWithDefaultProviders(options = {}) {
    return DecryptModuleAdapter.createWithDefaultProviders(options);
}

function resolveModuleAdapter(options = {}) {
    return options.moduleAdapter || createModuleWithDefaultProviders(options.moduleOptions || {});
}

export async function inspectMediaUrl(inputUrl, options = {}) {
    const adapter = resolveModuleAdapter(options);
    const { moduleAdapter: _ignoredAdapter, moduleOptions: _ignoredModuleOptions, ...inspectOptions } = options;
    return adapter.inspect(inputUrl, inspectOptions);
}

export function createHttpServer(options = {}) {
    const adapter = resolveModuleAdapter(options);
    return createHttpServerAdapter({
        host: options.host,
        port: options.port,
        service: adapter.service
    });
}

export function createApp(options = {}) {
    const adapter = resolveModuleAdapter(options);

    return {
        moduleAdapter: adapter,
        inspect: (inputUrl, inspectOptions = {}) => adapter.inspect(inputUrl, inspectOptions),
        run: (inputUrl, runOptions = {}) => adapter.run(inputUrl, runOptions),
        createHttpServer: (serverOptions = {}) => createHttpServer({
            ...serverOptions,
            moduleAdapter: adapter
        })
    };
}

export { moduleAdapter, DecryptModuleAdapter };
