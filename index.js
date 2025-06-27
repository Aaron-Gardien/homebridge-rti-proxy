const axios = require('axios');
const WebSocket = require('ws');
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
    this.api.on('didFinishLaunching', () => this.startProxy());
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
    });
    homebridge_ws.on('message', (data) => {
      let text = (Buffer.isBuffer(data) ? data.toString() : data);
      if (text === '2') {
        homebridge_ws.send('3'); // Pong
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
