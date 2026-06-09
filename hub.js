const WebSocket = require('ws');
const { debug } = require('./utils.js');

const RECONNECT_DELAY = 5000;

const HUB_BASE_URL = 'http://localhost:8001';
const HUB_WS_URL = 'ws://localhost:8001/websocket/connect';

function createHubConnection() {
    const apiKey = process.env.HUB_API_KEY;

    if (!apiKey) {
        console.log('[Hub] HUB_API_KEY not set, skipping Hub connection.');
        return null;
    }

    let ws = null;
    let reconnectTimer = null;
    let intentionallyClosed = false;
    const messageHandlers = [];

    function connect() {
        debug(`[Hub] Connecting to ${HUB_WS_URL}...`);

        ws = new WebSocket(HUB_WS_URL, {
            headers: {
                'x-api-key': apiKey,
                'client-type': 'discord',
                'mc_server': 'tradebot',
            }
        });

        ws.on('open', () => {
            console.log('[Hub] Connected.');
        });

        ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data.toString());
                debug('[Hub] Received:', JSON.stringify(payload));
                for (const handler of messageHandlers) {
                    handler(payload);
                }
            } catch (err) {
                debug('[Hub] Failed to parse message:', err.message);
            }
        });

        ws.on('close', () => {
            if (!intentionallyClosed) {
                console.log(`[Hub] Disconnected. Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
                reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
            }
        });

        ws.on('error', (err) => {
            debug('[Hub] WebSocket error:', err.message);
        });
    }

    function send(action, data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            debug('[Hub] Cannot send, not connected.');
            return false;
        }
        ws.send(JSON.stringify({ action, data }));
        return true;
    }

    function onMessage(handler) {
        messageHandlers.push(handler);
    }

    function close() {
        intentionallyClosed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close();
    }

    async function api(method, path, body) {
        const res = await fetch(`${HUB_BASE_URL}${path}`, {
            method,
            headers: {
                'x-api-key': apiKey,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    connect();

    return { send, onMessage, close, api };
}

module.exports = { createHubConnection };
