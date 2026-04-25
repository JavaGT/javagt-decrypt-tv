# CLAUDE.md — TVNZ Video Download Debug

## System Context

**Project**: `javagt-decrypt-tv` — Video decryption/download tool for NZ streaming services
**Challenge**: HTTP 403 Access Denied on DASH segment downloads from CloudFront CDN; audio track selection; decryption producing shorter output than expected

---

## Current Status (2026-04-25)

### Download is PARTIALLY WORKING
- Video: 123 segments (733s / ~12 min) from `/content/pubcontent/` Period 2 path ✅
- Audio: 123 segments (733s / ~12 min) from `/content/pubcontent/` Period 2 path ✅ (FIXED)
- Decrypt: `mp4decrypt` runs, produces output file ✅
- Merge: `ffmpeg` produces 314MB MKV ✅
- **PROBLEM**: Output duration is ~12 min, NOT the full ~87 min expected from MPD
- **The 303MB encrypted file contains ALL the content (~733s from 123 segments), but decryption/merge is truncating to 12 min**

### Retention artifacts
- `./downloads/_tvnz_retention/20260425_085320_https___www.tvnz.co.nz_player_tvepisode_australian-survivor-redemption-9/`
- `./downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.work/` (work directory)
- `./downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.mkv` (final output, 314MB, ~12min duration but encrypted file is 303MB for 733s of content)

---

## Architecture

```
URL: https://www.tvnz.co.nz/player/tvepisode/australian-survivor-redemption-9
  │
  ├─> Content Authorization (Edge API)
  │     URL: https://watch-cdn.edge-api.tvnz.co.nz/media/content/authorize
  │     Returns: contentUrl, mtSessionUrl, playerParams, licenseUrl, heartbeatToken
  │
  ├─> SSAI Session Creation
  │     URL: POST to mtSessionUrl
  │     Returns: manifestUrl with aws.sessionId filled in
  │
  ├─> Manifest Download
  │     URL: SSAI-resolved MPD URL (with aws.sessionId)
  │     Returns: MPD with 29 Periods
  │
  ├─> Track Selection (MUST use /content/pubcontent/ paths)
  │     Period 2 main content: `/content/pubcontent/.../dash/` base URL — no segment gate
  │     Ad periods (3-29): `/tm/` CDN paths — segment range gating, limited segments
  │
  ├─> Segment Download
  │     Period 2 video+audio: /content/pubcontent/ path — segments 0-122 work
  │     Ad periods: /tm/ path — segments limited (1-8 per period)
  │
  ├─> Decryption
  │     mp4decrypt --key {kid}:{key} encrypted.mp4 decrypted.mp4
  │
  └─> Merge
        ffmpeg -i video.decrypted.mp4 -i audio.decrypted.m4a -c copy output.mkv
```

---

## MPD Structure (SSAI multi-period, 29 periods)

### Period Breakdown
| Period | Duration | Start | BaseURL | Content | Segment Count |
|--------|----------|-------|---------|---------|---------------|
| 1 | 15s | PT0S | `/tm/{contentId}/{uuid1}/` | Ad (preroll) | ~7 accessible |
| 2 | 12M13.76S | PT15S | `dash/` (→ `/content/pubcontent/`) | Main content | 123 (video+audio) |
| 3-29 | Various (1-13 min each) | PT12M28.76S+ | `/tm/{contentId}/{uuidN}/` | SSAI ads | 1-8 each (gated) |

### Key Finding: MPD reports 87.7 min but only Period 2 content is accessible
- **mediaPresentationDuration**: `PT1H27M42.41S` (5262.41 seconds)
- Period 2 is the main content (12M13.76S = 733.76 seconds)
- Ad periods (3-29) fill the remaining 4529 seconds (75.5 minutes)
- **Ad period `/tm/` paths have segment gating** — only 1-8 segments accessible
- **Main content IS accessible** via `/content/pubcontent/` path (Period 2, 123 segments)

### Selected Tracks (After Fix)
- **Video**: `video=4000000`, 1080p, baseUrl: `/content/pubcontent/.../dash/`, 123 segments (0-439200 time)
- **Audio**: `audio_eng=128000`, 128kbps, baseUrl: `/content/pubcontent/.../dash/`, 123 segments (768-35136256 time)

---

## Key Files & Roles

| File | Role |
|------|------|
| `src/infra/tvnz-auth.mjs` | OTP auth, device registration, SSAI session creation |
| `src/infra/tvnz-session.mjs` | Session management, credential loading |
| `src/providers/tvnz-provider.mjs` | Main TVNZ API provider, content authorization |
| `src/n3u8dl-node/lib/mpd-parser.mjs` | MPD parsing, segment URL construction, track selection |
| `src/n3u8dl-node/lib/downloader.mjs` | Segment download, decryption, merge orchestration |
| `src/n3u8dl-node/lib/downloader-utils.mjs` | `fetchBuffer()`, query param utilities |
| `src/infra/http-client.mjs` | HTTP utilities |
| `src/application/media-pipeline.mjs` | Download plan building and execution |

