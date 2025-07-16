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
    this.accessoryStates = new Map(); // Track parsed accessory states for change detection
    this.parsedAccessories = new Map(); // Cache parsed accessory data
    this.accessoryLookup = new Map(); // uniqueId -> accessory data
    this.characteristicLookup = new Map(); // uniqueId -> characteristics map

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
            // Process accessory data and detect changes
            const { changes, allAccessories } = this.processAccessoryData(eventData);
            
            // Update the accessory list for the HTTP endpoint
            this.accessoryList = eventData;
            this.lastAccessoriesData = this.accessoryList;
            
            // Build lookup maps for command translation
            this.buildAccessoryLookups();
            
            // Send only changed data to WebSocket clients for efficiency
            if (changes.length > 0) {
              const changeNotifications = this.createChangeNotification(changes);
              
              // Send each individual characteristic update
              changeNotifications.forEach(notification => {
                this.sendToClients(notification);
              });
              
              this.log(`Sent ${changeNotifications.length} accessory-update messages to WebSocket clients`);
            }
            
            // Also send full state to any newly connected clients
            const fullStateMessage = {
              event: "full-state",
              data: allAccessories,
              timestamp: Date.now()
            };
            
            // Send full state to clients that might need it (e.g., new connections)
            this.clients.forEach(client => {
              if (client.needsFullState) {
                client.send(JSON.stringify(fullStateMessage));
                client.needsFullState = false;
              }
            });
          }
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
        ws.needsFullState = true; // Mark new clients as needing full state
        this.clients.push(ws);
        
        // Send full state to the new client
        if (this.parsedAccessories.size > 0) {
          const fullStateMessage = {
            event: "full-state",
            data: this.getAllAccessoryStates(),
            timestamp: Date.now()
          };
          ws.send(JSON.stringify(fullStateMessage));
          ws.needsFullState = false;
        } else if (this.lastAccessoriesData) {
          // Fallback to old format if no parsed data yet
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
              
              // Process user-friendly commands
              const commandResult = this.processUserCommand(msgContent);
              
              if (commandResult.isUserCommand) {
                if (commandResult.error) {
                  // Send error response back to client
                  ws.send(JSON.stringify({
                    event: "command-error",
                    error: commandResult.error
                  }));
                  return;
                } else {
                  // Send translated command to Homebridge
                  this.log('Translated user command to Homebridge format:', commandResult.homebridgeCommand);
                  homebridge_ws.send(commandResult.homebridgeCommand);
                  
                  // Send success response back to client
                  ws.send(JSON.stringify({
                    event: "command-success",
                    message: "Command sent successfully"
                  }));
                }
              } else {
                // Forward original command (raw Socket.IO format)
                this.log('Forwarding raw command from RTI/Web client to Homebridge:', msgContent);
                homebridge_ws.send(commandResult.originalCommand);
              }
            } else {
              this.log('Homebridge WebSocket not open, cannot forward message');
              ws.send(JSON.stringify({
                event: "command-error",
                error: "Homebridge connection not available"
              }));
            }
          } catch (err) {
            this.log('Error handling RTI/Web client message:', err.message, msg);
            ws.send(JSON.stringify({
              event: "command-error",
              error: "Failed to process command: " + err.message
            }));
          }
        });
      });
    }
  }

  // Parse accessory data into a more efficient format
  parseAccessory(accessory) {
    const parsed = {
      uniqueId: accessory.uniqueId,
      aid: accessory.aid,
      iid: accessory.iid,
      type: accessory.type,
      serviceName: accessory.serviceName,
      humanType: accessory.humanType,
      characteristics: {}
    };

    // Parse service characteristics
    if (accessory.serviceCharacteristics) {
      accessory.serviceCharacteristics.forEach(char => {
        const key = char.type;
        parsed.characteristics[key] = {
          value: char.value,
          format: char.format,
          perms: char.perms,
          description: char.description,
          unit: char.unit,
          minValue: char.minValue,
          maxValue: char.minValue,
          minStep: char.minStep
        };
      });
    }

    return parsed;
  }

  // Compare two accessory states to detect changes - return changed characteristics
  hasStateChanged(oldState, newState) {
    if (!oldState || !newState) return { changed: true, changedChars: newState.characteristics || {} };
    
    const oldChars = oldState.characteristics || {};
    const newChars = newState.characteristics || {};
    const changedChars = {};
    let hasChanges = false;
    
    // Check for new or changed characteristics
    for (const [key, newChar] of Object.entries(newChars)) {
      if (!oldChars[key] || oldChars[key].value !== newChar.value) {
        changedChars[key] = newChar;
        hasChanges = true;
      }
    }
    
    return { changed: hasChanges, changedChars };
  }

  // Create efficient change notification - send individual characteristic updates
  createChangeNotification(changes) {
    const updates = [];
    
    for (const change of changes) {
      // Send individual updates for each changed characteristic
      for (const [charType, charData] of Object.entries(change.characteristics)) {
        updates.push({
          event: "accessory-update",
          data: {
            uniqueId: change.uniqueId,
            type: change.type,
            characteristic: charType,
            value: charData.value
          }
        });
      }
    }
    
    return updates;
  }

  // Process accessory data and detect changes
  processAccessoryData(eventData) {
    const changes = [];
    const allAccessories = [];

    for (const accessory of eventData) {
      const parsed = this.parseAccessory(accessory);
      const key = parsed.uniqueId || `${parsed.aid}-${parsed.iid}`;
      const oldState = this.accessoryStates.get(key);
      
      const { changed, changedChars } = this.hasStateChanged(oldState, parsed);
      
      if (changed) {
        changes.push({
          uniqueId: parsed.uniqueId,
          aid: parsed.aid,
          iid: parsed.iid,
          type: parsed.type,
          serviceName: parsed.serviceName,
          humanType: parsed.humanType,
          characteristics: changedChars, // Only changed characteristics
          changeType: oldState ? 'updated' : 'added'
        });
        
        this.accessoryStates.set(key, parsed);
        this.parsedAccessories.set(key, parsed);
      }
      
      allAccessories.push(parsed);
    }

    return { changes, allAccessories };
  }

  // Send efficient updates to WebSocket clients
  sendToClients(message) {
    const jsonMessage = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(jsonMessage);
      }
    });
  }

  // Get all current accessory states in efficient format
  getAllAccessoryStates() {
    return Array.from(this.parsedAccessories.values());
  }

  // Build lookup maps for aid/iid translation
  buildAccessoryLookups() {
    this.accessoryLookup = new Map(); // uniqueId -> accessory data
    this.characteristicLookup = new Map(); // uniqueId -> characteristics map
    
    for (const accessory of this.accessoryList) {
      if (accessory.uniqueId) {
        this.accessoryLookup.set(accessory.uniqueId, accessory);
        
        const charMap = new Map();
        if (accessory.serviceCharacteristics) {
          accessory.serviceCharacteristics.forEach(char => {
            charMap.set(char.type, {
              aid: accessory.aid,
              iid: char.iid,
              format: char.format,
              perms: char.perms,
              minValue: char.minValue,
              maxValue: char.maxValue,
              minStep: char.minStep
            });
          });
        }
        this.characteristicLookup.set(accessory.uniqueId, charMap);
      }
    }
  }

  // Translate user-friendly command to Homebridge Socket.IO format
  translateCommand(command) {
    try {
      const { uniqueId, characteristic, value } = command;
      
      if (!uniqueId || !characteristic || value === undefined) {
        throw new Error('Command must include uniqueId, characteristic, and value');
      }
      
      const charMap = this.characteristicLookup.get(uniqueId);
      if (!charMap) {
        throw new Error(`Accessory with uniqueId '${uniqueId}' not found`);
      }
      
      const charInfo = charMap.get(characteristic);
      if (!charInfo) {
        throw new Error(`Characteristic '${characteristic}' not found for accessory '${uniqueId}'`);
      }
      
      // Check if characteristic is writable
      if (!charInfo.perms || !charInfo.perms.includes('pw')) {
        throw new Error(`Characteristic '${characteristic}' is not writable`);
      }
      
      // Validate value based on format and constraints
      let finalValue = value;
      if (charInfo.format === 'bool') {
        finalValue = Boolean(value);
      } else if (charInfo.format === 'int' || charInfo.format === 'uint8' || charInfo.format === 'uint16' || charInfo.format === 'uint32') {
        finalValue = parseInt(value);
        if (charInfo.minValue !== undefined && finalValue < charInfo.minValue) {
          finalValue = charInfo.minValue;
        }
        if (charInfo.maxValue !== undefined && finalValue > charInfo.maxValue) {
          finalValue = charInfo.maxValue;
        }
      } else if (charInfo.format === 'float') {
        finalValue = parseFloat(value);
        if (charInfo.minValue !== undefined && finalValue < charInfo.minValue) {
          finalValue = charInfo.minValue;
        }
        if (charInfo.maxValue !== undefined && finalValue > charInfo.maxValue) {
          finalValue = charInfo.maxValue;
        }
      }
      
      // Build Homebridge Socket.IO command
      const homebridgeCommand = `42/accessories,["set-characteristics",[{"aid":${charInfo.aid},"iid":${charInfo.iid},"value":${JSON.stringify(finalValue)}}]]`;
      
      return { success: true, command: homebridgeCommand };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Handle toggle commands by reading current state and inverting it
  async handleToggleCommand(command) {
    try {
      const { uniqueId, characteristic } = command;
      
      if (!uniqueId || !characteristic) {
        throw new Error('Toggle command must include uniqueId and characteristic');
      }
      
      // Find the current accessory state
      const currentAccessory = this.parsedAccessories.get(uniqueId);
      if (!currentAccessory) {
        throw new Error(`Accessory with uniqueId '${uniqueId}' not found`);
      }
      
      // Get current characteristic value
      const currentChar = currentAccessory.characteristics[characteristic];
      if (!currentChar) {
        throw new Error(`Characteristic '${characteristic}' not found for accessory '${uniqueId}'`);
      }
      
      // Calculate toggle value based on characteristic type
      let toggleValue;
      if (currentChar.format === 'bool') {
        toggleValue = !currentChar.value;
      } else if (characteristic === 'On' || characteristic === 'Brightness') {
        // For On/Off or Brightness, toggle between 0 and previous non-zero value or 100
        if (currentChar.value > 0) {
          toggleValue = 0;
        } else {
          toggleValue = characteristic === 'On' ? 1 : 100;
        }
      } else {
        throw new Error(`Toggle not supported for characteristic '${characteristic}'`);
      }
      
      // Create a set-characteristic command with the toggle value
      const setCommand = {
        uniqueId: uniqueId,
        characteristic: characteristic,
        value: toggleValue
      };
      
      // Use existing translateCommand function
      return this.translateCommand(setCommand);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Process user-friendly commands
  processUserCommand(msgContent) {
    try {
      const command = JSON.parse(msgContent);
      
      // Check if this is a user-friendly command
      if (command.command === 'set-characteristic') {
        const translation = this.translateCommand(command);
        if (translation.success) {
          return { isUserCommand: true, homebridgeCommand: translation.command };
        } else {
          this.log('Command translation failed:', translation.error);
          return { isUserCommand: true, error: translation.error };
        }
      }
      // Handle toggle commands
      else if (command.command === 'toggle-characteristic') {
        const translation = this.handleToggleCommand(command);
        if (translation.success) {
          return { isUserCommand: true, homebridgeCommand: translation.command };
        } else {
          this.log('Toggle command translation failed:', translation.error);
          return { isUserCommand: true, error: translation.error };
        }
      }
      
      // Not a user command, pass through as-is
      return { isUserCommand: false, originalCommand: msgContent };
    } catch (e) {
      // Not JSON or not a user command, pass through as-is
      return { isUserCommand: false, originalCommand: msgContent };
    }
  }
}
