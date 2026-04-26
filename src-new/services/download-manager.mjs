/**
 * Download manager - orchestrates full download pipeline.
 * Coordinates auth → manifest → download → decrypt → merge.
 */

import { DownloadError, DecryptionError, MergeError } from '../errors/index.mjs'
import { createProvider, registerProvider } from '../providers/index.mjs'
import { BrightcoveProvider } from '../providers/brightcove-provider.mjs'
import { TvnzProvider } from '../providers/tvnz-provider.mjs'
import { TvnzAuth } from '../auth/tvnz-auth.mjs'
import { HttpClient } from '../utils/http-client.mjs'
import { ManifestParser } from '../services/manifest-parser/index.mjs'
import { SegmentDownloader } from '../services/segment-downloader.mjs'
import { Decryptor } from '../services/decryptor.mjs'
import { Merger } from '../services/merger.mjs'

// Register built-in providers
registerProvider(BrightcoveProvider)
registerProvider(TvnzProvider)

export class DownloadManager {
  /**
   * @param {Object} config
   * @param {Object} deps
   * @param {HttpClient} [deps.httpClient]
   * @param {ManifestParser} [deps.manifestParser]
   * @param {SegmentDownloader} [deps.downloader]
   * @param {Decryptor} [deps.decryptor]
   * @param {Merger} [deps.merger]
   * @param {Object} [deps.authManager]
   */
  constructor(config, deps = {}) {
    this.config = config
    this.outputDir = config.outputDir ?? './downloads'
    this.verbose = config.verbose ?? false

    // Services
    this.httpClient = deps.httpClient ?? new HttpClient({
      timeout: config.http?.timeout,
      retries: config.http?.retries,
    })
    this.manifestParser = deps.manifestParser ?? new ManifestParser()
    this.downloader = deps.downloader ?? new SegmentDownloader(config, this.httpClient)
    this.decryptor = deps.decryptor ?? new Decryptor({ binaryPath: config.decryptor?.binaryPath })
    this.merger = deps.merger ?? new Merger({ ffmpegPath: config.merger?.ffmpegPath })

    // State
    this._provider = null
    this._authManager = null
    this._eventHandlers = {}
  }

  /**
   * Register an event handler.
   * @param {string} event - 'progress', 'error', 'complete', 'download'
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._eventHandlers[event]) {
      this._eventHandlers[event] = []
    }
    this._eventHandlers[event].push(callback)
  }

  /**
   * Emit an event.
   * @param {string} event
   * @param {Object} data
   */
  _emit(event, data) {
    const handlers = this._eventHandlers[event] || []
    for (const handler of handlers) {
      try {
        handler(data)
      } catch (e) {
        this._log('error', `Event handler error: ${e.message}`)
      }
    }
  }

  _log(level, ...args) {
    if (this.verbose || level === 'error') {
      console.log(`[${level.toUpperCase()}]`, ...args)
    }
  }

  /**
   * Inspect a URL and return info without downloading.
   * @param {string} url
   * @param {Object} [options]
   * @returns {Promise<Object>} Video info
   */
  async inspect(url, options = {}) {
    console.log('[INSPECT] Inspecting URL:', url)

    // Step 1: Setup provider
    const provider = await this._setupProvider(url, options)
    this._provider = provider

    // Step 2: Authorize content
    const auth = await provider.authorizeContent(url)
    console.log('[INSPECT] Authorization successful')

    // Step 3: Get manifest
    const manifest = await provider.getManifest(auth.contentUrl)
    console.log('[INSPECT] Manifest parsed, periods:', manifest.periods?.length)

    // Step 4: Get all representations
    const allReprs = this.manifestParser.getRepresentations(manifest)
    console.log('[INSPECT] Total representations:', allReprs.length)

    const videoTracks = allReprs.filter(r => r.contentType === 'video')
    const audioTracks = allReprs.filter(r => r.contentType === 'audio')

    // Group audio by language+role
    const audioByLangRole = {}
    for (const t of audioTracks) {
      const key = `${t.lang || 'und'}:${t.role || ''}`
      if (!audioByLangRole[key]) audioByLangRole[key] = []
      audioByLangRole[key].push(t)
    }

    return {
      url,
      provider: provider.constructor.name,
      title: auth.contentId || 'Unknown',
      duration: manifest.mediaPresentationDuration,
      periodCount: manifest.periods?.length,
      videoTracks,
      audioTracks,
      audioVarieties: Object.keys(audioByLangRole).length,
      auth: {
        contentUrl: auth.contentUrl,
        licenseUrl: auth.licenseUrl,
        pssh: auth.pssh,
      },
    }
  }