---

## Bugs Found & Fixed

### Bug 1: MPD parser only processed Period 1 (FIXED 2026-04-25)
- **File**: `src/n3u8dl-node/lib/mpd-parser.mjs` line ~176
- **Before**: `const periodNode = periods[0]` — only processed first period
- **After**: `for (const periodNode of periods)` — iterates all 29 periods
- **Effect**: Parser now finds 174 video + 58 audio representations across all periods

### Bug 2: Score function preferred `/tm/` CDN over `/content/pubcontent/` origin (FIXED 2026-04-25)
- **File**: `src/n3u8dl-node/lib/mpd-parser.mjs` `scoreRepresentation()` function
- **Before**: Only video tracks got `tmPenalty`; audio tracks selected `/tm/` path (bandwidth tie-break)
- **After**: Both video AND audio get `tmPenalty` — prefer `/content/pubcontent/` origin path
- **Effect**: Now correctly picks Period 2 `/content/pubcontent/` paths (123 segments) over Period 1 `/tm/` (1 segment)

### Bug 3: downloadSubtitleTrack fetched directory URL for DASH subtitles (FIXED 2026-04-25)
- **File**: `src/n3u8dl-node/lib/downloader.mjs` `downloadSubtitleTrack()` function
- **Bug**: DASH text AdaptationSets have `subtitleUrl = baseUrl` (directory path, not file)
- **Effect**: `fetchTextWithRetry()` on directory URL returns HTTP 400
- **Fix**: Skip subtitle tracks where subtitleUrl is a directory (no `$Time$`/`$Number$` patterns, no file extension)
- **Note**: DASH subtitle extraction requires SegmentTimeline parsing — not yet implemented

---

## Critical Data Values

### Known Working Credentials (from tvnz-session.json)
```json
{
  "accessToken": "eyJ0eXAiOiJKV1Qi...",
  "refreshToken": "xDbX-Dr9i-GD4F-kCd0-QKVj-MSWW-F1",
  "oAuthToken": "eyJhbGciOiJSUzI1NiIs...",
  "xAuthToken": "eyJlbmMiOiJBMjU2R0NNIi...",
  "deviceref": "51ff1fd0-1b45-4803-b600-79bf87844b6b",
  "deviceSecret": "gkQyrjQpw/drjiYcZcDcLf4vVyl5uZQD9UwJU+Mz8+E=",
  "deviceId": "51ff1fd0-1b45-4803-b600-79bf87844b6b"
}
```

### Content Authorization Response
```
contentId: A969BB27-C770-47A0-B343-AC4D4B3CEB93
contentUrl: https://vod-origin-cdn.cms-api.tvnz.co.nz/v1/dash/2e46731c605e6f89d6a86e61608131eee280356f/vod/content/pubcontent/vol/A969BB27-C770-47A0-B343-AC4D4B3CEB93/1776823204805-output_cenc_dash_dref.ism/index.mpd?filter=...&python_pipeline_config=ttml_removal&suppress_query_parameters&ads...
licenseUrl: https://widevine-proxy-cdn.edge-api.tvnz.co.nz/getlicense?service=tvnz&...
PSSH: AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADwIARIQqWm7J8dwR6CzQ6xNSzzrkxqHVNwbC1jZW5jIhhxV203Sjhkd1I2Q3pRNnhOU3p6cmt3PT0qADIA
KEY: a969bb27c77047a0b343ac4d4b3ceb93:62a5716b468f5906753f808431b9622e
```

### SSAI Session Response
```
manifestUrl: /v1/dash/{contentId}/vod/.../index.mpd?filter=...&python_pipeline_config=ttml_removal&suppress_query_parameters&aws.sessionId={uuid}
```

---

## Debugging Findings

### Finding 1: `/tm/` CDN path has segment range gating
- **Period 1 `/tm/` path**: Segments 1-7 accessible, 8+ return HTTP 403
- **Ad period `/tm/` paths**: Segments 1-8 accessible (varies by period)
- **Period 2 `/content/pubcontent/` path**: All 123 segments accessible (0-439200 time)
- **Root cause**: CloudFront CDN pre-caches only early segments from `/tm/` paths

### Finding 2: aws.sessionId does NOT cause 403
- Segment URLs with `?filter=...&aws.sessionId=...` work the same as without params
- The 403 is CDN-enforced segment availability, not auth rejection

