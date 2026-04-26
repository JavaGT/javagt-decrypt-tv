/**
 * Manifest parser service.
 * Unified interface for DASH and HLS manifest parsing.
 */

import { ManifestParseError } from '../../errors/index.mjs'
import { DashManifestParser } from './dash-parser.mjs'
import { HlsManifestParser } from './hls-parser.mjs'

const TM_PENALTY = 10000000000

export class ManifestParser {
  /**
   * @param {Object} config
   */
  constructor(config = {}) {
    this.dash = new DashManifestParser()
    this.hls = new HlsManifestParser()
  }

  /**
   * Auto-detect format and parse manifest.
   * @param {string} content - Raw manifest content (XML for DASH, M3U8 for HLS)
   * @param {string} [format] - 'dash' or 'hls', auto-detected if not provided
   * @returns {Object} Parsed manifest
   */
  parse(content, format = null) {
    if (!content || content.trim().length === 0) {
      throw new ManifestParseError('Empty manifest content')
    }

    const detectedFormat = format ?? this._detectFormat(content)

    if (detectedFormat === 'dash') {
      return this.dash.parse(content)
    } else if (detectedFormat === 'hls') {
      return this.hls.parse(content)
    }

    throw new ManifestParseError(`Unknown manifest format: ${detectedFormat}`, { content: content.slice(0, 100) })
  }

  /**
   * Parse DASH MPD manifest.
   * @param {string} xml
   * @param {string} [manifestUrl]
   * @returns {Object}
   */
  parseDASH(xml, manifestUrl) {
    return this.dash.parse(xml, manifestUrl)
  }

  /**
   * Parse HLS M3U8 manifest.
   * @param {string} m3u8
   * @returns {Object}
   */
  parseHLS(m3u8) {
    return this.hls.parse(m3u8)
  }

  /**
   * Build segment list from manifest.
   * @param {Object} manifest - Parsed manifest
   * @param {Object} options - { periodIndex, representationId, contentType, manifestUrl }
   * @returns {Array<Object>}
   */
  buildSegmentList(manifest, options = {}) {
    // If manifest has 'periods', it's DASH
    if (manifest.periods) {
      return this.dash.buildSegmentList(
        manifest,
        options.representationId ?? null,
        options.baseUrl ?? null,
        options.manifestUrl ?? manifest.manifestUrl ?? ''
      )
    }

    // Otherwise assume HLS
    if (Array.isArray(manifest.segments)) {
      return this.hls.buildSegmentList(manifest)
    }

    throw new ManifestParseError('Unknown manifest structure', { manifestKeys: Object.keys(manifest) })
  }

  /**
   * Select best representation from a manifest.
   * @param {Object} manifest
   * @param {Object} criteria - { contentType, maxBandwidth, minWidth, language }
   * @returns {Object|null}
   */
  selectRepresentation(manifest, criteria = {}) {
    if (manifest.periods) {
      // DASH
      const all = this.dash.getAllRepresentations(manifest)
      console.log('[SELECT] Total representations:', all.length)
      console.log('[SELECT] Criteria:', JSON.stringify(criteria))
      // Group by contentType
      const byType = {}
      for (const r of all) {
        const ct = r.contentType || 'unknown'
        if (!byType[ct]) byType[ct] = []
        byType[ct].push(r)
      }
      console.log('[SELECT] By contentType:', Object.keys(byType).map(k => k + ':' + byType[k].length).join(', '))
      console.log('[SELECT] Sample video:', byType['video']?.slice(0,2).map(r => ({ id: r.id, bandwidth: r.bandwidth, mimeType: r.mimeType })))
      console.log('[SELECT] Sample audio:', byType['audio']?.slice(0,2).map(r => ({ id: r.id, bandwidth: r.bandwidth, mimeType: r.mimeType, lang: r.lang })))
      // Show language distribution for audio
      const langs = {}
      for (const r of byType['audio'] || []) {
        const l = r.lang || 'und'
        if (!langs[l]) langs[l] = 0
        langs[l]++
      }
      console.log('[SELECT] Audio languages:', JSON.stringify(langs))
      let filtered = all.filter(r => {
        if (criteria.contentType && r.contentType !== criteria.contentType) return false
        if (criteria.maxBandwidth && r.bandwidth > criteria.maxBandwidth) return false
        if (criteria.minWidth && r.width < criteria.minWidth) return false
        // Only filter by language if explicitly specified (not 'und' which means undefined)
        if (criteria.language && criteria.language !== 'und' && r.language !== criteria.language) return false
        return true
      })
      console.log('[SELECT] Filtered count:', filtered.length)

      // Score function: penalize /tm/ CDN paths (which have segment gating)
      // Prefer /content/pubcontent/ origin paths for both video AND audio
      const scored = filtered.map(r => {
        const isTmCdn = r.baseUrl?.includes('/tm/')
        const tmPenalty = isTmCdn ? TM_PENALTY : 0
        let score
        if (r.contentType === 'video') {
          score = (r.height || 0) * 1000000 + (r.bandwidth || 0) - tmPenalty
        } else {
          // audio and other
          score = (r.bandwidth || 0) - tmPenalty
        }
        return { repr: r, score }
      })

      // Sort by score descending, then prefer /content/pubcontent/ over /tm/ paths
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        // Secondary sort: prefer /content/pubcontent/ (no penalty path)
        const aIsPub = a.repr.baseUrl?.includes('/content/pubcontent/')
        const bIsPub = b.repr.baseUrl?.includes('/content/pubcontent/')
        if (aIsPub !== bIsPub) return aIsPub ? -1 : 1
        return 0
      })
      console.log('[SELECT] Top scored:', scored.slice(0, 3).map(s => ({ id: s.repr.id, bandwidth: s.repr.bandwidth, baseUrl: s.repr.baseUrl?.slice(-50), score: s.score })))

