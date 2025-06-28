const { spawn } = require('child_process');
const path = require('path');

module.exports = (homebridge) => {
  homebridge.registerPlatform('HomebridgeRtiProxy', 'RtiProxy', RtiProxyPlatform);
};

class RtiProxyPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.proxyPort = this.config.proxyPort || 9001;
    this.homebridgeHost = this.config.homebridgeHost || '192.168.20.103';
    this.homebridgePort = this.config.homebridgePort || 8581;
    this.username = this.config.username || 'admin';
    this.password = this.config.password || 'rvq9kcj1ryr!ybd7CEM';
    this.otp = this.config.otp || '';
    this.api.on('didFinishLaunching', () => {
      this.startProxyProcess();
    });
  }
  startProxyProcess() {
    const proxyScript = path.join(__dirname, 'proxy.js');
    const args = [
      '--proxyPort', this.proxyPort,
      '--homebridgeHost', this.homebridgeHost,
      '--homebridgePort', this.homebridgePort,
      '--username', this.username,
      '--password', this.password,
      '--otp', this.otp
    ];
    this.log(`Starting RTI Proxy external process: node ${proxyScript} ${args.join(' ')}`);
    this.child = spawn('node', [proxyScript, ...args], {
      detached: false,
      stdio: 'ignore'
    });
    this.child.on('error', err => this.log('Proxy process error:', err.message));
    this.child.on('exit', code => this.log('Proxy process exited:', code));
  }
}
