// Crestron ISC codec (encode + decode), lifted from the verified subflow function nodes
// isc_tx_new and isc_rx_new. Pure CommonJS — no Node-RED globals. The warn callback is
// injected so the existing diagnostic messages survive the move.

"use strict";

function makeCodec(options) {
    const warn = (options && options.warn) || (() => {});

    // --- HELPERS ---

    function toInt(v, label) {
        if (typeof v === "boolean") return v ? 1 : 0;

        const n = Number.parseInt(v, 10);

        if (!Number.isFinite(n)) {
            warn(`Invalid ${label}: ${v}`);
            return null;
        }

        return n;
    }

    function getAt(v, isArray, i) {
        return isArray ? v[i] : v;
    }

    // --- ISC FRAME BUILDERS ---

    function fnISCdigital(chan, val, offset) {
        chan = toInt(chan, "digital channel");
        val = toInt(val, "digital value");

        if (chan === null || val === null) return null;

        if (val !== 0 && val !== 1) {
            warn(`Digital value must be 0 or 1 (or boolean): ${val}`);
            return null;
        }

        // Channels are 1-indexed; wire field is 12 bits, so user max = 4096 - offset.
        const maxChan = 0x1000 - offset;

        if (chan < 1 || chan > maxChan) {
            warn(`Digital channel out of range (1..${maxChan} with offset=${offset}): ${chan}`);
            return null;
        }

        chan = chan + offset - 1;

        const idx = ((chan << 1) & 0x1F00) | (chan & 0x7F);
        const an = (((val & 0x01) ^ 0x01) << 13);
        const x = (0x8000 | idx | an) & 0xFFFF;

        const buf = Buffer.allocUnsafe(2);
        buf[0] = (x >> 8) & 0xFF;
        buf[1] = x & 0xFF;

        return buf;
    }

    function fnISCanalog(chan, val) {
        chan = toInt(chan, "analog channel");
        val = toInt(val, "analog value");

        if (chan === null || val === null) return null;

        // Channel field is 10 bits → user max = 1024 (after the chan-1 offset).
        if (chan < 1 || chan > 0x400) {
            warn(`Analog channel out of range (1..1024): ${chan}`);
            return null;
        }

        // Value field is 16 bits unsigned.
        if (val < 0 || val > 0xFFFF) {
            warn(`Analog value out of range (0..65535): ${val}`);
            return null;
        }

        chan = chan - 1;

        const idx = ((((chan << 1) & 0x0700) | (chan & 0x7F)) << 16) >>> 0;
        const an = (((val & 0xC000) << 14) | ((val & 0x3F80) << 1) | (val & 0x7F)) >>> 0;
        const x = (0xC0000000 | idx | an) >>> 0;

        const buf = Buffer.allocUnsafe(4);
        buf[0] = (x >>> 24) & 0xFF;
        buf[1] = (x >>> 16) & 0xFF;
        buf[2] = (x >>> 8) & 0xFF;
        buf[3] = x & 0xFF;

        return buf;
    }

    function fnISCserial(chan, val) {
        chan = toInt(chan, "serial channel");

        if (chan === null) return null;

        // Channel field is 10 bits → user max = 1024 (after the chan-1 offset).
        if (chan < 1 || chan > 0x400) {
            warn(`Serial channel out of range (1..1024): ${chan}`);
            return null;
        }

        if (val === undefined || val === null) {
            warn("Invalid serial payload");
            return null;
        }

        const data = Buffer.isBuffer(val)
            ? val
            : Buffer.from(String(val), "latin1");

        if (data.length === 0) {
            warn("Serial payload is empty; decoder drops zero-length frames");
            return null;
        }

        // 0xFF is the frame terminator; any 0xFF in the payload truncates the frame on decode.
        if (data.indexOf(0xFF) !== -1) {
            warn("Serial payload contains 0xFF; this would terminate the frame early");
            return null;
        }

        chan = chan - 1;

        const idx = ((chan << 1) & 0x0700) | (chan & 0x7F);
        const x = (0xC800 | idx) & 0xFFFF;

        const buf = Buffer.allocUnsafe(2 + data.length + 1);

        buf[0] = (x >> 8) & 0xFF;
        buf[1] = x & 0xFF;

        data.copy(buf, 2);

        buf[buf.length - 1] = 0xFF;

        return buf;
    }

    function ISC(topic, channel, payload, offset) {
        switch (String(topic).toLowerCase()) {
            case "digital":
                return fnISCdigital(channel, payload, offset);

            case "analog":
                return fnISCanalog(channel, payload);

            case "serial":
                return fnISCserial(channel, payload);

            default:
                warn(`Unsupported ISC topic: ${topic}`);
                return null;
        }
    }

    // Encode an outgoing message into a Buffer (or null).
    // Supports either a single value or parallel arrays for msg.payload + msg.channel.
    function encode(msg, offset) {
        const payloadIsArray = Array.isArray(msg.payload);
        const channelIsArray = Array.isArray(msg.channel);

        const payloadLen = payloadIsArray ? msg.payload.length : 1;
        const channelLen = channelIsArray ? msg.channel.length : 1;

        if (payloadLen === 0) {
            warn("msg.payload is an empty array");
            return null;
        }

        if (channelLen === 0) {
            warn("msg.channel is an empty array");
            return null;
        }

        let count;

        if (payloadIsArray && channelIsArray) {
            count = Math.min(payloadLen, channelLen);

            if (payloadLen !== channelLen) {
                warn(`payload/channel length mismatch: payload=${payloadLen}, channel=${channelLen}; using ${count}`);
            }
        } else {
            count = payloadIsArray ? payloadLen : channelIsArray ? channelLen : 1;
        }

        const chunks = [];

        for (let i = 0; i < count; i++) {
            const payload = getAt(msg.payload, payloadIsArray, i);
            const channel = getAt(msg.channel, channelIsArray, i);

            const buf = ISC(msg.topic, channel, payload, offset);

            if (buf) {
                chunks.push(buf);
            }
        }

        if (!chunks.length) {
            warn("No ISC frames generated");
            return null;
        }

        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    }

    // --- DECODER ---

    function asBuffer(value) {
        if (Buffer.isBuffer(value)) return value;
        if (value instanceof Uint8Array) return Buffer.from(value);
        if (Array.isArray(value)) return Buffer.from(value);
        if (value === undefined || value === null) return Buffer.alloc(0);

        try {
            return Buffer.from(value);
        } catch (err) {
            warn(`Unable to convert incoming bytes to Buffer: ${err.message}`);
            return null;
        }
    }

    const isDigitalStart = (b) => (b & 0xC0) === 0x80;
    const isAnalogStart  = (b) => (b & 0xC8) === 0xC0;
    const isSerialStart  = (b) => (b & 0xC8) === 0xC8;
    const hasHighBit     = (b) => (b & 0x80) !== 0;

    // Decode bytes against a per-stream rx-buffer state.
    //   incoming: Buffer of newly-arrived bytes
    //   state:    { rx: Buffer } — mutated; holds incomplete trailing frame
    //   offset:   number — digital offset (analog/serial ignored)
    //   emit:     fn(msg) called once per decoded frame
    function decode(incoming, state, offset, emit) {
        const inc = asBuffer(incoming);
        if (!inc) return;

        const previous = state && state.rx ? state.rx : Buffer.alloc(0);

        let RX;
        if (previous.length && inc.length) {
            RX = Buffer.concat([previous, inc]);
        } else if (previous.length) {
            RX = previous;
        } else {
            RX = inc;
        }

        if (!RX.length) {
            if (state) state.rx = Buffer.alloc(0);
            return;
        }

        let i = 0;
        let remainder = null;

        while (i < RX.length) {
            const b0 = RX[i];

            // --- DIGITAL: 2 bytes ---
            if (isDigitalStart(b0)) {
                if (RX.length - i < 2) {
                    remainder = RX.slice(i);
                    break;
                }

                const b1 = RX[i + 1];

                if (hasHighBit(b1)) {
                    i++;
                    continue;
                }

                const channel = (((b0 & 0x1F) << 7) | (b1 & 0x7F)) + 1 - offset;
                const value = (((b0 & 0x20) >> 5) ^ 0x01) === 1;

                emit({
                    topic: "digital",
                    channel,
                    payload: value
                });

                i += 2;
                continue;
            }

            // --- ANALOG: 4 bytes ---
            if (isAnalogStart(b0)) {
                if (RX.length - i < 4) {
                    remainder = RX.slice(i);
                    break;
                }

                const b1 = RX[i + 1];
                const b2 = RX[i + 2];
                const b3 = RX[i + 3];

                if (hasHighBit(b1) || hasHighBit(b2) || hasHighBit(b3)) {
                    i++;
                    continue;
                }

                const channel = (((b0 & 0x07) << 7) | (b1 & 0x7F)) + 1;
                const value = (((b0 & 0x30) << 10) | ((b2 & 0x7F) << 7) | (b3 & 0x7F)) | 0;

                emit({
                    topic: "analog",
                    channel,
                    payload: value
                });

                i += 4;
                continue;
            }

            // --- SERIAL: 2-byte header + data + 0xFF ---
            if (isSerialStart(b0)) {
                if (RX.length - i < 2) {
                    remainder = RX.slice(i);
                    break;
                }

                const b1 = RX[i + 1];

                if (hasHighBit(b1)) {
                    i++;
                    continue;
                }

                const eos = RX.indexOf(0xFF, i + 2);

                if (eos < 0) {
                    remainder = RX.slice(i);
                    break;
                }

                const data = RX.slice(i + 2, eos);

                if (data.length) {
                    const channel = (((b0 & 0x07) << 7) | (b1 & 0x7F)) + 1;

                    emit({
                        topic: "serial",
                        channel,
                        payload: data.toString("latin1")
                    });
                }

                i = eos + 1;
                continue;
            }

            // Unknown byte — skip and keep scanning.
            i++;
        }

        if (state) {
            state.rx = remainder && remainder.length ? remainder : Buffer.alloc(0);
        }
    }

    return { encode, decode };
}

module.exports = { makeCodec };