  /**
   * Download all episodes from a series/season URL.
   * @param {string} seriesUrl - TVNZ series URL (e.g., https://www.tvnz.co.nz/tvseries/bluey)
   * @param {Object} [options]
   * @param {string} [options.seasonId] - Optional season ID to download only that season
   * @param {string} [options.outputTemplate] - Output filename template with %(title)s, %(season)s, %(episode)s, etc.
   * @returns {Promise<Array<string>>} Array of output file paths
   */
  async downloadSeries(seriesUrl, options = {}) {
    console.log('[SERIES] ========================================')
    console.log('[SERIES] Starting series download')
    console.log('[SERIES] URL:', seriesUrl)
    console.log('[SERIES] Options:', JSON.stringify(options))
    console.log('[SERIES] ========================================')

    // Setup provider
    const provider = await this._setupProvider(seriesUrl, options)

    // Get list of episodes
    console.log('[SERIES] Fetching episode list...')
    const seriesSlug = seriesUrl.match(/\/tvseries\/([^/?#]+)/)?.[1]
    if (!seriesSlug) {
      throw new DownloadError('Invalid series URL format')
    }

    const episodes = await provider.listSeriesEpisodes(seriesSlug, options.seasonId)
    console.log('[SERIES] Found episodes:', episodes.length)

    if (episodes.length === 0) {
      throw new DownloadError('No episodes found in series')
    }

    const results = []
    const template = options.outputTemplate || '%(title)s_S%(season)02d_E%(episode)02d'

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i]
      console.log(`\n[SERIES] [${i + 1}/${episodes.length}] Downloading: ${ep.title}`)

      try {
        // Build output filename from template
        const outputName = template
          .replace('%(title)s', ep.title.replace(/[^a-zA-Z0-9]/g, '_'))
          .replace('%(season)s', String(ep.seasonNumber))
          .replace('%(episode)s', String(ep.episodeNumber))
          .replace('%(season_label)s', ep.seasonLabel.replace(/[^a-zA-Z0-9]/g, '_'))

        const outputPath = `${this.outputDir}/${outputName}.mkv`

        // Download this episode
        const result = await this.download(ep.url, {
          ...options,
          output: outputPath,
        })

        results.push(result)
        console.log(`[SERIES] ✓ Episode ${i + 1}/${episodes.length} complete: ${result}`)
      } catch (error) {
        console.error(`[SERIES] ✗ Episode ${i + 1}/${episodes.length} failed: ${error.message}`)
        if (!options.continueOnError) {
          throw error
        }
      }
    }

    console.log(`\n[SERIES] ========================================`)
    console.log(`[SERIES] Series download complete: ${results.length}/${episodes.length} episodes`)
    console.log(`[SERIES] ========================================`)

    return results
  }

  /**
   * Download and process content from a URL.
   * Full pipeline: authorize → download → decrypt → merge.
   * @param {string} url
   * @param {Object} options
   * @returns {Promise<string>} Output file path
   */
  async download(url, options = {}) {
    console.log('[DOWNLOAD] ========================================')
    console.log('[DOWNLOAD] Starting download pipeline')
    console.log('[DOWNLOAD] URL:', url)
    console.log('[DOWNLOAD] Options:', JSON.stringify(options))
    console.log('[DOWNLOAD] Manual keys:', options.keys?.length ? options.keys : 'none')
    console.log('[DOWNLOAD] ========================================')

    try {
      // Step 1: Setup provider
      console.log('[DOWNLOAD] Step 1: Setting up provider...')
      const provider = await this._setupProvider(url, options)
      this._provider = provider
      console.log('[DOWNLOAD] Provider set up successfully')

      // Step 2: Authorize content
      console.log('[DOWNLOAD] Step 2: Authorizing content...')
      this._emit('progress', { step: 'authorize', status: 'starting', url })
      const auth = await provider.authorizeContent(url)
      this._emit('progress', { step: 'authorize', status: 'complete', auth })
      console.log('[DOWNLOAD] Authorization successful')
      console.log('[DOWNLOAD] contentUrl:', auth.contentUrl?.slice(0, 100))
      console.log('[DOWNLOAD] licenseUrl:', auth.licenseUrl)
      console.log('[DOWNLOAD] pssh:', auth.pssh?.slice(0, 50))
      console.log('[DOWNLOAD] heartbeatToken:', auth.heartbeatToken ? 'present' : 'MISSING')

      // Step 3: Get manifest
      console.log('[DOWNLOAD] Step 3: Fetching manifest...')
      this._emit('progress', { step: 'manifest', status: 'fetching' })
      const manifest = await provider.getManifest(auth.contentUrl)
      this._emit('progress', { step: 'manifest', status: 'complete', periodCount: manifest.periods?.length })
      console.log('[DOWNLOAD] Manifest parsed, periods:', manifest.periods?.length)

      // Step 4: Select representations (video: best, audio: ALL from /content/pubcontent/)
      console.log('[DOWNLOAD] Step 4: Selecting representations...')
      const videoRepr = this.manifestParser.selectRepresentation(manifest, {
        contentType: 'video',
        maxBandwidth: options.maxBandwidth,
        preferPubcontent: true,
      })
      const audioReprs = this.manifestParser.selectAllRepresentations(manifest, {
        contentType: 'audio',
        preferPubcontent: true,
      })

      if (!videoRepr) throw new DownloadError('No video representation found in manifest')
      if (!audioReprs.length) throw new DownloadError('No audio representations found in manifest')

      console.log('[DOWNLOAD] Selected video:', videoRepr.bandwidth, 'bps, id:', videoRepr.id)
      console.log('[DOWNLOAD] Selected audio tracks:', audioReprs.length)
      for (const ar of audioReprs) {
        console.log('[DOWNLOAD]   Audio:', ar.id, '-', ar.bandwidth, 'bps, lang:', ar.lang || 'und')
      }

      // Step 5: Build segment lists for video + all audio tracks
      console.log('[DOWNLOAD] Step 5: Building segment lists...')
      const videoSegments = this.manifestParser.buildSegmentList(manifest, {
        representationId: videoRepr.id,
        baseUrl: videoRepr.baseUrl,
        manifestUrl: auth.contentUrl,
      })
      const audioSegmentsList = audioReprs.map(audioRepr => {
        const segs = this.manifestParser.buildSegmentList(manifest, {
          representationId: audioRepr.id,
          baseUrl: audioRepr.baseUrl,
          manifestUrl: auth.contentUrl,
        })
        return { repr: audioRepr, segments: segs }
      })

      console.log('[DOWNLOAD] Video segments:', videoSegments.length)
      console.log('[DOWNLOAD] Audio tracks:', audioSegmentsList.length)
      for (const { repr, segments } of audioSegmentsList) {
        console.log('[DOWNLOAD]   Audio', repr.id, ':', segments.length, 'segments')
      }

      // Step 6: Create temp dirs for video + each audio track
      console.log('[DOWNLOAD] Step 6: Setting up directories...')
      const { mkdirSync, writeFileSync } = await import('fs')
      const { join } = await import('path')
      const { randomUUID } = await import('crypto')
      const tempBase = join(this.outputDir, 'temp', randomUUID())
      mkdirSync(tempBase, { recursive: true })

      // Set up HAR file logging if DUMP_RAW=true
      if (process.env.DUMP_RAW === 'true') {
        const harPath = join(tempBase, '_raw_http.har')
        this.httpClient.setHarFilePath(harPath)
        console.log('[DOWNLOAD] HAR logging enabled:', harPath)
      }

      const videoDir = join(tempBase, 'video')
      mkdirSync(videoDir, { recursive: true })

      const audioDirs = []
      const audioInitPaths = []
      for (let i = 0; i < audioReprs.length; i++) {
        const audioDir = join(tempBase, `audio_${i}`)
        mkdirSync(audioDir, { recursive: true })
        audioDirs.push(audioDir)
        audioInitPaths.push(null)
      }

      this._emit('progress', { step: 'download', status: 'starting', video: videoSegments.length })

      // Fetch video init segment
      const videoInitUrl = this._buildInitUrl(videoRepr, manifest, auth.contentUrl)
      let videoInitPath = null
      if (videoInitUrl) {
        console.log('[DOWNLOAD] Video init URL:', videoInitUrl)
        videoInitPath = `${videoDir}/init_video.dash`
        try {
          mkdirSync(videoDir, { recursive: true })
          const buf = await this.httpClient.fetchBuffer(videoInitUrl, { timeout: 30000 })
          writeFileSync(videoInitPath, buf)
          console.log('[DOWNLOAD] Video init saved:', buf.length, 'bytes')
        } catch (e) {
          console.log('[DOWNLOAD] Video init fetch failed:', e.message)
          videoInitPath = null
        }
      }

      // Fetch audio init segments for each audio track
      for (let i = 0; i < audioReprs.length; i++) {
        const audioInitUrl = this._buildInitUrl(audioReprs[i], manifest, auth.contentUrl)
        if (audioInitUrl) {
          console.log('[DOWNLOAD] Audio', i, 'init URL:', audioInitUrl)
          const audioInitPath = `${audioDirs[i]}/init_audio.dash`
          try {
            const buf = await this.httpClient.fetchBuffer(audioInitUrl, { timeout: 30000 })
            writeFileSync(audioInitPath, buf)
            audioInitPaths[i] = audioInitPath
            console.log('[DOWNLOAD] Audio', i, 'init saved:', buf.length, 'bytes')
          } catch (e) {
            console.log('[DOWNLOAD] Audio', i, 'init fetch failed:', e.message)
          }
        }
      }

      const onProgress = (p) => this._emit('progress', { step: 'download', ...p })

      // Download video
      console.log('[DOWNLOAD] Downloading video segments...')
      const videoPaths = await this.downloader.downloadSequential(videoSegments, videoDir, onProgress)
      this._emit('progress', { step: 'download', status: 'video_complete', count: videoSegments.length })

      // Download all audio tracks
      const audioPathsList = []
      for (let i = 0; i < audioSegmentsList.length; i++) {
        console.log('[DOWNLOAD] Downloading audio track', i, '(', audioSegmentsList[i].repr.id, ')...')
        const paths = await this.downloader.downloadSequential(audioSegmentsList[i].segments, audioDirs[i], onProgress)
        audioPathsList.push(paths)
        this._emit('progress', { step: 'download', status: `audio_${i}_complete`, count: audioSegmentsList[i].segments.length })
      }

      // Step 7: Concatenate segments for video + each audio track
      console.log('[DOWNLOAD] Step 7: Concatenating segments...')
      const encryptedVideoPath = `${videoDir}/video_encrypted.mp4`
      await this._concatSegments(videoPaths, encryptedVideoPath, videoInitPath)

      const encryptedAudioPaths = []
      for (let i = 0; i < audioPathsList.length; i++) {
        const encryptedAudioPath = `${audioDirs[i]}/audio_encrypted.mp4`
        await this._concatSegments(audioPathsList[i], encryptedAudioPath, audioInitPaths[i])
        encryptedAudioPaths.push(encryptedAudioPath)
      }

      // Step 8: Decrypt
      this._emit('progress', { step: 'decrypt', status: 'starting' })

      const decryptedVideoPath = encryptedVideoPath.replace('.mp4', '.decrypted.mp4')

      this._log('info', `Pre-fetch auth.pssh: ${auth.pssh ? 'present' : 'MISSING'}`)
      this._log('info', `Pre-fetch auth.licenseUrl: ${auth.licenseUrl ? 'present' : 'MISSING'}`)
      this._log('info', `Pre-fetch auth.accessToken: ${auth.accessToken ? 'present' : 'MISSING'}`)
      let keys = await this._fetchDecryptionKeys(auth, this._provider)
      if (keys.length === 0 && options.keys?.length > 0) {
        this._log('info', 'Using manually provided keys')
        keys = options.keys
      }
      this._log('info', `Keys for decryption: ${keys.length} key(s)`)
      if (keys.length > 0) {
        this._log('info', `Decrypting video with ${keys.length} key(s)`)
        await this.decryptor.decrypt(encryptedVideoPath, keys, decryptedVideoPath)

        const decryptedAudioPaths = []
        for (let i = 0; i < encryptedAudioPaths.length; i++) {
          this._log('info', `Decrypting audio track ${i} with ${keys.length} key(s)`)
          const decryptedAudioPath = encryptedAudioPaths[i].replace('.mp4', '.decrypted.mp4')
          await this.decryptor.decrypt(encryptedAudioPaths[i], keys, decryptedAudioPath)
          decryptedAudioPaths.push(decryptedAudioPath)
        }

        this._emit('progress', { step: 'decrypt', status: 'complete' })

        // Step 9: Merge video + all audio tracks
        this._emit('progress', { step: 'merge', status: 'starting' })

        const outputPath = options.output || `${this.outputDir}/output.mkv`
        await this.merger.mergeMultiple([decryptedVideoPath, ...decryptedAudioPaths], outputPath)

        this._emit('progress', { step: 'merge', status: 'complete', output: outputPath })
        this._emit('complete', { output: outputPath, url })

        // Dump metadata for debugging/archival
        await this._dumpMetadata(tempBase, {
          auth,
          manifest: manifest.raw,
          videoRepr,
          audioReprs,
          keys,
        })

        // Dump raw encrypted files if DUMP_RAW=true
        if (process.env.DUMP_RAW === 'true') {
          await this._dumpRawFiles(tempBase, {
            encryptedVideoPath,
            encryptedAudioPaths,
          })
          // Finalize HAR file
          await this.httpClient.finalizeHar()
        }

        this._log('info', `Complete: ${outputPath}`)
        return outputPath
      } else {
        this._log('warn', 'No decryption keys available, skipping decrypt')
        return encryptedVideoPath // Return encrypted if no keys
      }
    } catch (error) {
      this._emit('error', { error: error.message, url })
      throw error
    }
  }

  /**
   * Download raw segments only (skip decrypt/merge).
   * @param {string} url
   * @param {Object} options
   * @returns {Promise<{videoSegments: Array<string>, audioSegments: Array<string>}>}
   */
  async downloadRaw(url, options = {}) {
    const provider = await this._setupProvider(url, options)
    this._provider = provider

    const auth = await provider.authorizeContent(url)
    const manifest = await provider.getManifest(auth.contentUrl)

    const videoRepr = this.manifestParser.selectRepresentation(manifest, { contentType: 'video' })
    const audioRepr = this.manifestParser.selectRepresentation(manifest, { contentType: 'audio' })

    const videoSegments = this.manifestParser.buildSegmentList(manifest, { representationId: videoRepr?.id, contentType: 'video' })
    const audioSegments = this.manifestParser.buildSegmentList(manifest, { representationId: audioRepr?.id, contentType: 'audio' })

    const { videoDir, audioDir } = await this._createTempDirs()

    const videoPaths = await this.downloader.downloadSequential(videoSegments, videoDir)
    const audioPaths = await this.downloader.downloadSequential(audioSegments, audioDir)

    return { videoSegments: videoPaths, audioSegments: audioPaths, manifest, auth }
  }

  /**
   * Decrypt a file.
   * @param {string} inputPath
   * @param {Array<string>} keys - ['kid:key', ...]
   * @param {string} [outputPath]
   * @returns {Promise<string>}
   */
  async decrypt(inputPath, keys, outputPath) {
    const out = outputPath ?? inputPath.replace('.encrypted', '.decrypted')
    return this.decryptor.decrypt(inputPath, keys, out)
  }

  /**
   * Merge video and audio files.
   * @param {string} videoPath
   * @param {string} audioPath
   * @param {string} [outputPath]
   * @returns {Promise<string>}
   */
  async merge(videoPath, audioPath, outputPath) {
    const out = outputPath ?? `${this.outputDir}/output.mkv`
    return this.merger.merge(videoPath, audioPath, out)
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  async _setupProvider(url, options = {}) {
    console.log('[SETUP] === _setupProvider START ===')
    console.log('[SETUP] URL:', url)
    console.log('[SETUP] Provider options:', JSON.stringify(options))

    // Build deps
    const deps = {
      httpClient: this.httpClient,
      manifestParser: this.manifestParser,
      downloader: this.downloader,
      decryptor: this.decryptor,
      merger: this.merger,
    }

    // Create provider based on URL
    console.log('[SETUP] Creating provider for URL...')
    const provider = createProvider(url, this.config, deps)
    console.log('[SETUP] Provider created:', provider.constructor.name)

    // Setup auth manager based on provider type
    console.log('[SETUP] Creating auth manager...')
    const authManager = this._createAuthManager(provider.constructor.name)
    provider.authManager = authManager
    console.log('[SETUP] Auth manager created:', authManager ? authManager.constructor.name : 'null')

    // Authenticate if needed (either via credentials or pre-loaded session from config)
    if (options.credentials) {
      console.log('[SETUP] Authenticating with provided credentials...')
      await authManager.authenticate(options.credentials)
    } else if (authManager) {
      // Check for session data in various config locations
      console.log('[SETUP] Checking for session data in config...')
      console.log('[SETUP] config.tvnz:', this.config.tvnz ? 'present' : 'MISSING')
      console.log('[SETUP] config.tvnz?.session:', this.config.tvnz?.session ? 'present' : 'MISSING')
      console.log('[SETUP] config.tvnz?.accessToken:', this.config.tvnz?.accessToken ? 'present' : 'MISSING')
      console.log('[SETUP] config.accessToken:', this.config.accessToken ? 'present' : 'MISSING')

      let sessionData = this.config.tvnz?.session
      if (!sessionData && this.config.tvnz?.accessToken) sessionData = this.config.tvnz
      if (!sessionData && this.config.accessToken) sessionData = this.config

      if (sessionData?.accessToken) {
        console.log('[SETUP] Found session data, loading session...')
        console.log('[SETUP] accessToken length:', sessionData.accessToken.length)
        authManager.loadSession(sessionData)
        console.log('[SETUP] isAuthenticated:', authManager.isAuthenticated())
        console.log('[SETUP] xAuthToken present:', !!authManager._xAuthToken)
        console.log('[SETUP] deviceId:', authManager.deviceId)
        console.log('[SETUP] deviceSecret:', authManager.deviceSecret ? 'present' : 'MISSING')
      } else {
        console.log('[SETUP] No session data found in config')
      }
    }

    console.log('[SETUP] === _setupProvider END ===')
    return provider
  }

  _createAuthManager(providerName) {
    switch (providerName) {
      case 'TvnzProvider':
        return new TvnzAuth(this.config.tvnz ?? {}, this.httpClient)
      // BrightcoveAuth would be created for BrightcoveProvider
      default:
        return null
    }
  }

  _buildKeys(authResponse) {
    if (!authResponse.decryptionKeys) return []
    return authResponse.decryptionKeys
  }

  async _fetchDecryptionKeys(auth, provider) {
    if (!auth.pssh || !auth.licenseUrl) {
      this._log('warn', 'Missing pssh or licenseUrl for key fetching')
      return []
    }
    try {
      const keys = await provider.getKeys(auth.pssh, auth.licenseUrl, {
        wvdDevicePath: this.config.wvdDevicePath || process.env.WVDEVICE_PATH,
        // accessToken goes in Authorization: Bearer header (used by TVNZ Widevine)
        // heartbeatToken is logged but NOT sent to license server
        accessToken: auth.accessToken,
      })
      this._log('info', `Fetched ${keys.length} decryption keys`)
      return keys
    } catch (e) {
      this._log('error', `Key fetching failed: ${e.message}`)
      return []
    }
  }

  _buildInitUrl(representation, manifest, manifestUrl) {
    const template = representation.segmentTemplate
    if (!template?.initialization) return null
    let url = template.initialization
      .replace(/\$RepresentationID\$/g, representation.id)
      .replace(/\$Bandwidth\$/g, String(representation.bandwidth || ''))

    // Build baseUrl — prefer representation's resolved baseUrl if available
    const rawBaseUrl = representation.baseUrl || manifest.mpdBaseUrl || manifestUrl || ''

    if (url.startsWith('http')) {
      return url
    }

    // Ensure baseUrl ends with / for proper path joining
    const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : rawBaseUrl + '/'
    try {
      url = new URL(url, baseUrl).toString()
    } catch {
      url = baseUrl + url
    }
    return url
  }

  async _createTempDirs() {
    const { mkdirSync } = await import('fs')
    const { join } = await import('path')
    const { randomUUID } = await import('crypto')

    const base = join(this.outputDir, 'temp', randomUUID())
    mkdirSync(base, { recursive: true })

    return {
      videoDir: join(base, 'video'),
      audioDir: join(base, 'audio'),
    }
  }

  /**
   * Parse MP4 boxes from a buffer. Returns array of {type, size, offset}.
   * @param {Buffer} buf
   * @returns {Array<{type: string, size: number, offset: number}>}
   */
  _parseMp4Boxes(buf) {
    const boxes = []
    let offset = 0
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset)
      const type = buf.slice(offset + 4, offset + 8).toString('ascii', 0, 4)
      if (size < 8) break
      boxes.push({ type, size, offset })
      offset += size
    }
    return boxes
  }

