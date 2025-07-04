const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const app = express();
let io;
try { io = require('socket.io-client'); } catch (e) { io = null; }

module.exports = (homebridge) => {
  homebridge.registerPlatform('HomebridgeRtiProxy', 'RtiProxy', RtiProxyPlatform);
};

class RtiProxyPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.homebridgeHost = this.config.homebridgeHost || '127.0.0.1';
    this.homebridgePort = this.config.homebridgePort || 8581;
    this.username = this.config.username || 'admin';
    this.password = this.config.password || 'admin';
    this.otp = this.config.otp || '';
    this.proxyPort = this.config.proxyPort || 9001;
    this.accessoryPort = this.config.accessoryPort || 9100;
    this.clients = [];
    this.lastAccessoriesData = null;
    this.accessoryList = [];
    this.wss = null; // Track the WebSocket server instance

    // Start HTTP endpoint for accessory list
    this.setupHttpEndpoint();

    this.api.on('didFinishLaunching', () => this.startProxy());
  }

  setupHttpEndpoint() {
    // JSON endpoint
    app.get('/accessories', (req, res) => {
      if (this.lastAccessoriesData) {
        res.json({ accessories: this.lastAccessoriesData });
      } else {
        res.status(503).json({ error: "No accessory data yet. Please try again shortly." });
      }
    });

    // HTML table endpoint
    app.get('/accessories/table', (req, res) => {
      if (!this.accessoryList || this.accessoryList.length === 0) {
        return res.send('<h1>No accessory data yet.</h1>');
      }
      // Filter out ProtocolInformation and map details
      let rows = this.accessoryList
        .filter(acc => acc.type !== "ProtocolInformation")
        .map(acc => {
          let charTypes = (acc.serviceCharacteristics || []).map(c => c.type);
          let details = '';
          if (charTypes.includes("Hue") && charTypes.includes("Saturation")) {
            details = 'RGBW Light';
          } else if (charTypes.includes("Brightness")) {
            details = 'Dimmable Light';
          } else if (charTypes.includes("On")) {
            details = 'Switch';
          }
          return `
            <tr>
              <td>${acc.uniqueId}</td>
              <td>${acc.type}</td>
              <td>${acc.humanType || ''}</td>
              <td>${acc.serviceName}</td>
              <td>${details}</td>
            </tr>
          `;
        }).join('');
      res.send(`
        <html>
        <head><title>Homebridge Accessories</title></head>
        <body>
          <h1>Discovered Accessories</h1>
          <table border="1" cellpadding="4" cellspacing="0">
            <tr>
              <th>Unique ID</th><th>Type</th><th>Human Type</th><th>Name</th><th>Details</th>
            </tr>
            ${rows}
          </table>
        </body>
        </html>
      `);
    });

    app.listen(this.accessoryPort, () => {
      console.log(`Accessory list HTTP server at http://localhost:${this.accessoryPort}/accessories`);
      console.log(`Tabular HTML: http://localhost:${this.accessoryPort}/accessories/table`);
    });
  }

  async getBearerToken() {
    try {
      const url = `http://${this.homebridgeHost}:${this.homebridgePort}/api/auth/login`;
      const resp = await axios.post(url, {
        username: this.username,
        password: this.password,
        otp: this.otp
      }, {
        headers: { 'Content-Type': 'application/json', 'accept': '*/*' }
      });
      this.access_token = resp.data.access_token;
      this.token_expiry = Date.now() + (resp.data.expires_in - 60) * 1000;
      this.log('Obtained token:', this.access_token.slice(0, 12), '...');
      return this.access_token;
    } catch (err) {
      this.log('Token fetch failed:', err.message);
      throw err;
    }
  }

  async startProxy() {
    if (!io) {
      this.log('socket.io-client is missing! Did you run npm install?');
      return;
    }
    await this.getBearerToken();
    const wsPath = `/socket.io/?token=${this.access_token}&EIO=4&transport=websocket`;
    const homebridgeURL = `ws://${this.homebridgeHost}:${this.homebridgePort}${wsPath}`;
    const homebridge_ws = new WebSocket(homebridgeURL);

    homebridge_ws.on('open', () => {
      this.log('Connected to Homebridge Socket.IO');
      homebridge_ws.send('40/accessories,');
      setTimeout(() => {
        homebridge_ws.send('42/accessories,["get-accessories"]');
      }, 250);

      // --- (OPTIONAL) Poll every 5s for state, uncomment if you never get push updates ---
      /*
      setInterval(() => {
        if (homebridge_ws.readyState === WebSocket.OPEN) {
          homebridge_ws.send('42/accessories,["get-accessories"]');
        }
      }, 5000);
      */
    });

    homebridge_ws.on('message', (data) => {
      let text = (Buffer.isBuffer(data) ? data.toString() : data);
      this.log('[HomebridgeWS]', text);

      if (text === '2') {
        homebridge_ws.send('3');
        return;
      }
      if (text.startsWith('42/accessories,')) {
        try {
          const payload = JSON.parse(text.slice('42/accessories,'.length));
          const event = payload[0];
          const eventData = payload[1];
          if (event === "accessories-data") {
            // Merge logic: update or insert accessories, don't overwrite unless full list
            if (this.accessoryList.length === 0 || eventData.length >= this.accessoryList.length) {
              this.accessoryList = eventData;
              this.log('Stored full accessories list, count:', this.accessoryList.length);
            } else {
              // Partial update: merge by uniqueId if present, else by aid+iid
              for (let i = 0; i < eventData.length; i++) {
                const newAcc = eventData[i];
                let found = false;
                for (let j = 0; j < this.accessoryList.length; j++) {
                  const oldAcc = this.accessoryList[j];
                  if ((newAcc.uniqueId && oldAcc.uniqueId && newAcc.uniqueId === oldAcc.uniqueId) ||
                      (newAcc.aid === oldAcc.aid && newAcc.iid === oldAcc.iid)) {
                    this.accessoryList[j] = newAcc;
                    found = true;
                    break;
                  }
                }
                if (!found) this.accessoryList.push(newAcc);
              }
              this.log('Merged partial accessories-data update, total count:', this.accessoryList.length);
            }
            this.lastAccessoriesData = this.accessoryList;
          }
          const outgoing = JSON.stringify({ event, data: this.lastAccessoriesData });
          this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(outgoing);
          });
        } catch (err) {
          this.log('Failed to parse frame:', err.message, text);
        }
      }
    });

    homebridge_ws.on('close', () => {
      this.log('Homebridge Socket.IO closed, reconnecting in 10s...');
      // Clean up the WebSocket server before restarting
      if (this.wss) {
        try {
          this.wss.close(() => {
            this.log('Closed previous RTI Proxy WebSocket server.');
          });
        } catch (err) {
          this.log('Error closing previous WebSocket server:', err.message);
        }
        this.wss = null;
      }
      setTimeout(() => this.startProxy(), 10000);
    });
    homebridge_ws.on('error', (err) => {
      this.log('Homebridge WS error:', err.message);
      homebridge_ws.terminate();
    });

    // Only create a new WebSocket server if one doesn't already exist
    if (!this.wss) {
      this.wss = new WebSocket.Server({ port: this.proxyPort }, () => {
        this.log(`RTI Proxy WebSocket listening on ws://localhost:${this.proxyPort}`);
      });

      this.wss.on('connection', ws => {
        this.log('RTI/Web client connected');
        this.clients.push(ws);
        if (this.lastAccessoriesData) {
          ws.send(JSON.stringify({ event: "accessories-data", data: this.lastAccessoriesData }));
        }
        ws.on('close', () => {
          this.clients = this.clients.filter(c => c !== ws);
          this.log('RTI/Web client disconnected');
        });
        ws.on('message', msg => {
          try {
            let msgType = typeof msg;
            let msgContent = msg;
            if (Buffer.isBuffer(msg)) {
              msgType = 'Buffer';
              msgContent = msg.toString();
            }
            this.log('Received from RTI/Web client:', `[type: ${msgType}]`, msgContent);
            if (homebridge_ws.readyState === WebSocket.OPEN) {
              if (typeof msgContent !== 'string') {
                this.log('Received non-string message from RTI/Web client:', msgContent);
                return;
              }
              this.log('Forwarding message from RTI/Web client to Homebridge:', msgContent);
              homebridge_ws.send(msgContent);
            } else {
              this.log('Homebridge WebSocket not open, cannot forward message');
            }
          } catch (err) {
            this.log('Error handling RTI/Web client message:', err.message, msg);
          }
        });
      });
    }
  }
}
