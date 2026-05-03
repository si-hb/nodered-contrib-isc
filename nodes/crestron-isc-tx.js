// Crestron ISC TX — encoder only. Takes a msg with topic/channel/payload and outputs
// the encoded ISC byte frame as msg.payload (a Buffer). No transport — the user wires
// the output to whatever serial/RS232/RS485/MQTT/etc. node they need.

"use strict";

const { makeCodec } = require("./codec.js");

module.exports = function (RED) {
    function CrestronISCTxNode(config) {
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

        const codec = makeCodec({ warn: (m) => node.warn(m) });

        node.on("input", (msg, send, done) => {
            const buf = codec.encode(msg, totalAnalogSignals);

            if (buf) {
                msg.payload = buf;
                send(msg);
            }

            done();
        });
    }

    RED.nodes.registerType("crestron-isc-tx", CrestronISCTxNode);
};
