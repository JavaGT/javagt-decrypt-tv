import { takeOptionValue } from '../infra/arg-utils.mjs';

export function getCliUsageText() {
    return [
        'Usage: tvnz-decrypt [OPTIONS] <url>',
        '',
        'Options:',
        '  -F, --list-formats          Show available tracks for the URL',
        '  -f, --format <expr>         Select download formats',
        '  -J, --dump-json             Print the resolved metadata as JSON',
        '  -o, --output <name>         Output file base name',
        '  -P, --downloads-path <dir>  Download directory',
        '      --write-info-json       Write a sidecar info JSON file',
        '      --no-mtime              Do not preserve file timestamps',
        '      --retention-level <lvl> Retention policy: safe|debug|forensic',
        '  --credentials <value>       Provider credentials override',
        '  --provider-id <id>          Provider override',
        '  --device-path <path>        Device file path',
        '  --help                      Show help'
    ].join('\n');
}

export function parseCliArgs(argv) {
    const positionals = [];
    const options = {};

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];

        if (token === '--help' || token === '-h') {
            options.help = true;
            continue;
        }

        if (token === '--inspect' || token === '-F' || token === '--list-formats') {
            options.inspect = true;
            continue;
        }

        if (token === '-J' || token === '--dump-json') {
            options.dumpJson = true;
            continue;
        }

        if (token === '--write-info-json') {
            options.writeInfoJson = true;
            continue;
        }

        if (token === '--no-mtime') {
            options.noMtime = true;
            continue;
        }

        if (token === '-f' || token === '--format') {
            const value = takeOptionValue(argv, i, token);
            options.format = value;
            i += 1;
            continue;
        }

        if (token === '-o' || token === '--output' || token === '-P' || token === '--downloads-path' || token === '--credentials' || token === '--provider-id' || token === '--device-path' || token === '--retention-level') {
            const key = token === '-o'
                ? 'output'
                : token === '-P'
                    ? 'downloadsPath'
                    : token === '--downloads-path'
                        ? 'downloadsPath'
                        : token === '--provider-id'
                            ? 'providerId'
                            : token === '--device-path'
                                ? 'devicePath'
                                : token === '--retention-level'
                                    ? 'retentionLevel'
                                    : token.slice(2);
            const value = takeOptionValue(argv, i, token);
            options[key] = value;
            i += 1;
            continue;
        }

        if (token.startsWith('-')) {
            throw new Error(`Unknown option: ${token}`);
        }

        positionals.push(token);
    }

    return { positionals, options };
}

export default {
    getCliUsageText,
    parseCliArgs
};
