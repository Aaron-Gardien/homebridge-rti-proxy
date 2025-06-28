const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
const app = express();
const ACCESSORY_PORT = 9100; // You can change this port if needed
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
    this.clients = [];
    this.lastAccessoriesData = null;

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
      if (!this.lastAccessoriesData) {
        return res.send('<h1>No accessory data yet.</h1>');
      }
      let rows = this.lastAccessoriesData.map(acc => `
        <tr>
          <td>${acc.uniqueId}</td>
          <td>${acc.type}</td>
          <td>${acc.humanType || ''}</td>
          <td>${acc.serviceName}</td>
        </tr>
      `).join('');
      res.send(`
        <html>
        <head><title>Homebridge Accessories</title></head>
        <body>
          <h1>Discovered Accessories</h1>
          <table border="1" cellpadding="4" cellspacing="0">
            <tr><th>Unique ID</th><th>Type</th><th>Human Type</th><th>Name</th></tr>
            ${rows}
          </table>
        </body>
        </html>
      `);
    });

    app.listen(ACCESSORY_PORT, () => {
      console.log(`Accessory list HTTP server at http://localhost:${ACCESSORY_PORT}/accessories`);
      console.log(`Tabular HTML: http://localhost:${ACCESSORY_PORT}/accessories/table`);
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
            this.lastAccessoriesData = eventData;
          }
          const outgoing = JSON.stringify({ event, data: eventData });
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
      setTimeout(() => this.startProxy(), 10000);
    });
    homebridge_ws.on('error', (err) => {
      this.log('Homebridge WS error:', err.message);
      homebridge_ws.terminate();
    });

    const wss = new WebSocket.Server({ port: this.proxyPort }, () => {
      this.log(`RTI Proxy WebSocket listening on ws://localhost:${this.proxyPort}`);
    });

    wss.on('connection', ws => {
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
        if (homebridge_ws.readyState === WebSocket.OPEN) {
          homebridge_ws.send(msg);
        }
      });
    });
  }
}
