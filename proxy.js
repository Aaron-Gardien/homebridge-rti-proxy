const minimist = require('minimist');
const argv = minimist(process.argv.slice(2));
const axios = require('axios');
const WebSocket = require('ws');
const io = require('socket.io-client');

const HOMEBRIDGE_HOST = argv.homebridgeHost || '127.0.0.1';
const HOMEBRIDGE_PORT = argv.homebridgePort || 8581;
const PROXY_PORT = argv.proxyPort || 9001;
const HB_USER = argv.username || 'admin';
const HB_PASS = argv.password || 'admin';
const HB_OTP  = argv.otp || '';

let access_token = null;
let token_expiry = 0;
let clients = [];
let lastAccessoriesData = null;

async function getBearerToken() {
  try {
    const resp = await axios.post(
      `http://${HOMEBRIDGE_HOST}:${HOMEBRIDGE_PORT}/api/auth/login`,
      { username: HB_USER, password: HB_PASS, otp: HB_OTP },
      { headers: { 'Content-Type': 'application/json', 'accept': '*/*' } }
    );
    access_token = resp.data.access_token;
    token_expiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    console.log('Obtained token:', access_token.slice(0, 16), '...');
    return access_token;
  } catch (err) {
    console.error('Token fetch failed:', err);
    throw err;
  }
}

async function startProxy() {
  if (!access_token || Date.now() > token_expiry) {
    await getBearerToken();
  }
  const wsPath = `/socket.io/?token=${access_token}&EIO=4&transport=websocket`;
  const homebridgeURL = `ws://${HOMEBRIDGE_HOST}:${HOMEBRIDGE_PORT}${wsPath}`;
  const homebridge_ws = new WebSocket(homebridgeURL);

  homebridge_ws.on('open', () => {
    console.log('Connected to Homebridge Socket.IO');
    homebridge_ws.send('40/accessories,');
    setTimeout(() => {
      homebridge_ws.send('42/accessories,["get-accessories"]');
    }, 250);

    // Poll every 2s for robust updates (remove if you have push!)
    setInterval(() => {
      if (homebridge_ws.readyState === WebSocket.OPEN) {
        homebridge_ws.send('42/accessories,["get-accessories"]');
      }
    }, 2000);
  });

  homebridge_ws.on('message', (data) => {
    let text = Buffer.isBuffer(data) ? data.toString() : data;
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
          lastAccessoriesData = eventData;
        }
        const outgoing = JSON.stringify({ event, data: eventData });
        clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) client.send(outgoing);
        });
      } catch (err) {
        console.error('Failed to parse frame:', err, text);
      }
    }
  });

  homebridge_ws.on('close', () => {
    console.log('Homebridge Socket.IO closed, reconnecting in 10s...');
    setTimeout(() => startProxy(), 10000);
  });
  homebridge_ws.on('error', (err) => {
    console.error('Homebridge WS error:', err.message);
    homebridge_ws.terminate();
  });

  const wss = new WebSocket.Server({ port: PROXY_PORT }, () => {
    console.log(`RTI Proxy WebSocket listening on ws://localhost:${PROXY_PORT}`);
  });
  wss.on('connection', ws => {
    console.log('RTI/Web client connected');
    clients.push(ws);
    if (lastAccessoriesData) {
      ws.send(JSON.stringify({ event: "accessories-data", data: lastAccessoriesData }));
    }
    ws.on('close', () => {
      clients = clients.filter(c => c !== ws);
      console.log('RTI/Web client disconnected');
    });
    ws.on('message', msg => {
      if (homebridge_ws.readyState === WebSocket.OPEN) {
        homebridge_ws.send(msg);
      }
    });
  });
}

startProxy().catch(console.error);