  /**
   * Strip leading non-media boxes (styp, free, sidx, etc.) from CMAF fragment.
   * Returns buffer starting with moof box only.
   * @param {Buffer} buf
   * @returns {Buffer}
   */
  _stripFragmentBoxes(buf) {
    const boxes = this._parseMp4Boxes(buf)
    if (boxes.length < 2) return buf

    const sectionsToKeep = []
    let i = 0

    // Skip all leading non-content boxes (styp, free, sidx, etc.) until we hit moof
    while (i < boxes.length && boxes[i].type !== 'moof') {
      i++
    }

    // Collect moof, mdat, and any subsequent boxes
    for (; i < boxes.length; i++) {
      sectionsToKeep.push({ offset: boxes[i].offset, size: boxes[i].size })
    }

    if (sectionsToKeep.length === 0) return buf

    const totalSize = sectionsToKeep.reduce((sum, s) => sum + s.size, 0)
    const result = Buffer.alloc(totalSize)
    let pos = 0
    for (const s of sectionsToKeep) {
      buf.copy(result, pos, s.offset, s.offset + s.size)
      pos += s.size
    }
    return result
  }

  async _concatSegments(segmentPaths, outputPath, initPath = null) {
    const fs = await import('fs')
    const pathModule = await import('path')
    const { createWriteStream, mkdirSync, readFileSync } = fs

    mkdirSync(pathModule.dirname(outputPath), { recursive: true })

    // Prefer explicit initPath if provided, otherwise scan segments for ftyp/moov
    let initData = null
    if (initPath && fs.existsSync(initPath)) {
      initData = readFileSync(initPath)
      console.log('[CONCAT] Using explicit init segment:', initPath)
    } else {
      // Scan segments for initialization data
      for (const p of segmentPaths) {
        const buf = readFileSync(p)
        if (buf.length < 8) continue
        const firstBoxType = buf.slice(4, 8).toString('ascii', 0, 4)
        if (firstBoxType === 'ftyp' || firstBoxType === 'moov') {
          initData = buf
          console.log('[CONCAT] Found init in segment:', p)
          break
        }
      }
    }

    const tmpConcat = outputPath + '.tmp.concat.mp4'
    const out = createWriteStream(tmpConcat)

    if (initData) {
      out.write(initData)
    }
    for (const p of segmentPaths) {
      const segBuf = readFileSync(p)
      const stripped = this._stripFragmentBoxes(segBuf)
      out.write(stripped)
    }
    out.end()
    await new Promise((res, rej) => {
      out.on('finish', res)
      out.on('error', rej)
    })

    try {
      // Skip mp4fragment for CENC-encrypted content - it strips PSSH boxes from moov!
      // The raw concat already has correct structure: ftyp + free + moov(pssh) + moof + mdat + ...
      this._log('info', 'Skipping mp4fragment (strips PSSH from CENC content), using raw concat')
      fs.copyFileSync(tmpConcat, outputPath)
      fs.unlinkSync(tmpConcat)
      return outputPath
    } catch (e) {
      this._log('warn', `Copy failed: ${e.message}, trying ffmpeg remux`)
      try { fs.unlinkSync(tmpConcat) } catch {}
      try {
        await this._ffmpegRemux(tmpConcat, outputPath)
        return outputPath
      } catch (e2) {
        this._log('warn', `ffmpeg remux failed: ${e2.message}`)
        try { fs.copyFileSync(tmpConcat, outputPath) } catch {}
        try { fs.unlinkSync(tmpConcat) } catch {}
        return outputPath
      }
    }
  }

