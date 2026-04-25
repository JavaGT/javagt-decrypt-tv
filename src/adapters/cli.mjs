#!/usr/bin/env node
import moduleAdapter from './module.mjs';
import { getCliUsageText, parseCliArgs } from './cli-args.mjs';
import { presentTracks } from './cli-presenter.mjs';
import { ensureEnvironmentLoaded } from '../infra/env-bootstrap.mjs';
import { buildModuleRequestOptions } from '../infra/module-request-options.mjs';

function usage() {
    console.log(getCliUsageText());
}

function ensureBuiltinProviders() {
    if (moduleAdapter.listProviders().length === 0) {
        moduleAdapter.registerDefaultProviders();
    }
}

async function main() {
    ensureEnvironmentLoaded();
    const { positionals, options } = parseCliArgs(process.argv);

    if (options.help) {
        usage();
        return;
    }

    const [inputUrl] = positionals;

    if (!inputUrl) {
        usage();
        process.exit(1);
    }

    const inspectOnly = Boolean(options.inspect || options.dumpJson || options.writeInfoJson);

    ensureBuiltinProviders();

    const requestOptions = buildModuleRequestOptions(options);

    if (inspectOnly) {
        if (options.writeInfoJson) {
            await moduleAdapter.writeInfoJson(inputUrl, requestOptions);
        }

        if (options.dumpJson) {
            console.log(await moduleAdapter.dumpJson(inputUrl, requestOptions));
            return;
        }

        if (options.inspect) {
            const inspectResult = await moduleAdapter.inspect(inputUrl, requestOptions);
            presentTracks(inspectResult);
        }
        return;
    }

    const result = options.writeInfoJson
        ? (await moduleAdapter.runWithInfoJson(inputUrl, requestOptions)).result
        : await moduleAdapter.run(inputUrl, requestOptions);

    console.log(`${result.provider}: ${result.message || 'ok'}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
