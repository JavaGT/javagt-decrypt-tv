import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliUsageText, parseCliArgs } from '../src/adapters/cli-args.mjs';

test('parseCliArgs parses inspect and url positional', () => {
    const argv = ['node', 'cli.mjs', '-F', 'https://example.test/page'];
    const parsed = parseCliArgs(argv);

    assert.equal(parsed.options.inspect, true);
    assert.deepEqual(parsed.positionals, ['https://example.test/page']);
});

test('parseCliArgs parses key/value options', () => {
    const argv = [
        'node',
        'cli.mjs',
        '--downloads-path', 'downloads',
        '--provider-id', 'threenow',
        '--device-path', './device.wvd',
        '--retention-level', 'debug',
        '-o', 'custom',
        'https://example.test/page'
    ];

    const parsed = parseCliArgs(argv);

    assert.equal(parsed.options.downloadsPath, 'downloads');
    assert.equal(parsed.options.providerId, 'threenow');
    assert.equal(parsed.options.devicePath, './device.wvd');
    assert.equal(parsed.options.retentionLevel, 'debug');
    assert.equal(parsed.options.output, 'custom');
    assert.deepEqual(parsed.positionals, ['https://example.test/page']);
});

test('parseCliArgs throws on missing value', () => {
    const argv = ['node', 'cli.mjs', '--device-path'];
    assert.throws(() => parseCliArgs(argv), /Missing value for --device-path/);
});

test('parseCliArgs throws on unknown flag', () => {
    const argv = ['node', 'cli.mjs', '--unknown'];
    assert.throws(() => parseCliArgs(argv), /Unknown option: --unknown/);
});

test('getCliUsageText includes key options', () => {
    const text = getCliUsageText();
    assert.match(text, /--downloads-path/);
    assert.match(text, /--provider-id/);
    assert.match(text, /--device-path/);
});
