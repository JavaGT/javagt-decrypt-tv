import http from 'http';

export function createServeApp() {
    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 200, message: 'Pong!' }));
            return;
        }

        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 501,
            message: 'The full pywidevine serve API is not implemented in this JS scaffold.'
        }));
    });
}

export function startServe({ host = '127.0.0.1', port = 8786 } = {}) {
    const server = createServeApp();
    server.listen(port, host);
    return server;
}

export default {
    createServeApp,
    startServe
};
