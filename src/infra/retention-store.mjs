import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class RetentionStore {
    constructor(downloadsPath, videoUrl, namespace = 'media', options = {}) {
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
        const safeSlug = videoUrl.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
        const safeNamespace = String(namespace || 'media').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
        this.baseDir = path.join(path.resolve(downloadsPath), `_${safeNamespace}_retention`, `${timestamp}_${safeSlug}`);
        this.rawDir = path.join(this.baseDir, 'raw');
        this.parsedDir = path.join(this.baseDir, 'parsed');
        this.logsDir = path.join(this.baseDir, 'logs');
        fs.mkdirSync(this.rawDir, { recursive: true });
        fs.mkdirSync(this.parsedDir, { recursive: true });
        fs.mkdirSync(this.logsDir, { recursive: true });
        this.eventLogPath = path.join(this.logsDir, 'events.jsonl');
        this.summaryPath = path.join(this.baseDir, 'summary.json');
        this.events = [];
        this.retentionLevel = this._normalizeRetentionLevel(options.retentionLevel || process.env.RETENTION_LEVEL || 'safe');
    }

    _normalizeRetentionLevel(level) {
        const normalized = String(level || 'safe').toLowerCase();
        if (normalized === 'debug' || normalized === 'forensic') {
            return normalized;
        }
        return 'safe';
    }

    _maskValue(value) {
        const text = String(value || '');
        if (!text) {
            return text;
        }

        const keyPair = text.match(/^([a-fA-F0-9]{16,}):([a-fA-F0-9]{16,})$/);
        if (keyPair) {
            return `${keyPair[1]}:[REDACTED]`;
        }

        if (text.length <= 8) {
            return '[REDACTED]';
        }

        return `${text.slice(0, 4)}...[REDACTED]...${text.slice(-4)}`;
    }

    _redactJsonPayload(payload) {
        if (this.retentionLevel === 'forensic') {
            return payload;
        }

        const secretFieldPattern = /(access_token|refresh_token|id_token|authorization|cookie|drmtoken|login_ticket|co_verifier|co_id|^keys?$|license_response|license_challenge)/i;
        const seen = new WeakSet();

        const walk = (value, key = '') => {
            if (value === null || value === undefined) {
                return value;
            }

            if (typeof value === 'string') {
                if (secretFieldPattern.test(key)) {
                    return this._maskValue(value);
                }

                // Mask JWT-like tokens even when nested under non-obvious keys.
                if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length > 40) {
                    return this._maskValue(value);
                }

                return value;
            }

            if (typeof value !== 'object') {
                return value;
            }

            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);

            if (Array.isArray(value)) {
                if (secretFieldPattern.test(key)) {
                    const masked = value.map((entry) => (typeof entry === 'string' ? this._maskValue(entry) : '[REDACTED]'));
                    seen.delete(value);
                    return masked;
                }

                const masked = value.map((entry) => walk(entry, key));
                seen.delete(value);
                return masked;
            }

            const output = {};
            for (const [childKey, childValue] of Object.entries(value)) {
                output[childKey] = walk(childValue, childKey);
            }
            seen.delete(value);
            return output;
        };

        return walk(payload);
    }

    _applyTextPolicy(relativePath, payload) {
        if (this.retentionLevel === 'forensic') {
            return String(payload);
        }

        if (/raw\/license_response\.bin\.b64$/i.test(relativePath)) {
            return '[REDACTED: license response payload omitted by retention policy]';
        }

        if (/raw\/login_authorize_response\.html$/i.test(relativePath)) {
            return '[REDACTED: authorization response html omitted by retention policy]';
        }

        return String(payload);
    }

    writeJson(relativePath, payload) {
        const target = path.join(this.baseDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(this._redactJsonPayload(payload), null, 2));
    }

    writeText(relativePath, payload) {
        const target = path.join(this.baseDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, this._applyTextPolicy(relativePath, payload));
    }

    addEvent(stage, details) {
        const event = {
            timestamp: new Date().toISOString(),
            stage,
            details
        };
        this.events.push(event);
        fs.appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`);
    }

    writeSummary(success, details) {
        this.writeJson('summary.json', {
            success,
            run_dir: this.baseDir,
            created_at: new Date().toISOString(),
            event_count: this.events.length,
            details
        });
    }

    writeRunManifest(details = {}) {
        this.writeJson('parsed/run_manifest.json', {
            retention_level: this.retentionLevel,
            created_at: new Date().toISOString(),
            ...details
        });
    }

    writeOutputFiles(filePaths = []) {
        const files = [];

        for (const item of filePaths) {
            if (!item) {
                continue;
            }

            const filePath = path.resolve(String(item));
            const entry = {
                path: filePath,
                exists: fs.existsSync(filePath)
            };

            if (entry.exists) {
                const stats = fs.statSync(filePath);
                entry.size_bytes = stats.size;
                entry.mtime = stats.mtime.toISOString();

                if (this.retentionLevel === 'forensic') {
                    const hash = crypto.createHash('sha256');
                    hash.update(fs.readFileSync(filePath));
                    entry.sha256 = hash.digest('hex');
                }
            }

            files.push(entry);
        }

        this.writeJson('parsed/output_files.json', {
            count: files.length,
            files
        });
    }
}

export default RetentionStore;