  async _fragmentAndMove(tmpFile, outputPath) {
    const { spawn } = await import('child_process')
    const fs = await import('fs')

    return new Promise((res, rej) => {
      const proc = spawn('mp4fragment', [tmpFile, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', c => { stderr += c.toString() })
      proc.on('close', code => {
        if (code === 0) {
          try { fs.unlinkSync(tmpFile) } catch {}
          res(outputPath)
        } else {
          this._ffmpegRemux(tmpFile, outputPath).then(res).catch(e => {
            this._log('warn', `All concat methods failed: ${e.message}`)
            try { fs.copyFileSync(tmpFile, outputPath); fs.unlinkSync(tmpFile) } catch {}
            res(outputPath)
          })
        }
      })
      proc.on('error', err => {
        this._log('warn', `mp4fragment error: ${err.message}`)
        this._ffmpegRemux(tmpFile, outputPath).then(res).catch(e => {
          this._log('warn', `All concat methods failed: ${e.message}`)
          try { fs.copyFileSync(tmpFile, outputPath); fs.unlinkSync(tmpFile) } catch {}
          res(outputPath)
        })
      })
    })
  }

  async _ffmpegRemux(inputPath, outputPath) {
    const { spawn } = await import('child_process')
    const fs = await import('fs')
    const pathModule = await import('path')
    fs.mkdirSync(pathModule.dirname(outputPath), { recursive: true })

    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-fflags', '+genpts+nobuffer',
        '-i', inputPath,
        '-c', 'copy',
        outputPath
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', c => { stderr += c.toString() })
      proc.on('close', code => {
        if (code === 0) resolve(outputPath)
        else reject(new Error(`ffmpeg failed ${code}: ${stderr.slice(0, 200)}`))
      })
      proc.on('error', reject)
    })
  }

