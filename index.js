const axios = require('axios');
const WebSocket = require('ws');
const express = require('express');
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
    this.homebridgeConnected = false; // Track connection state
    this.lastMessageTime = null; // Track the time of the last message from Homebridge
    this.isReconnecting = false; // Track reconnection state to prevent loops
    this.lastAccessoriesDataString = null; // Track last processed accessories data to prevent duplicates
    this.httpServer = null; // Track the HTTP server instance
    this.pendingCommands = new Map(); // Track pending commands by aid/iid for response matching

    // Start HTTP endpoint for accessory list
    this.setupHttpEndpoint();

    this.api.on('didFinishLaunching', () => this.startProxy());
  }

  setupHttpEndpoint() {
    // Create a new Express app instance for this platform
    const app = express();
    
    // JSON endpoint
    app.get('/accessories', (req, res) => {
      if (this.lastAccessoriesData) {
        res.json({ accessories: this.lastAccessoriesData });
      } else {
        res.status(503).json({ error: "No accessory data yet. Please try again shortly." });
      }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: this.homebridgeConnected ? 'connected' : 'disconnected',
        accessoryCount: this.accessoryList.length,
        websocketClients: this.clients.length,
        lookupSize: this.characteristicLookup.size,
        lastMessageTime: this.lastMessageTime ? new Date(this.lastMessageTime).toISOString() : null,
        timestamp: new Date().toISOString()
      });
    });

    // Test command endpoint
    app.post('/test-command', async (req, res) => {
      if (!this.homebridgeConnected) {
        return res.status(503).json({ error: 'Homebridge not connected' });
      }
      
      // Test command for Bug Zapper (uniqueId from logs)
      const testCommand = {
        command: 'set-characteristic',
        uniqueId: '4e50d2d83cef318a2fc6ef49f743a5946af5c641b5804c5070f6390ae8a0d0a9',
        characteristic: 'On',
        value: true
      };
      
      this.log('Test command triggered via HTTP:', testCommand);
      
      try {
        // Process the command directly instead of sending to RTI client
        const commandResult = await this.processUserCommand(JSON.stringify(testCommand));
        
        if (commandResult.isUserCommand) {
          if (commandResult.error) {
            return res.status(400).json({ error: commandResult.error });
          } else {
            // Track the pending command for response matching
            if (commandResult.commandInfo) {
              const commandKey = commandResult.commandInfo.commandKey || `${commandResult.commandInfo.aid}-${commandResult.commandInfo.iid}`;
              this.pendingCommands.set(commandKey, {
                client: null, // HTTP request, no websocket client
                timestamp: Date.now(),
                command: commandResult.homebridgeCommand,
                commandInfo: commandResult.commandInfo
              });
            }
            
            // Send translated command to Homebridge
            this.log('[Socket.IO Send] Test Command:', commandResult.homebridgeCommand);
            this.homebridge_ws.send(commandResult.homebridgeCommand);
            
            return res.json({ 
              message: 'Test command sent successfully',
              command: testCommand,
              homebridgeCommand: commandResult.homebridgeCommand
            });
          }
        } else {
          return res.status(400).json({ error: 'Command was not recognized as user command' });
        }
      } catch (error) {
        this.log('Test command error:', error.message);
        return res.status(500).json({ error: 'Test command failed: ' + error.message });
      }
    });

    // Test toggle command endpoint
    app.post('/test-toggle', async (req, res) => {
      if (!this.homebridgeConnected) {
        return res.status(503).json({ error: 'Homebridge not connected' });
      }
      
      // Test toggle command for Bug Zapper
      const testCommand = {
        command: 'toggle-characteristic',
        uniqueId: '4e50d2d83cef318a2fc6ef49f743a5946af5c641b5804c5070f6390ae8a0d0a9',
        characteristic: 'On'
      };
      
      this.log('Test toggle command triggered via HTTP:', testCommand);
      
      try {
        // Process the command directly
        const commandResult = await this.processUserCommand(JSON.stringify(testCommand));
        
        if (commandResult.isUserCommand) {
          if (commandResult.error) {
            return res.status(400).json({ error: commandResult.error });
          } else {
            // Track the pending command for response matching
            if (commandResult.commandInfo) {
              const commandKey = commandResult.commandInfo.commandKey || `${commandResult.commandInfo.aid}-${commandResult.commandInfo.iid}`;
              this.pendingCommands.set(commandKey, {
                client: null, // HTTP request, no websocket client
                timestamp: Date.now(),
                command: commandResult.homebridgeCommand,
                commandInfo: commandResult.commandInfo
              });
            }
            
            // Send translated command to Homebridge
            this.log('[Socket.IO Send] Test Toggle Command:', commandResult.homebridgeCommand);
            this.homebridge_ws.send(commandResult.homebridgeCommand);
            
            return res.json({ 
              message: 'Test toggle command sent successfully',
              command: testCommand,
              homebridgeCommand: commandResult.homebridgeCommand
            });
          }
        } else {
          return res.status(400).json({ error: 'Command was not recognized as user command' });
        }
      } catch (error) {
        this.log('Test toggle command error:', error.message);
        return res.status(500).json({ error: 'Test toggle command failed: ' + error.message });
      }
    });

    // Debug endpoint to list all accessories and their characteristics
    app.get('/debug/accessories', (req, res) => {
      if (!this.accessoryList || this.accessoryList.length === 0) {
        return res.json({ error: 'No accessories available' });
      }
      
      const debugInfo = this.accessoryList
        .filter(acc => acc.type !== "ProtocolInformation")
        .map(acc => ({
          uniqueId: acc.uniqueId,
          aid: acc.aid,
          type: acc.type,
          serviceName: acc.serviceName,
          characteristics: (acc.serviceCharacteristics || []).map(char => ({
            type: char.type,
            iid: char.iid,
            value: char.value,
            format: char.format,
            perms: char.perms,
            writable: char.perms ? char.perms.includes('pw') : false
          }))
        }));
      
      res.json({ 
        count: debugInfo.length,
        accessories: debugInfo,
        lookupSize: this.characteristicLookup.size
      });
    });

    // Debug current code version endpoint
    app.get('/debug/version', (req, res) => {
      res.json({
        message: 'RTI Proxy Debug Version Check',
        timestamp: new Date().toISOString(),
        features: {
          accessoryControlFormat: true,
          pendingCommandTracking: true,
          enhancedLogging: true,
          debugEndpoints: true
        },
        currentFormat: 'accessory-control',
        codeVersion: '2025-07-17-enhanced-debugging'
      });
    });

    // Test accessories request endpoint
    app.post('/test-accessories-request', (req, res) => {
      if (!this.homebridgeConnected) {
        return res.status(503).json({ error: 'Homebridge not connected' });
      }
      
      this.log('Manual accessories request triggered via HTTP');
      
      if (this.homebridge_ws.readyState === WebSocket.OPEN) {
        this.log('[Socket.IO Send] Manual get-accessories request');
        this.homebridge_ws.send('42/accessories,["get-accessories"]');
        
        return res.json({ 
          message: 'Accessories request sent',
          timestamp: new Date().toISOString()
        });
      } else {
        return res.status(503).json({ 
          error: 'WebSocket not ready',
          readyState: this.homebridge_ws ? this.homebridge_ws.readyState : 'undefined'
        });
      }
    });

    // Test legacy command format endpoint
    app.post('/test-legacy-command', async (req, res) => {
      if (!this.homebridgeConnected) {
        return res.status(503).json({ error: 'Homebridge not connected' });
      }
      
      // Test with legacy set-characteristics format
      const legacyCommand = `42/accessories,["set-characteristics",[{"aid":3,"iid":12,"value":false}]]`;
      
      this.log('Test legacy command triggered via HTTP');
      this.log('[Socket.IO Send] Legacy Command:', legacyCommand);
      
      try {
        this.homebridge_ws.send(legacyCommand);
        
        return res.json({ 
          message: 'Legacy command sent successfully',
          command: legacyCommand
        });
      } catch (error) {
        this.log('Legacy command error:', error.message);
        return res.status(500).json({ error: 'Legacy command failed: ' + error.message });
      }
    });

    // Debug pending commands endpoint
    app.get('/debug/pending', (req, res) => {
      const pendingInfo = {
        pendingCount: this.pendingCommands.size,
        pending: Array.from(this.pendingCommands.entries()).map(([key, value]) => ({
          commandKey: key,
          timestamp: new Date(value.timestamp).toISOString(),
          ageMs: Date.now() - value.timestamp,
          hasClient: !!value.client,
          commandInfo: value.commandInfo
        })),
        connectionState: {
          homebridgeConnected: this.homebridgeConnected,
          websocketReady: this.homebridge_ws ? this.homebridge_ws.readyState === WebSocket.OPEN : false,
          websocketState: this.homebridge_ws ? this.homebridge_ws.readyState : 'none',
          lastMessageTime: this.lastMessageTime,
          timeSinceLastMessage: this.lastMessageTime ? Date.now() - this.lastMessageTime : null
        }
      };
      
      res.json(pendingInfo);
    });

    // Test connection endpoint
    app.get('/test-connection', (req, res) => {
      const connectionInfo = {
        homebridgeConnected: this.homebridgeConnected,
        websocketReady: this.homebridge_ws ? this.homebridge_ws.readyState === WebSocket.OPEN : false,
        websocketState: this.homebridge_ws ? this.homebridge_ws.readyState : 'none',
        lastMessageTime: this.lastMessageTime,
        timeSinceLastMessage: this.lastMessageTime ? Date.now() - this.lastMessageTime : null,
        clientCount: this.clients.length,
        accessoryCount: this.accessoryList.length,
        lookupSize: this.characteristicLookup.size
      };
      
      res.json(connectionInfo);
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
        <head><title>Homebridge</title></head>
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

    // Start the HTTP server and store reference
    this.httpServer = app.listen(this.accessoryPort, () => {
      console.log(`Accessory list HTTP server at http://localhost:${this.accessoryPort}/accessories`);
      console.log(`Health check endpoint: http://localhost:${this.accessoryPort}/health`);
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
    
    // Reset state for new connection
    this.isReconnecting = false;
    this.homebridgeConnected = false;
    this.lastAccessoriesDataString = null;
    
    // Close existing WebSocket if any
    if (this.homebridge_ws) {
      try {
        this.homebridge_ws.terminate();
      } catch (e) {}
    }
    
    await this.getBearerToken();
    const wsPath = `/socket.io/?token=${this.access_token}&EIO=4&transport=websocket`;
    const homebridgeURL = `ws://${this.homebridgeHost}:${this.homebridgePort}${wsPath}`;
    this.log('Attempting WebSocket connection to:', homebridgeURL);
    this.homebridge_ws = new WebSocket(homebridgeURL);

    // Clear any existing intervals
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (this.homebridge_ws && this.homebridge_ws.readyState === WebSocket.CONNECTING) {
        this.log('WebSocket connection timeout - terminating');
        this.homebridge_ws.terminate();
      }
    }, 10000); // 10 second timeout

    this.homebridge_ws.on('open', () => {
      this.log('Connected to Homebridge Socket.IO');
      this.log('WebSocket readyState:', this.homebridge_ws.readyState);
      this.log('WebSocket protocol:', this.homebridge_ws.protocol);
      this.log('WebSocket extensions:', this.homebridge_ws.extensions);
      
      // Clear connection timeout
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      
      this.homebridgeConnected = true;
      this.updateLastMessageTime();
      this.startConnectionHealthMonitoring(); // Start health monitoring
      
      // Notify all RTI clients of connection status
      this.broadcastConnectionStatus();
      
      this.log('[Socket.IO Send] 40/accessories,');
      this.homebridge_ws.send('40/accessories,');
      
      // Initial accessories request
      setTimeout(() => {
        if (this.homebridge_ws.readyState === WebSocket.OPEN) {
          this.log('[Socket.IO Send] 42/accessories,["get-accessories"]');
          this.homebridge_ws.send('42/accessories,["get-accessories"]');
        } else {
          this.log('WebSocket not open when trying to send get-accessories, readyState:', this.homebridge_ws.readyState);
        }
      }, 250);

      // Remove keep-alive pings - they cause disconnections
      // Connection health is monitored by the health monitoring system instead
    });

    this.homebridge_ws.on('message', (data) => {
      this.updateLastMessageTime(); // Track message receipt for health monitoring
      
      let text = (Buffer.isBuffer(data) ? data.toString() : data);
      this.log('[Socket.IO Receive] Raw message:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
      
      // Only log non-heartbeat messages to reduce noise
      if (text !== '2' && text !== '3') {
        // Truncate long JSON messages for readability
        let logText = text;
        if (text.length > 200) {
          logText = text.substring(0, 200) + '...[truncated ' + (text.length - 200) + ' chars]';
        }
        this.log('[HomebridgeWS]', logText);
      }

      // Track the time of the last message
      this.updateLastMessageTime();

      // Debug: Log all message types for debugging
      this.log('[DEBUG] Message type check:', { text, textType: typeof text, textLength: text.length });

      if (text === '2') {
        this.log('[Socket.IO Receive] Ping received');
        this.log('[Socket.IO Send] 3 (pong)');
        this.homebridge_ws.send('3');
        return;
      }
      if (text === '40') {
        this.log('[Socket.IO Receive] 40 received');
        // Acknowledge connection to accessories namespace
        this.log('[Socket.IO Send] 40/accessories,');
        this.homebridge_ws.send('40/accessories,');
        return;
      }
      
      // Log ALL non-ping messages for debugging
      if (text !== '2' && text !== '3') {
        this.log('[DEBUG] Non-ping message received:', text.substring(0, 200));
      }
      
      if (text.startsWith('42/accessories,')) {
        this.log('[DEBUG] Parsing 42/accessories message, length:', text.length);
        try {
          const jsonPart = text.slice('42/accessories,'.length);
          this.log('[DEBUG] JSON part to parse:', jsonPart.substring(0, 100) + (jsonPart.length > 100 ? '...' : ''));
          
          const payload = JSON.parse(jsonPart);
          const event = payload[0];
          const eventData = payload[1];
          
          this.log('[DEBUG] Parsed payload - event:', event, 'hasData:', !!eventData, 'dataType:', typeof eventData);
          
          // Log all events for debugging with more detail
          if (event === "accessories-data") {
            this.log('Socket.IO Event:', event, 'Data count:', eventData ? eventData.length : 'null');
            if (eventData && eventData.length > 0) {
              eventData.forEach((acc, index) => {
                this.log(`  Accessory ${index + 1}:`, acc.serviceName, 'aid:', acc.aid, 'uniqueId:', acc.uniqueId?.substring(0, 8) + '...');
              });
            }
          } else {
            this.log('Socket.IO Event:', event, 'Data length:', eventData ? eventData.length : 'null');
          }
          
          // Handle both set-characteristics-response and accessory-control-response
          if (event === "set-characteristics-response" || event === "accessory-control-response") {
            this.log('Received command response:', event, payload);
            if (eventData && eventData.length > 0) {
              eventData.forEach(response => {
                if (response.status === 0) {
                  this.log('Command executed successfully for aid:', response.aid, 'iid:', response.iid);
                } else {
                  this.log('Command failed for aid:', response.aid, 'iid:', response.iid, 'status:', response.status);
                }
              });
            }
            return;
          }
          
          // Handle command success responses that come back as accessories-data
          // When we send accessory-control, the response is the updated state data
          if (event === "accessories-data" && eventData && eventData.length > 0) {
            // Check if this looks like a command response (single accessory update)
            if (eventData.length === 1 && eventData[0].aid && eventData[0].serviceCharacteristics) {
              const accessory = eventData[0];
              const commandKey = `${accessory.aid}-${accessory.iid}`;
              
              // Check if we have a pending command for this accessory
              if (this.pendingCommands.has(commandKey)) {
                const pendingCommand = this.pendingCommands.get(commandKey);
                this.log('Command response received for:', accessory.serviceName, 'aid:', accessory.aid);
                
                // Log the updated characteristic values
                if (accessory.serviceCharacteristics) {
                  accessory.serviceCharacteristics.forEach(char => {
                    this.log('Updated characteristic:', char.type, '=', char.value);
                  });
                }
                
                // Send success response to the client who initiated the command
                if (pendingCommand.client && pendingCommand.client.readyState === WebSocket.OPEN) {
                  pendingCommand.client.send(JSON.stringify({
                    event: "command-success",
                    message: "Command executed successfully",
                    accessory: accessory.serviceName,
                    aid: accessory.aid
                  }));
                }
                
                // Remove the pending command
                this.pendingCommands.delete(commandKey);
                
                // Continue to handle as accessories-data below
              } else {
                this.log('State update received for:', accessory.serviceName, 'aid:', accessory.aid, '(not a command response)');
                this.log('[DEBUG] Available pending commands:', Array.from(this.pendingCommands.keys()));
              }
            }
          }
          
          if (event === "accessories-data") {
            // Handle initial full data load vs incremental updates
            if (eventData.length === 0) {
              // Empty update - no changes needed
              return;
            }
            
            // Check if this is a full data load or incremental update
            // Full data load: large dataset OR no existing data OR after reconnection
            const isFullDataLoad = eventData.length > 5 || 
                                  !this.accessoryList || 
                                  this.accessoryList.length === 0 ||
                                  !this.lastAccessoriesData;
            
            if (isFullDataLoad) {
              // Only process if data has actually changed
              const dataString = JSON.stringify(eventData);
              if (this.lastAccessoriesDataString === dataString) {
                // Data hasn't changed, skip processing
                this.log('Skipping duplicate accessories data processing');
                return;
              }
              this.lastAccessoriesDataString = dataString;
              
              // Full data load - update everything but don't send incremental updates
              this.log('Processing full accessories data load, count:', eventData.length);
              this.accessoryList = eventData;
              this.lastAccessoriesData = this.accessoryList;
              
              // Parse all accessories for future change detection
              for (const accessory of eventData) {
                const parsed = this.parseAccessory(accessory);
                const key = parsed.uniqueId || `${parsed.aid}-${parsed.iid}`;
                this.accessoryStates.set(key, parsed);
                this.parsedAccessories.set(key, parsed);
              }
              
              // Build lookup maps for command translation
              this.buildAccessoryLookups();
              
              // Send legacy format to RTI clients for compatibility
              this.sendToClients({
                event: "accessories-data",
                data: this.accessoryList
              });
              
            } else {
              // Incremental update - detect changes and send efficient updates
              this.log('Processing incremental accessories update, count:', eventData.length);
              const { changes, allAccessories } = this.processAccessoryData(eventData);
              
              // Update the accessory list for the HTTP endpoint
              this.mergeAccessoryData(eventData);
              
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
            }
            
            // Also send full state to any newly connected clients
            const fullStateMessage = {
              event: "full-state",
              data: this.getAllAccessoryStates(),
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
          
          // Handle any other events that might contain state updates
          else if (event === "accessory-update" || event === "characteristic-update") {
            this.log('Received state update event:', event, eventData);
            // Process as incremental update
            if (eventData && eventData.length > 0) {
              const { changes, allAccessories } = this.processAccessoryData(eventData);
              
              // Update the accessory list for the HTTP endpoint
              this.mergeAccessoryData(eventData);
              
              // Build lookup maps for command translation
              this.buildAccessoryLookups();
              
              // Send changes to WebSocket clients
              if (changes.length > 0) {
                const changeNotifications = this.createChangeNotification(changes);
                changeNotifications.forEach(notification => {
                  this.sendToClients(notification);
                });
                this.log(`Sent ${changeNotifications.length} state update messages to WebSocket clients`);
              }
            }
          }
          
          // Log any unhandled events for debugging
          else {
            this.log('Unhandled Socket.IO event:', event, 'Data:', eventData ? 'present' : 'null');
          }
        } catch (err) {
          this.log('Failed to parse frame:', err.message, text);
          this.log('[DEBUG] Parse error details:', err);
        }
      } else if (text !== '2' && text !== '3' && text !== '40') {
        // Log any other unexpected message types
        this.log('[DEBUG] Unexpected message format received:', text.substring(0, 100));
      }
    });

    this.homebridge_ws.on('close', () => {
      this.log('Homebridge Socket.IO closed, reconnecting in 10s...');
      this.homebridgeConnected = false;
      
      // Notify all RTI clients of connection status
      this.broadcastConnectionStatus();
      
      // Clean up intervals
      if (this.healthMonitorInterval) {
        clearInterval(this.healthMonitorInterval);
        this.healthMonitorInterval = null;
      }
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }
      this.reconnectTimeout = setTimeout(() => this.startProxy(), 10000);
    });
    this.homebridge_ws.on('error', (err) => {
      this.log('Homebridge WS error:', err.message);
      this.log('Error code:', err.code);
      this.log('Error type:', err.type);
      this.log('WebSocket readyState:', this.homebridge_ws ? this.homebridge_ws.readyState : 'undefined');
      
      // Clear connection timeout
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      
      this.homebridgeConnected = false;
      
      // Clean up connection and trigger reconnection
      if (this.homebridge_ws) {
        try {
          this.homebridge_ws.terminate();
        } catch (e) {
          // Ignore termination errors
        }
        this.homebridge_ws = null;
      }
      
      // Trigger reconnection if not already reconnecting
      if (!this.isReconnecting) {
        this.triggerReconnection();
      }
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
        
        // Send connection status to client
        ws.send(JSON.stringify({
          event: "connection-status",
          connected: this.homebridgeConnected,
          timestamp: Date.now()
        }));
        
        ws.on('close', () => {
          this.clients = this.clients.filter(c => c !== ws);
          this.log('RTI/Web client disconnected');
        });
        ws.on('message', async (msg) => {
          try {
            let msgType = typeof msg;
            let msgContent = msg;
            if (Buffer.isBuffer(msg)) {
              msgType = 'Buffer';
              msgContent = msg.toString();
            }
            this.log('Received from RTI/Web client:', `[type: ${msgType}]`, msgContent);
            
            if (typeof msgContent !== 'string') {
              this.log('Received non-string message from RTI/Web client:', msgContent);
              return;
            }
            
            // Process user-friendly commands
            const commandResult = await this.processUserCommand(msgContent);
            
            if (commandResult.isUserCommand) {
              if (commandResult.error) {
                this.log('User command error:', commandResult.error);
                // Send error response back to client
                ws.send(JSON.stringify({
                  event: "command-error",
                  error: commandResult.error
                }));
                return;
              } else {
                // Check connection state before sending
                if (!this.homebridgeConnected || !this.homebridge_ws || this.homebridge_ws.readyState !== WebSocket.OPEN) {
                  this.log('Homebridge WebSocket not ready, cannot send command. Triggering reconnection...');
                  
                  // Trigger immediate reconnection attempt
                  this.triggerReconnection();
                  
                  ws.send(JSON.stringify({
                    event: "command-error",
                    error: "Homebridge connection not available, reconnecting..."
                  }));
                  return;
                }
                
                // Send translated command to Homebridge
                this.log('[Socket.IO Send] Command:', commandResult.homebridgeCommand);
                
                // Track the pending command for response matching
                if (commandResult.commandInfo) {
                  const commandKey = commandResult.commandInfo.commandKey || `${commandResult.commandInfo.aid}-${commandResult.commandInfo.iid}`;
                  this.pendingCommands.set(commandKey, {
                    client: ws,
                    timestamp: Date.now(),
                    command: commandResult.homebridgeCommand,
                    commandInfo: commandResult.commandInfo
                  });
                  
                  this.log('[DEBUG] Tracking pending command:', commandKey, 'for response matching');
                  
                  // Clean up old pending commands after 10 seconds
                  setTimeout(() => {
                    if (this.pendingCommands.has(commandKey)) {
                      this.log('[DEBUG] Command timeout - no response received for:', commandKey);
                      this.pendingCommands.delete(commandKey);
                      this.log('Cleaned up expired pending command:', commandKey);
                      
                      // Send timeout response to client
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                          event: "command-timeout",
                          message: "No response received from Homebridge within 10 seconds",
                          commandKey: commandKey
                        }));
                      }
                    }
                  }, 10000);
                }
                
                this.log('[DEBUG] Sending command to Homebridge, WebSocket state:', this.homebridge_ws.readyState);
                this.homebridge_ws.send(commandResult.homebridgeCommand);
                
                // Send success response back to client
                ws.send(JSON.stringify({
                  event: "command-sent",
                  message: "Command sent to Homebridge, awaiting response..."
                }));
              }
            } else {
              // Check connection state before forwarding
              if (!this.homebridgeConnected || !this.homebridge_ws || this.homebridge_ws.readyState !== WebSocket.OPEN) {
                this.log('Homebridge WebSocket not ready, cannot forward raw command. Triggering reconnection...');
                
                // Trigger immediate reconnection attempt
                this.triggerReconnection();
                
                ws.send(JSON.stringify({
                  event: "command-error",
                  error: "Homebridge connection not available, reconnecting..."
                }));
                return;
              }
              
              // Forward original command (raw Socket.IO format)
              this.log('Forwarding raw command from RTI/Web client to Homebridge:', msgContent);
              this.log('[Socket.IO Send] Raw command:', commandResult.originalCommand);
              this.homebridge_ws.send(commandResult.originalCommand);
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
          maxValue: char.maxValue,
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

  // Create efficient change notification - send batched characteristic updates
  createChangeNotification(changes) {
    return this.batchCharacteristicUpdates(changes);
  }

  // Batch characteristic updates to reduce RTI load
  batchCharacteristicUpdates(changes) {
    const batchedUpdates = new Map(); // Group by uniqueId
    
    for (const change of changes) {
      const uniqueId = change.uniqueId;
      if (!batchedUpdates.has(uniqueId)) {
        batchedUpdates.set(uniqueId, {
          uniqueId: uniqueId,
          type: change.type,
          serviceName: change.serviceName,
          characteristics: {}
        });
      }
      
      // Add all changed characteristics to the batch
      Object.assign(batchedUpdates.get(uniqueId).characteristics, change.characteristics);
    }
    
    // Convert to individual updates for RTI compatibility
    const updates = [];
    for (const [uniqueId, batch] of batchedUpdates.entries()) {
      for (const [charType, charData] of Object.entries(batch.characteristics)) {
        updates.push({
          event: "accessory-update",
          data: {
            uniqueId: uniqueId,
            type: batch.type,
            serviceName: batch.serviceName,
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

  // Merge incremental accessory data updates
  mergeAccessoryData(eventData) {
    for (const newAcc of eventData) {
      let found = false;
      for (let i = 0; i < this.accessoryList.length; i++) {
        const oldAcc = this.accessoryList[i];
        if ((newAcc.uniqueId && oldAcc.uniqueId && newAcc.uniqueId === oldAcc.uniqueId) ||
            (newAcc.aid === oldAcc.aid && newAcc.iid === oldAcc.iid)) {
          this.accessoryList[i] = newAcc;
          found = true;
          break;
        }
      }
      if (!found) {
        this.accessoryList.push(newAcc);
      }
    }
    this.lastAccessoriesData = this.accessoryList;
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
              siid: accessory.iid, // Service instance ID
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
        
        // Debug log for Bug Zapper specifically
        if (accessory.serviceName === 'Bug Zapper') {
          this.log('Bug Zapper lookup built:', {
            uniqueId: accessory.uniqueId,
            aid: accessory.aid,
            characteristics: Array.from(charMap.keys())
          });
        }
      }
    }
    
    this.log('Built accessory lookups:', this.characteristicLookup.size, 'accessories with command translation support');
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
        this.log('Command translation error: Accessory not found. Available uniqueIds:', Array.from(this.characteristicLookup.keys()).length);
        throw new Error(`Accessory with uniqueId '${uniqueId}' not found`);
      }
      
      const charInfo = charMap.get(characteristic);
      if (!charInfo) {
        this.log('Command translation error: Characteristic not found. Available for', uniqueId.substring(0, 8) + '...:', Array.from(charMap.keys()));
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
      
      // Build Homebridge Socket.IO command using set-characteristics format for compatibility
      // Note: Using legacy format as accessory-control might not be working
      const homebridgeCommand = `42/accessories,["set-characteristics",[{"aid":${charInfo.aid},"iid":${charInfo.iid},"value":${JSON.stringify(finalValue)}}]]`;
      
      this.log('Command translation details:');
      this.log('  Input:', { uniqueId: uniqueId.substring(0, 8) + '...', characteristic, value });
      this.log('  Mapped to:', { aid: charInfo.aid, siid: charInfo.siid, iid: charInfo.iid, finalValue });
      this.log('  Socket.IO command:', homebridgeCommand);
      
      return { 
        success: true, 
        command: homebridgeCommand,
        commandInfo: {
          aid: charInfo.aid,
          siid: charInfo.siid,
          iid: charInfo.iid,
          uniqueId: uniqueId,
          characteristic: characteristic,
          value: finalValue,
          commandKey: `${charInfo.aid}-${charInfo.iid}` // Use aid-iid for legacy format
        }
      };
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
  async processUserCommand(msgContent) {
    try {
      const command = JSON.parse(msgContent);
      this.log('Processing command:', command);
      
      // Check if this is a user-friendly command
      if (command.command === 'set-characteristic') {
        this.log('Attempting to translate set-characteristic command');
        const translation = this.translateCommand(command);
        if (translation.success) {
          this.log('Command translated successfully:', command.uniqueId?.substring(0, 8) + '...', command.characteristic, '=', command.value);
          return { 
            isUserCommand: true, 
            homebridgeCommand: translation.command,
            commandInfo: translation.commandInfo
          };
        } else {
          this.log('Command translation failed:', translation.error);
          return { isUserCommand: true, error: translation.error };
        }
      }
      // Handle toggle commands
      else if (command.command === 'toggle-characteristic') {
        this.log('Attempting to translate toggle-characteristic command');
        const translation = await this.handleToggleCommand(command);
        if (translation.success) {
          this.log('Toggle command translated successfully:', command.uniqueId?.substring(0, 8) + '...', command.characteristic);
          return { 
            isUserCommand: true, 
            homebridgeCommand: translation.command,
            commandInfo: translation.commandInfo
          };
        } else {
          this.log('Toggle command translation failed:', translation.error);
          return { isUserCommand: true, error: translation.error };
        }
      }
      
      // Not a user command, pass through as-is
      this.log('Not a user command, passing through as-is');
      return { isUserCommand: false, originalCommand: msgContent };
    } catch (e) {
      // Not JSON or not a user command, pass through as-is
      this.log('Failed to parse as JSON, passing through as-is:', e.message);
      return { isUserCommand: false, originalCommand: msgContent };
    }
  }

  // Add connection health monitoring
  startConnectionHealthMonitoring() {
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval);
    }
    
    this.healthMonitorInterval = setInterval(() => {
      const now = Date.now();
      
      // Check WebSocket connection state
      if (!this.homebridge_ws || this.homebridge_ws.readyState !== WebSocket.OPEN) {
        this.log('Health check: WebSocket not open, triggering reconnection');
        this.homebridgeConnected = false;
        this.triggerReconnection();
        return;
      }
      
      // Check for message timeout - extended to 10 minutes
      if (this.lastMessageTime && (now - this.lastMessageTime) > 600000) { // 10 minutes
        this.log('Health check: No messages for 10 minutes, forcing reconnection');
        this.homebridgeConnected = false;
        this.homebridge_ws.terminate();
        return;
      }
      
      // COMPLETELY DISABLE health check pings - they're causing disconnections
      // Homebridge sends its own pings every 25 seconds, we just respond to those
    }, 300000); // Check every 5 minutes but don't send any pings
  }

  // Track last message time
  updateLastMessageTime() {
    this.lastMessageTime = Date.now();
  }

  // Trigger immediate reconnection attempt
  triggerReconnection() {
    if (this.isReconnecting) {
      return; // Already reconnecting
    }
    
    this.isReconnecting = true;
    this.log('Triggering immediate reconnection due to connection failure');
    
    // Clear any existing timeouts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    // Attempt reconnection immediately
    setTimeout(() => {
      this.isReconnecting = false;
      this.startProxy();
    }, 1000); // 1 second delay to avoid rapid reconnection loops
  }

  // Broadcast connection status to all RTI clients
  broadcastConnectionStatus() {
    const statusMessage = {
      event: "connection-status",
      connected: this.homebridgeConnected,
      timestamp: Date.now()
    };
    
    this.sendToClients(statusMessage);
  }
}