      return scored[0]?.repr || null
    } else if (manifest.variants) {
      // HLS
      return this.hls.selectVariant(manifest.variants, criteria)
    }

    return null
  }

  /**
   * Select ALL representations matching criteria (not just the best one).
   * @param {Object} manifest
   * @param {Object} criteria - { contentType, maxBandwidth, minWidth, language }
   * @returns {Array<Object>}
   */
  selectAllRepresentations(manifest, criteria = {}) {
    if (manifest.periods) {
      // DASH - same filtering and scoring as selectRepresentation
      const all = this.dash.getAllRepresentations(manifest)
      let filtered = all.filter(r => {
        if (criteria.contentType && r.contentType !== criteria.contentType) return false
        if (criteria.maxBandwidth && r.bandwidth > criteria.maxBandwidth) return false
        if (criteria.minWidth && r.width < criteria.minWidth) return false
        if (criteria.language && criteria.language !== 'und' && r.language !== criteria.language) return false
        return true
      })

      const scored = filtered.map(r => {
        const isTmCdn = r.baseUrl?.includes('/tm/')
        const tmPenalty = isTmCdn ? TM_PENALTY : 0
        let score
        if (r.contentType === 'video') {
          score = (r.height || 0) * 1000000 + (r.bandwidth || 0) - tmPenalty
        } else {
          score = (r.bandwidth || 0) - tmPenalty
        }
        return { repr: r, score }
      })

      // Sort by score descending, prefer /content/pubcontent/
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        const aIsPub = a.repr.baseUrl?.includes('/content/pubcontent/')
        const bIsPub = b.repr.baseUrl?.includes('/content/pubcontent/')
        if (aIsPub !== bIsPub) return aIsPub ? -1 : 1
        return 0
      })

      // Sort by score descending, prefer /content/pubcontent/
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        const aIsPub = a.repr.baseUrl?.includes('/content/pubcontent/')
        const bIsPub = b.repr.baseUrl?.includes('/content/pubcontent/')
        if (aIsPub !== bIsPub) return aIsPub ? -1 : 1
        return 0
      })

      // Deduplicate by (lang, role) keeping highest bandwidth per variety
      // "varieties" = unique (lang, role) combinations
      // So we get: English main + English description + other languages
      const seen = new Set()
      const unique = []
      for (const s of scored) {
        const key = `${s.repr.lang || 'und'}:${s.repr.role || ''}`
        const existing = unique.find(u => `${u.lang || 'und'}:${u.role || ''}` === key)
        if (existing) {
          // Keep higher bandwidth
          if ((s.repr.bandwidth || 0) > (existing.bandwidth || 0)) {
            const idx = unique.indexOf(existing)
            unique[idx] = s.repr
          }
        } else {
          unique.push(s.repr)
        }
      }
      // Sort: main/regular first (by bandwidth desc), then description, then other roles
      unique.sort((a, b) => {
        const aIsDesc = a.role?.toLowerCase().includes('description')
        const bIsDesc = b.role?.toLowerCase().includes('description')
        if (aIsDesc !== bIsDesc) return aIsDesc ? 1 : -1  // main before description
        return (b.bandwidth || 0) - (a.bandwidth || 0)  // higher bandwidth first
      })
      return unique
    }

    return []
  }

  /**
   * Get all representations from a manifest.
   * @param {Object} manifest
   * @returns {Array<Object>}
   */
  getRepresentations(manifest) {
    if (manifest.periods) {
      return this.dash.getAllRepresentations(manifest)
    } else if (manifest.variants) {
      return manifest.variants
    }
    return []
  }

  /**
   * Detect manifest format from content.
   * @param {string} content
   * @returns {'dash'|'hls'}
   */
  _detectFormat(content) {
    const trimmed = content.trim()

    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<MPD')) {
      return 'dash'
    }

    if (trimmed.startsWith('#EXTM3U')) {
      return 'hls'
    }

    throw new ManifestParseError('Cannot detect manifest format', { content: trimmed.slice(0, 50) })
  }
}

export { DashManifestParser } from './dash-parser.mjs'
export { HlsManifestParser } from './hls-parser.mjs'
export default ManifestParser