  /**
   * Dump metadata for debugging and archival purposes.
   * If DUMP_RAW=true env var is set, dumps everything unredacted (tokens, keys, full data).
   * @param {string} tempBase - temp directory path
   * @param {Object} data - data to dump
   */
  async _dumpMetadata(tempBase, data) {
    const fs = await import('fs')
    const pathModule = await import('path')
    const { join } = pathModule
    const rawDump = process.env.DUMP_RAW === 'true'

    try {
      const dumpDir = join(tempBase, '_metadata')
      fs.mkdirSync(dumpDir, { recursive: true })

      // Dump auth info (redacted unless DUMP_RAW=true)
      fs.writeFileSync(join(dumpDir, 'auth.json'), JSON.stringify({
        contentId: data.auth?.contentId,
        contentUrl: data.auth?.contentUrl,
        licenseUrl: data.auth?.licenseUrl,
        pssh: data.auth?.pssh,
        heartbeatToken: rawDump ? data.auth?.heartbeatToken : (data.auth?.heartbeatToken ? '[REDACTED]' : null),
        accessToken: rawDump ? data.auth?.accessToken : (data.auth?.accessToken ? '[PRESENT]' : null),
        mtSessionUrl: rawDump ? data.auth?.mtSessionUrl : null,
        playerParams: rawDump ? data.auth?.playerParams : null,
        metadata: data.auth?.metadata,
      }, null, 2))

      // Dump manifest raw XML
      if (data.manifest) {
        fs.writeFileSync(join(dumpDir, 'manifest.mpd'), data.manifest)
      }

      // Dump video representation
      fs.writeFileSync(join(dumpDir, 'video_repr.json'), JSON.stringify(data.videoRepr, null, 2))

      // Dump all audio representations
      fs.writeFileSync(join(dumpDir, 'audio_reprs.json'), JSON.stringify(data.audioReprs, null, 2))

      // Dump decryption keys
      if (rawDump) {
        // Full unredacted keys dump
        fs.writeFileSync(join(dumpDir, 'keys.json'), JSON.stringify({
          key_count: data.keys?.length ?? 0,
          keys: data.keys ?? [],
          retrieved_at: new Date().toISOString(),
        }, null, 2))
      } else {
        // Redacted keys dump (default)
        fs.writeFileSync(join(dumpDir, 'keys.json'), JSON.stringify({
          key_count: data.keys?.length ?? 0,
          keys: data.keys?.map(k => {
            const [kid] = k.split(':')
            return `${kid}:[REDACTED]`
          }) ?? [],
          retrieved_at: new Date().toISOString(),
        }, null, 2))
      }

      // Dump full pipeline state
      fs.writeFileSync(join(dumpDir, 'pipeline_state.json'), JSON.stringify({
        timestamp: new Date().toISOString(),
        url: data.url,
        dump_raw: rawDump,
        video: {
          id: data.videoRepr?.id,
          bandwidth: data.videoRepr?.bandwidth,
          width: data.videoRepr?.width,
          height: data.videoRepr?.height,
          baseUrl: data.videoRepr?.baseUrl,
          lang: data.videoRepr?.lang,
          role: data.videoRepr?.role,
        },
        audio: data.audioReprs?.map((r, i) => ({
          index: i,
          id: r.id,
          bandwidth: r.bandwidth,
          baseUrl: r.baseUrl,
          lang: r.lang,
          role: r.role,
          contentType: r.contentType,
        })),
      }, null, 2))

      this._log('info', `Metadata dumped to: ${dumpDir}${rawDump ? ' (UNREDACTED)' : ''}`)
    } catch (e) {
      this._log('warn', `Failed to dump metadata: ${e.message}`)
    }
  }

