/**
 * Tests for src-new/utils/http-client.mjs
 * Focus on HAR logging functionality.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Import the HttpClient class
const HttpClient = (await import('../utils/http-client.mjs')).HttpClient

describe('HttpClient HAR logging', () => {
  /** @type {string} */
  let tmpDir
  /** @type {HttpClient} */
  let client

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-client-test-'))
    client = new HttpClient({ harFilePath: path.join(tmpDir, 'test.har') })
  })

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true })
    } catch {}
  })

  test('setHarFilePath enables HAR logging', () => {
    const filePath = path.join(tmpDir, 'custom.har')
    client.setHarFilePath(filePath)

    assert.strictEqual(client.harFilePath, filePath, 'harFilePath should be set')
    assert.deepStrictEqual(client._harEntries, [], '_harEntries should be initialized to empty array')
  })

  test('setHarFilePath clears existing entries', () => {
    const filePath1 = path.join(tmpDir, 'first.har')
    const filePath2 = path.join(tmpDir, 'second.har')

    client.setHarFilePath(filePath1)

    // Manually add an entry
    client._harEntries.push({ test: 'entry' })
    assert.strictEqual(client._harEntries.length, 1, 'should have 1 entry')

    // Setting new path should clear
    client.setHarFilePath(filePath2)
    assert.deepStrictEqual(client._harEntries, [], 'entries should be cleared')
  })

  test('_addHarEntry adds entry when harFilePath is set', () => {
    client.setHarFilePath(path.join(tmpDir, 'test.har'))
    const entry = { request: { method: 'GET', url: 'http://example.com' } }

    client._addHarEntry(entry)

    assert.strictEqual(client._harEntries.length, 1, 'should have 1 entry')
    assert.deepStrictEqual(client._harEntries[0], entry, 'entry should match')
  })

  test('_addHarEntry does nothing when harFilePath is null', () => {
    // Initialize client without HAR path set
    const clientNoHar = new HttpClient({ harFilePath: null })
    clientNoHar._harEntries.push({ existing: 'entry' })
    clientNoHar._addHarEntry({ request: { method: 'GET', url: 'http://example.com' } })

    // Entry should not be added when harFilePath is null
    assert.strictEqual(clientNoHar._harEntries.length, 1, 'should still have 1 entry')
  })

  test('_buildHarEntry creates valid HAR entry structure', () => {
    const harEntry = client._buildHarEntry(
      'GET',
      'http://example.com/api?foo=bar',
      { 'User-Agent': 'test-agent', 'Authorization': 'Bearer token123' },
      null,
      200,
      'OK',
      { 'content-type': 'application/json', 'x-custom': 'header-value' },
      '{"data":"test"}',
      'application/json',
      1712000000000,
      1712000000100
    )

    assert.strictEqual(harEntry.request.method, 'GET')
    assert.strictEqual(harEntry.request.url, 'http://example.com/api?foo=bar')
    assert.strictEqual(harEntry.request.httpVersion, 'HTTP/1.1')
    assert.strictEqual(harEntry.response.status, 200)
    assert.strictEqual(harEntry.response.statusText, 'OK')
    assert.strictEqual(harEntry.timings.wait, 100, 'timings.wait should be endTime - startTime')
    assert.strictEqual(harEntry.timings.dns, 0, 'dns timing should be 0')
    assert.strictEqual(harEntry.timings.connect, 0, 'connect timing should be 0')

    // Check headers converted to HAR format
    assert.strictEqual(harEntry.request.headers.length, 2, 'should have 2 request headers')
    assert.ok(harEntry.request.headers.some(h => h.name === 'User-Agent' && h.value === 'test-agent'))

    // Check query string parsed
    assert.strictEqual(harEntry.request.queryString.length, 1)
    assert.deepStrictEqual(harEntry.request.queryString[0], { name: 'foo', value: 'bar' })

    // Check response content
    assert.strictEqual(harEntry.response.content.size, 15)
    assert.strictEqual(harEntry.response.content.mimeType, 'application/json')

    // Check startedDateTime
    assert.strictEqual(harEntry.startedDateTime, new Date(1712000000000).toISOString())
  })

  test('_buildHarEntry handles Buffer response body', () => {
    const buffer = Buffer.from('binary data')
    const harEntry = client._buildHarEntry(
      'GET',
      'http://example.com/file',
      {},
      null,
      200,
      'OK',
      {},
      buffer,
      'application/octet-stream',
      1712000000000,
      1712000000100
    )

    assert.strictEqual(harEntry.response.content.size, 11, 'content size should match buffer length')
    assert.strictEqual(harEntry.response.content.text, buffer.toString('base64'), 'text should be base64 encoded')
  })

  test('_buildHarEntry handles error response', () => {
    const harEntry = client._buildHarEntry(
      'GET',
      'http://example.com/notfound',
      {},
      null,
      0,
      'Error: ENOTFOUND',
      {},
      'Error: ENOTFOUND',
      'text/plain',
      1712000000000,
      1712000000050
    )

    assert.strictEqual(harEntry.response.status, 0)
    assert.strictEqual(harEntry.response.statusText, 'Error: ENOTFOUND')
    assert.strictEqual(harEntry.response.content.mimeType, 'text/plain')
  })

  test('_buildHarEntry calculates bodySize for request body', () => {
    const harEntry = client._buildHarEntry(
      'POST',
      'http://example.com/api',
      { 'Content-Type': 'application/json' },
      { key: 'value' },
      200,
      'OK',
      {},
      '{}',
      'application/json',
      1712000000000,
      1712000000100
    )

    assert.strictEqual(harEntry.request.bodySize, 15, 'bodySize should be JSON.stringify length')
  })

  test('finalizeHar writes valid HAR file', async () => {
    client.setHarFilePath(path.join(tmpDir, 'output.har'))

    // Add some entries
    client._addHarEntry({
      request: { method: 'GET', url: 'http://example.com/1' },
      response: { status: 200 },
    })
    client._addHarEntry({
      request: { method: 'GET', url: 'http://example.com/2' },
      response: { status: 200 },
    })

    await client.finalizeHar()

    // File should exist
    assert.ok(fs.existsSync(path.join(tmpDir, 'output.har')), 'HAR file should be created')

    // Parse and validate HAR structure
    const harContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'output.har'), 'utf8'))
    assert.strictEqual(harContent.log.version, '1.2')
    assert.strictEqual(harContent.log.creator.name, 'javagt-decrypt-tv')
    assert.strictEqual(harContent.log.creator.version, '1.0.0')
    assert.strictEqual(harContent.log.entries.length, 2)
  })

  test('finalizeHar does nothing when harFilePath is null', async () => {
    client.harFilePath = null
    client._harEntries.push({ test: 'entry' })

    const filePath = path.join(tmpDir, 'should-not-exist.har')
    // No call to setHarFilePath

    await client.finalizeHar()

    assert.ok(!fs.existsSync(filePath), 'HAR file should not be created when harFilePath is null')
  })

  test('finalizeHar does nothing when no entries', async () => {
    client.setHarFilePath(path.join(tmpDir, 'empty.har'))

    await client.finalizeHar()

    assert.ok(!fs.existsSync(path.join(tmpDir, 'empty.har')), 'HAR file should not be created with no entries')
  })
})

