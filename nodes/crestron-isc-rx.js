// Crestron ISC RX — decoder only. Takes a Buffer (or Buffer-like) on msg.payload,
// emits one msg per decoded frame with topic/channel/payload set. No transport — the
// user wires the input from whatever Node-RED node delivers the bytes (serial port,
// RS232/RS485, MQTT, raw TCP, etc.).
//
// Hardening for unreliable transports (RS232/RS485):
//   - maxBuffer:     hard cap on the partial-frame buffer; auto-resync on overflow.
//   - idleTimeoutMs: if no input arrives for this long while we have buffered partial
//                    bytes, flush them. Use when the upstream stream may stall mid-frame.
//   - msg.reset:     send a message with `msg.reset === true` to flush manually (e.g. on
//                    serial-port-close, link-down, or watchdog tick).
//
// State note: rx-buffer accumulation is per node instance. If you have multiple
// independent byte streams, drop one decoder node per stream — frames from different
// streams will interleave and corrupt if mixed through one decoder.

"use strict";

const { makeCodec } = require("./codec.js");

module.exports = function (RED) {
    function CrestronISCRxNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const totalAnalogSignals = (() => {
            const n = Number(config.totalAnalogSignals);
            if (!Number.isFinite(n)) {
                node.warn(`Invalid Total Analog Signals "${config.totalAnalogSignals}", using 1`);
                return 1;
            }
            return Math.trunc(n);
        })();

        const maxBuffer = (() => {
            const n = Number(config.maxBuffer);
            return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 4096;
        })();

        const idleTimeoutMs = (() => {
            const n = Number(config.idleTimeoutMs);
            return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
        })();

        const codec = makeCodec({
            warn: (m) => node.warn(m),
            maxBuffer
        });

        const state = { rx: Buffer.alloc(0) };
        let idleTimer = null;

        function clearIdleTimer() {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        }

        function armIdleTimer() {
            clearIdleTimer();
            if (idleTimeoutMs > 0 && state.rx.length > 0) {
                idleTimer = setTimeout(() => {
                    if (state.rx.length > 0) {
                        node.warn(`RX idle timeout (${idleTimeoutMs}ms); discarding ${state.rx.length} buffered bytes`);
                        state.rx = Buffer.alloc(0);
                    }
                    idleTimer = null;
                }, idleTimeoutMs);
            }
        }

        node.on("input", (msg, send, done) => {
            if (msg && msg.reset === true) {
                if (state.rx.length > 0) {
                    node.warn(`RX reset; discarding ${state.rx.length} buffered bytes`);
                    state.rx = Buffer.alloc(0);
                }
                clearIdleTimer();
                done();
                return;
            }

            codec.decode(msg.payload, state, totalAnalogSignals, (decoded) => {
                const out = RED.util.cloneMessage(msg);
                out.topic = decoded.topic;
                out.channel = decoded.channel;
                out.payload = decoded.payload;
                send(out);
            });

            armIdleTimer();

            done();
        });

        node.on("close", () => {
            clearIdleTimer();
            state.rx = Buffer.alloc(0);
        });
    }

    RED.nodes.registerType("crestron-isc-rx", CrestronISCRxNode);
};
