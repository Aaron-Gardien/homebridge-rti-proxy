# homebridge-rti-proxy

A Homebridge plugin that provides a real-time, JSON-over-WebSocket proxy for all Homebridge accessories—so RTI, Postman, or any client can receive state updates instantly.

## Usage

1. Install using the Homebridge UI (from npm or locally).
2. Configure your Homebridge username, password, and proxy port.
3. Connect any client to `ws://<homebridge-ip>:9001`
4. You will receive:
   ```json
   { "event": "accessories-data", "data": [ ... ] }