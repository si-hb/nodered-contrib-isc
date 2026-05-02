// Crestron ISC node — TCP server or client transport wrapped around the ISC codec.

"use strict";

const net = require("net");
const { makeCodec } = require("./codec.js");

module.exports = function (RED) {
    function CrestronISCNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const mode = (config.mode || "server").toLowerCase();
        const port = parseInt(config.port, 10) || 49152;
        const host = (config.host || "").trim();
        const reconnectMs = parseInt(config.reconnectMs, 10) || 3000;

        const totalAnalogSignals = (() => {
            const n = Number(config.totalAnalogSignals);
            if (!Number.isFinite(n)) {
                node.warn(`Invalid Total Analog Signals "${config.totalAnalogSignals}", using 0`);
                return 0;
            }
            return Math.trunc(n);
        })();

        const codec = makeCodec({ warn: (m) => node.warn(m) });

        const sockets = new Set();           // every live socket
        const rxState = new Map();           // socket -> { rx: Buffer }

        let server = null;
        let reconnectTimer = null;
        let closing = false;

        function attachSocket(sock, label) {
            sockets.add(sock);
            rxState.set(sock, { rx: Buffer.alloc(0) });

            sock.on("data", (chunk) => {
                const state = rxState.get(sock);
                if (!state) return;
                codec.decode(chunk, state, totalAnalogSignals, (m) => node.send(m));
            });

            sock.on("close", () => {
                sockets.delete(sock);
                rxState.delete(sock);
                onDisconnect(label);
            });

            sock.on("error", (err) => {
                node.warn(`ISC socket error (${label}): ${err.message}`);
            });
        }

        function startServer() {
            server = net.createServer((sock) => {
                const label = `${sock.remoteAddress}:${sock.remotePort}`;
                attachSocket(sock, label);
                node.status({ fill: "green", shape: "dot", text: `connected: ${sockets.size}` });
            });

            server.on("error", (err) => {
                node.error(`ISC server error: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: `error: ${err.code || err.message}` });
            });

            server.listen(port, () => {
                node.status({ fill: "blue", shape: "ring", text: `listening :${port}` });
            });
        }

        function startClient() {
            if (closing) return;

            const sock = new net.Socket();
            attachSocket(sock, `${host}:${port}`);

            sock.connect(port, host, () => {
                node.status({ fill: "green", shape: "dot", text: `connected ${host}:${port}` });
            });
        }

        function onDisconnect() {
            if (mode === "server") {
                if (sockets.size === 0) {
                    node.status({ fill: "blue", shape: "ring", text: `listening :${port}` });
                } else {
                    node.status({ fill: "green", shape: "dot", text: `connected: ${sockets.size}` });
                }
                return;
            }

            if (closing) return;

            node.status({ fill: "yellow", shape: "ring", text: `reconnect in ${Math.round(reconnectMs / 1000)}s` });
            reconnectTimer = setTimeout(startClient, reconnectMs);
        }

        // Outgoing: encode and broadcast to every connected client.
        node.on("input", (msg, send, done) => {
            const buf = codec.encode(msg, totalAnalogSignals);

            if (buf) {
                if (sockets.size === 0) {
                    node.warn("ISC: no connected client; dropping outgoing frame");
                } else {
                    for (const s of sockets) {
                        if (!s.destroyed) s.write(buf);
                    }
                }
            }

            done();
        });

        node.on("close", (done) => {
            closing = true;

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            for (const s of sockets) {
                try { s.destroy(); } catch (_) { /* ignore */ }
            }
            sockets.clear();
            rxState.clear();

            if (server) {
                server.close(() => done());
                server = null;
            } else {
                done();
            }
        });

        if (mode === "server") {
            startServer();
        } else if (host) {
            startClient();
        } else {
            node.error("ISC client mode requires a host");
            node.status({ fill: "red", shape: "ring", text: "missing host" });
        }
    }

    RED.nodes.registerType("crestron-isc", CrestronISCNode);
};
