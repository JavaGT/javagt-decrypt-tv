# Backend/CLI Extensible Architecture

This folder provides a best-practice structure for reusing streaming workflows
across CLI, HTTP API, workers, and future interfaces.

## Layers

- `contracts/`: provider interface contracts.
- `providers/`: service-specific plugins (`tvnz-provider.mjs`).
- `application/`: orchestration (`media-service.mjs`).
- `adapters/`: delivery channels (`cli.mjs`, `http-server.mjs`).

## Recommended Public Entry Points

- `src/adapters/module.mjs` as the primary programmatic interface.
- `src/app.mjs` for lower-level app/runtime composition.
- `src/adapters/cli.mjs` for CLI usage.
- `src/adapters/http-server.mjs` for embedding an HTTP backend.

## Provider Contract

Each provider implements:

- `id`
- `supports(inputUrl)`
- `execute(inputUrl, context)`
- `inspect(inputUrl, context)`

## Add a New Service

1. Create a provider class in `providers/`.
2. Implement the provider contract.
3. Register it in the module adapter instance.

Minimal provider example:

```js
import { MediaProvider } from '../contracts/provider.mjs';

export class MyProvider extends MediaProvider {
  get id() {
    return 'my-service';
  }

  supports(inputUrl) {
    return inputUrl.includes('my-service.example');
  }

  async execute(inputUrl, context) {
    return {
      provider: this.id,
      inputUrl,
      success: true,
      artifacts: { context }
    };
  }
}
```

## Module Adapter (Primary)

The module adapter is an instance of a class. It starts with no registered
providers by design.

```js
import decryptModule from 'tvnz-decrypt/module';

decryptModule.registerDefaultProviders();

const report = await decryptModule.listFormats(
  'https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50',
  { format: 'bestvideo+bestaudio', retentionLevel: 'safe' }
);

const result = await decryptModule.run(
  'https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50',
  { output: 'my_output' }
);
```

Register a custom provider from another module:

```js
import decryptModule from 'tvnz-decrypt/module';
import CustomProvider from './providers/custom-provider.mjs';

decryptModule.registerProvider(CustomProvider);
```

## Library Usage

```js
import { createApp } from './src/app.mjs';

const app = createApp();
const result = await app.run('https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50', {
  downloadsPath: './downloads',
  devicePath: './device.wvd'
});
```

To inspect a page URL through the lower-level app interface, call:

```js
const report = await app.inspect('https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50');
```

## Run CLI Adapter

```bash
tvnz-decrypt [OPTIONS] <url>
```

Or with scripts:

```bash
npm run cli -- <url>
```

### TVNZ Authentication

TVNZ now uses OTP-based authentication. See [TVNZ-PROVIDER.md](./docs/TVNZ-PROVIDER.md) for:
- Session token extraction from browser
- OTP authentication flow
- Environment variable setup

Useful flags:

- `-F` / `--list-formats` to show available tracks.
- `-f` / `--format` to choose a download format expression.
- `-J` / `--dump-json` to print the resolved metadata as JSON.
- `-o` / `--output` to override the output base name.
- `-P` / `--downloads-path` to override the download directory.
- `--provider-id` to explicitly select a provider.
- `--device-path` to override the device path.
- `--write-info-json` to write a sidecar info JSON file.
- `--no-mtime` to keep timestamp preservation disabled, matching the current Node pipeline.
- `--retention-level safe|debug|forensic` to control redaction and artifact depth.

Retention artifacts now include:

- `parsed/run_manifest.json` for run-level metadata.
- `parsed/timings.json` for resolve/download/mux timings (download runs).
- `parsed/selected_tracks.json` for chosen track IDs and stream details (download runs).
- `parsed/output_files.json` for output file existence and size (download runs).

## Downloader Module

- Downloads now run through the Node-native module in `src/n3u8dl-node/`.
- The flow is modular: resolve tracks, obtain data, decrypt, then optional mux.
- The main CLI (`src/adapters/cli.mjs`) remains the single command-line interface.

## Run HTTP Adapter

Example usage in Node REPL/script:

```js
import { createHttpServer } from './src/app.mjs';

const app = createHttpServer({ host: '127.0.0.1', port: 3099 });
await app.start();
```

## File Layout Notes

- `src/providers/` contains provider-owned service workflows (TVNZ, ThreeNow).
- `src/infra/` contains reusable runtime helpers shared by providers.
- `src/` contains the clean public API for external consumers.

POST `/run` payload:

```json
{
  "inputUrl": "https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50",
  "downloadsPath": "./downloads",
  "devicePath": "./device.wvd"
}
```

POST `/inspect` payload:

```json
{
  "inputUrl": "https://www.tvnz.co.nz/shows/te-karere/episodes/s2026-e50",
  "downloadsPath": "./downloads",
  "devicePath": "./device.wvd"
}
```