### Finding 3: Score function now correctly picks `/content/pubcontent/` for both video and audio
- **Before fix**: Audio picked `/tm/` path (1 segment), video picked `/content/pubcontent/` (123 segments)
- **After fix**: Both pick `/content/pubcontent/` (123 segments each)

### Finding 4: Encrypted video file (303MB) contains full content but decrypt/merge truncates
- **Encrypted video**: 303MB, contains 123 segments worth of data
- **Decrypted video**: 303MB, same size as encrypted (encrypted in-place or same content)
- **Final MKV**: 314MB, but only ~12 min duration (733s) in moov box
- **Problem**: The decrypted output should be ~733s but moov box reports correct duration yet playback stops at 12 min
- **Hypothesis**: mp4decrypt may not be properly decrypting all samples, or ffmpeg merge is truncating

### Finding 5: Ad periods (3-29) use gated `/tm/` paths with limited segments
- Each ad period has 1-8 segments accessible from its `/tm/` path
- No alternative `/content/pubcontent/` path for ad period content
- **This means full episode with ads cannot be downloaded completely**

---

## Test Commands

```bash
# Run the full download
node src/adapters/cli.mjs "https://www.tvnz.co.nz/player/tvepisode/australian-survivor-redemption-9"

# Test segment availability at various time points
node --input-type=module << 'EOF'
import { fetchBuffer } from './src/n3u8dl-node/lib/downloader-utils.mjs';
const base = 'https://vod-origin-cdn.cms-api.tvnz.co.nz/content/pubcontent/vol/A969BB27-C770-47A0-B343-AC4D4B3CEB93/1776823204805-output_cenc_dash_dref.ism/dash/';
for (const t of [0, 3600, 216000, 439200]) {
  const url = base + '1776823204805-output_cenc_dash_dref-video=4000000-' + t + '.dash';
  try {
    const buf = await fetchBuffer(url, { timeoutMs: 8000, retries: 1, headers: {'User-Agent': 'Mozilla/5.0'}});
    console.log('Time', t, '- OK,', buf.length, 'bytes');
  } catch (e) {
    console.log('Time', t, '- FAIL:', e.message.slice(0, 60));
  }
}
EOF

# Check decrypted video duration
ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1 downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.work/video.decrypted.mp4

# Check final MKV duration
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.mkv

# Count output frames
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1 downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.mkv
```

---

## Open Issues

### HIGH PRIORITY: Decrypt/Merge producing truncated output
- Encrypted video (303MB) contains full ~733s of content (123 segments)
- But final MKV is 314MB with only 18344 frames (~12 min at 25fps)
- **The 303MB encrypted file IS the full content** (confirmed by file size matching 123 segments)
- **Something in decrypt or merge is losing most of the content**

### MEDIUM PRIORITY: Ad periods not downloadable
- Periods 3-29 (SSAI ads) use gated `/tm/` paths
- Only 1-8 segments accessible per ad period
- No `/content/pubcontent/` alternative exists for these periods
- Full episode with proper ad breaks cannot be reconstructed from downloaded segments

### LOW PRIORITY: Subtitle extraction not implemented
- DASH subtitles use SegmentTimeline (not direct file URLs)
- Current code skips subtitle tracks
- Would need SegmentTimeline parsing to extract subtitle segments

---

## Notes for Agents

- **ALWAYS** use `/content/pubcontent/` path for main content (Period 2) — no segment gating
- **NEVER** assume `/tm/` paths have all segments — they have segment range gating (1-8 accessible)
- **DO NOT** add aws.sessionId to segment URLs — it does not help with 403 errors
- **When debugging 403 errors**: test multiple segments (1, 5, 10, 15, 20) to find the gate boundary
- **Score function fix**: Both video AND audio tracks must get `tmPenalty` to avoid selecting gated `/tm/` paths
- **Encrypted file size**: A 303MB encrypted file likely contains full content — check segment count, not just file size
- **mp4decrypt**: Verify it's properly decrypting (not just copying encrypted data as decrypted output)

---

## Data File Locations

| Data | Location |
|------|----------|
| Session tokens | `./downloads/tvnz-session.json` |
| Latest retention | `./downloads/_tvnz_retention/20260425_085320_https___www.tvnz.co.nz_player_tvepisode_australian-survivor-redemption-9/` |
| Content auth response | `{retention}/parsed/content_authorize_response.json` |
| Download plan | `{retention}/parsed/download_plan.json` |
| Raw MPD manifest | `{retention}/raw/manifest.mpd` |
| Decryption keys | `{retention}/parsed/decryption_keys.json` |
| Download work dir | `./downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.work/` |
| Final output | `./downloads/content.1080p.TVNZ.WEB-DL.AAC2.0.H.264.mkv` |

---

*Machine-readable — update as findings change. All agents should maintain this document when working on this codebase.*