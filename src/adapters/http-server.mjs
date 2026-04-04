import http from 'http';
import { executeServiceAction } from './http-server-handlers.mjs';

export function createHttpServer({ host = '127.0.0.1', port = 3099, service } = {}) {
    if (!service) {
        throw new Error('createHttpServer requires a service instance. Use createHttpServer from src/app.mjs for default module-backed wiring.');
    }

    const resolvedService = service;

    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        const respondJson = (statusCode, payload) => {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        const handlePostAction = (action) => {
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
            });
            req.on('end', async () => {
                const result = await executeServiceAction({
                    service: resolvedService,
                    action,
                    rawBody: raw
                });
                respondJson(result.statusCode, result.payload);
            });
        };

        if (req.method === 'POST' && req.url === '/run') {
            handlePostAction('run');
            return;
        }

        if (req.method === 'POST' && req.url === '/inspect') {
            handlePostAction('inspect');
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    return {
        start() {
            return new Promise((resolve) => {
                server.listen(port, host, () => resolve({ host, port }));
            });
        },
        stop() {
            return new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
        server
    };
}

export default createHttpServer;
