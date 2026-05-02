# node-red-contrib-crestron-isc

A Node-RED node that speaks the Crestron ISC (Intersystems Communications) protocol over TCP.

## Install

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-crestron-isc
```

Or, for development:

```bash
cd /path/to/node-red-contrib-crestron-isc
npm link
cd ~/.node-red
npm link node-red-contrib-crestron-isc
```

Then restart Node-RED. The **Crestron ISC** node appears in the *network* category of the palette.

## Usage

Drop one node, configure it, then wire upstream producers into its input and downstream consumers
from its output.

### Inputs

| `msg` field | type                              | meaning                                                  |
|-------------|-----------------------------------|----------------------------------------------------------|
| `topic`     | `"digital"` / `"analog"` / `"serial"` | ISC signal type to send                              |
| `channel`   | number, or array of numbers       | Signal channel (1-indexed)                               |
| `payload`   | boolean / number / string / array | Signal value (see below); arrays parallel `channel`      |

Per-topic payload types:

- **digital**: boolean (or 0/1)
- **analog**: integer 0..65535
- **serial**: latin1 string, non-empty, no `0xFF` bytes

### Outputs

One `msg` per decoded ISC frame, with `topic`, `channel`, and `payload` populated using the same
conventions.

## Configuration

| Field                  | Default  | Notes                                                              |
|------------------------|----------|--------------------------------------------------------------------|
| Mode                   | server   | `Server (listen)` accepts incoming connections; `Client (connect)` dials out |
| Host                   | —        | Client mode only: the Crestron processor's IP                      |
| Port                   | 49152    | TCP port (1..65535)                                                |
| Reconnect (ms)         | 3000     | Client mode only: wait between reconnect attempts                  |
| Total Analog Signals   | 0        | Total count of analog + serial signals on the ISC symbol           |

**Total Analog Signals** must match the count of analog + serial signals defined on the Crestron
ISC symbol in the SIMPL program. Both sides of the symbol must have identical quantities. This
value is used as the digital channel offset in the wire protocol.

## Multi-client behavior

In server mode, encoded frames are **broadcast to every connected client**. Incoming bytes are
buffered per-connection, so frames from different peers cannot interleave. ISC is normally a
one-to-one peer link, so broadcast collapses to unicast in typical use, but it allows tools (e.g.
a tester or monitor) to connect alongside a live Crestron without bumping anyone off.

## Status indicator

| Color  | Shape | Meaning                                          |
|--------|-------|--------------------------------------------------|
| blue   | ring  | Server: listening on the port                    |
| green  | dot   | One or more clients connected                    |
| yellow | ring  | Client mode: waiting to reconnect                |
| red    | ring  | Error (port in use, missing host, socket error)  |

## License

MIT
