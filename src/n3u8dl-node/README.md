# Node Downloader Module

This module provides a Node.js-native media downloader pipeline intended to be
called as a reusable module from provider workflows.

## Current Feature Scope

- Accepts downloader args used by this project.
- Parses DASH MPD manifests with `SegmentTemplate` support.
- Parses HLS master/media playlists and selects variant/audio tracks.
- Selects best/worst video and audio representations.
- Downloads subtitle tracks when they are present in the manifest.
- Downloads init + media segments with retry and concurrency.
- Concatenates segment parts into local video/audio files.
- Optional decryption through `mp4decrypt` if keys are provided.
- Optional muxing through `ffmpeg` into `mkv`/`mp4`.

## Important Notes

- Core fetching/planning/segment handling is pure Node.js.
- Decryption and muxing are delegated to external tools when needed:
  - `mp4decrypt` (or `MP4DECRYPT_PATH`)
  - `ffmpeg` (or `FFMPEG_PATH`)
- Supports DASH + `SegmentTemplate` and clear (non-encrypted) HLS playlists.
- Encrypted HLS tags (`#EXT-X-KEY`) are currently not supported.

## Selector Expressions

The module accepts richer selector expressions used by this project.

- Basic: `best`, `worst`, `all`, `best2`, `worst3`
- Filtered: `lang=en:for=best`, `res=1920x1080:for=best`, `codecs=hvc1`
- Bandwidth: `bwMin=800:bwMax=2000:for=best`

Supported selector args:

- `--select-video` / `-sv`
- `--select-audio` / `-sa`
- `--select-subtitle` / `-ss`

## Module Usage (Modular Pipeline)

```js
import {
  inspectUrl,
  downloadSelection
} from 'tvnz-decrypt/n3u8dl-node';

const report = await inspectUrl('<manifest-url>');

// show report.tracks.video / report.tracks.audio / report.tracks.subtitles
console.log(report);

const result = await downloadSelection(report, {
  videoIds: [report.defaultSelection.videoIds[0]],
  audioIds: [report.defaultSelection.audioIds[0]],
  subtitleIds: report.defaultSelection.subtitleIds
}, {
  saveDir: './downloads',
  saveName: 'my_output',
  keys: ['<kid:key>']
});

// result.downloadedPaths.videoPath
// result.downloadedPaths.audioPath
// result.downloadedPaths.subtitlePaths
```

Shortcuts:

```js
import { inspectUrls, inspectAndDownload } from 'tvnz-decrypt/n3u8dl-node';

const reports = await inspectUrls(['<url1>', '<url2>']);
const result = await inspectAndDownload('<manifest-url>', {
  videoIds: ['<id>']
});
```

## Simple Developer Pattern

1. Call `inspectUrl(url)`.
2. Read `report.tracks`.
3. Pick the ids you want.
4. Call `downloadSelection(report, selection, options)`.
5. Combine files yourself if needed.

If you already have a manifest or playlist URL, this module can inspect it
directly.

If you start with a TVNZ or ThreeNow page URL, use the root app layer instead:

```js
import { inspectMediaUrl } from 'tvnz-decrypt/app';

const report = await inspectMediaUrl('<page-url>');
```

The provider resolver is transparent there, so the report you get back is still
manifest-backed and ready for `downloadSelection()`.
