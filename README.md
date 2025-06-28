# homebridge-rti-proxy (Managed External Proxy)

This Homebridge plugin launches a proven external proxy as a background process.
- **Plugin-style** install/configure (via Homebridge UI)
- **Real-time push and/or polling** from Homebridge to RTI, Postman, etc.

## Usage

1. Install using Homebridge UI or npm.
2. Configure username, password, proxyPort, etc.
3. On Homebridge start, the proxy runs as a background Node.js process.

## Configuration example

```json
"platforms": [
  {
    "platform": "RtiProxy",
    "username": "admin",
    "password": "admin",
    "proxyPort": 9001
  }
]