describe('HttpClient buildUrl', () => {
  test('buildUrl merges query parameters', () => {
    const client = new HttpClient()
    const url = client.buildUrl('http://example.com/api', { foo: 'bar', baz: 'qux' })

    const parsed = new URL(url)
    assert.strictEqual(parsed.pathname, '/api')
    assert.strictEqual(parsed.searchParams.get('foo'), 'bar')
    assert.strictEqual(parsed.searchParams.get('baz'), 'qux')
  })

  test('buildUrl overwrites existing query params', () => {
    const client = new HttpClient()
    const url = client.buildUrl('http://example.com/api?existing=1', { existing: '2' })

    const parsed = new URL(url)
    assert.strictEqual(parsed.searchParams.get('existing'), '2')
  })

  test('buildUrl handles no query params', () => {
    const client = new HttpClient()
    const url = client.buildUrl('http://example.com/api')

    assert.strictEqual(url, 'http://example.com/api')
  })
})

describe('HttpClient cookie management', () => {
  test('setCookie stores cookie for domain', () => {
    const client = new HttpClient()
    client.setCookie('example.com', 'session=abc123')

    assert.strictEqual(client._cookieJar['example.com'], 'session=abc123')
  })

  test('_getCookieHeader returns Cookie header for matching domain', () => {
    const client = new HttpClient()
    client.setCookie('example.com', 'session=abc123')

    const headers = client._getCookieHeader('http://example.com/api')
    assert.deepStrictEqual(headers, { Cookie: 'session=abc123' })
  })

  test('_getCookieHeader returns empty for non-matching domain', () => {
    const client = new HttpClient()
    client.setCookie('example.com', 'session=abc123')

    const headers = client._getCookieHeader('http://other.com/api')
    assert.deepStrictEqual(headers, {})
  })

  test('_getCookieHeader handles invalid URL', () => {
    const client = new HttpClient()
    client.setCookie('example.com', 'session=abc123')

    const headers = client._getCookieHeader('not-a-url')
    assert.deepStrictEqual(headers, {})
  })
})

describe('HttpClient header management', () => {
  test('_getHeaders merges default headers with cookie and extra', () => {
    const client = new HttpClient({
      headers: { 'X-Custom': 'value' }
    })
    client.setCookie('example.com', 'session=abc')

    const headers = client._getHeaders('http://example.com/api', { 'Authorization': 'Bearer token' })

    assert.strictEqual(headers['User-Agent'], 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    assert.strictEqual(headers['X-Custom'], 'value')
    assert.strictEqual(headers['Cookie'], 'session=abc')
    assert.strictEqual(headers['Authorization'], 'Bearer token')
  })

  test('_getHeaders uses provided headers over defaults', () => {
    const client = new HttpClient()
    client.setCookie('example.com', 'session=abc')

    // User-Agent is provided in extraHeaders, should override default
    const headers = client._getHeaders('http://example.com/api', { 'User-Agent': 'CustomAgent' })

    assert.strictEqual(headers['User-Agent'], 'CustomAgent')
  })
})