  /**
   * Dump raw encrypted files for forensic debugging.
   * Only runs when DUMP_RAW=true environment variable is set.
   * @param {string} tempBase - temp directory path
   * @param {Object} files - encrypted file paths
   */
  async _dumpRawFiles(tempBase, files) {
    const fs = await import('fs')
    const pathModule = await import('path')
    const { join } = pathModule

    try {
      const rawDir = join(tempBase, '_raw')
      fs.mkdirSync(rawDir, { recursive: true })

      // Copy video encrypted file
      if (files.encryptedVideoPath && fs.existsSync(files.encryptedVideoPath)) {
        const dest = join(rawDir, 'video_encrypted.mp4')
        fs.copyFileSync(files.encryptedVideoPath, dest)
        this._log('info', `Raw video dumped: ${dest}`)
      }

      // Copy all audio encrypted files
      for (let i = 0; i < files.encryptedAudioPaths.length; i++) {
        const src = files.encryptedAudioPaths[i]
        if (src && fs.existsSync(src)) {
          const dest = join(rawDir, `audio_${i}_encrypted.mp4`)
          fs.copyFileSync(src, dest)
          this._log('info', `Raw audio ${i} dumped: ${dest}`)
        }
      }

      this._log('info', `Raw files dumped to: ${rawDir}`)
    } catch (e) {
      this._log('warn', `Failed to dump raw files: ${e.message}`)
    }
  }
}

export default DownloadManager