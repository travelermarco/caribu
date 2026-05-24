'use strict';
// ── Diesel Heater BLE (Vevor / Hcalory / generic Chinese UART-over-BLE) ────
// Service:        0000ffe0-0000-1000-8000-00805f9b34fb
// Characteristic: 0000ffe1-0000-1000-8000-00805f9b34fb (notify + write)
//   Split-char clones: FFE1=notify, FFE2=write — _connectDevice handles both.
//
// Protocol: 7-byte frames [0xAA, 0x55, cmd, data, 0x00, 0x00, 0x00]
// Response: [0xAA, 0x55, state, targetT, currentT, volt×10, power, errorCode?, mode?]

const HEATER_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const FFE1 = '0000ffe1-0000-1000-8000-00805f9b34fb';
const FFE2 = '0000ffe2-0000-1000-8000-00805f9b34fb';

// cmd=0x01, data=0x01 → power ON
// cmd=0x01, data=0x00 → power OFF
// Same command byte, different data — verified across Vevor/Hcalory/generic firmwares.
// The old approach (ON_A=01 00, ON_B=01 01, OFF=02 xx) was wrong: 0x02 is undefined
// and 01 00 is OFF, so turnOn() was sending OFF then ON and turnOff() did nothing.
const CMD = {
  ON:       [0xAA, 0x55, 0x01, 0x01, 0x00, 0x00, 0x00],
  OFF:      [0xAA, 0x55, 0x01, 0x00, 0x00, 0x00, 0x00],
  STATUS:   [0xAA, 0x55, 0x10, 0x00, 0x00, 0x00, 0x00],
  SET_TEMP: (t) => [0xAA, 0x55, 0x03, t & 0xFF, 0x00, 0x00, 0x00],
  SET_LVL:  (l) => [0xAA, 0x55, 0x04, l & 0xFF, 0x00, 0x00, 0x00],
  SET_MODE: (m) => [0xAA, 0x55, 0x05, m & 0xFF, 0x00, 0x00, 0x00],
};

export const HEATER_STATE = {
  0: 'Spento', 1: 'Avvio', 2: 'Riscaldamento', 3: 'Standby',
  4: 'Raffreddamento', 5: 'Errore',
};

export const HEATER_ERROR = {
  0: null,
  1: 'E-01 Avvio fallito',
  2: 'E-02 Mancanza carburante',
  3: 'E-03 Tensione bassa',
  4: 'E-04 Sensore temperatura',
  5: 'E-05 Surriscaldamento',
  6: 'E-06 Pompa carburante',
  8: 'E-08 Sovratemperatura',
  9: 'E-09 Ventilatore',
  10: 'E-10 Sensore fiamma',
};

export class HeaterBLE {
  constructor(onUpdate) {
    this.onUpdate   = onUpdate;
    this.device     = null;
    this.writeChar  = null;
    this.notifyChar = null;
    this.pollTimer  = null;
    this.data = {
      connected: false, state: 0, currentTemp: '--', targetTemp: 20,
      voltage: '--', power: 1, errorCode: 0, mode: 1,
      error: null, rawHex: null, lastTx: null, lastWriteErr: null,
      bleLog: [],   // [{dir,hex,t}] — last 12 frames TX+RX
      bleInfo: null, // char UUIDs + properties string
    };
  }

  async connect() {
    if (!navigator.bluetooth) {
      this.data.error = 'Web Bluetooth non supportato. Usa Chrome su Android/Desktop via HTTPS.';
      this.onUpdate({ ...this.data });
      return false;
    }
    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [HEATER_SERVICE],
      });
      localStorage.setItem('ble_heater_id', this.device.id);
      return await this._connectDevice();
    } catch (e) {
      if (e.name === 'NotFoundError') return false;
      console.error('Heater connect error:', e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  async reconnect(device) {
    this.device = device;
    try { return await this._connectDevice(); }
    catch (e) { console.warn('Heater auto-reconnect failed:', e); return false; }
  }

  async _connectDevice() {
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    const server  = await this.device.gatt.connect();
    const service = await server.getPrimaryService(HEATER_SERVICE);

    // Enumerate ALL characteristics in FFE0.
    // Some HM-10 clones split TX/RX: write on FFE1, responses on FFE2 (or vice versa).
    // Subscribing only to FFE1 misses responses that arrive on FFE2.
    // Fix: subscribe to EVERY char that reports notify; fall back to subscribing all.
    const chars = await service.getCharacteristics();
    const pStr  = c => `n:${c.properties.notify?1:0} w:${c.properties.write?1:0} wwr:${c.properties.writeWithoutResponse?1:0}`;
    console.log('Heater chars:', chars.map(c => `${c.uuid.slice(4,8)}[${pStr(c)}]`).join(' | '));

    // Write char: first char with write or writeWithoutResponse property
    this.writeChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse) ?? chars[0];

    // Subscribe to notifications: all chars with notify/indicate (or all if none report it)
    const notifyChars = chars.filter(c => c.properties.notify || c.properties.indicate);
    const toSubscribe = notifyChars.length > 0 ? notifyChars : chars;
    for (const c of toSubscribe) {
      try {
        await c.startNotifications();
        c.addEventListener('characteristicvaluechanged', e => this._parse(e.target.value));
        console.log(`Heater: subscribed to ${c.uuid.slice(4,8)}`);
      } catch (e) {
        console.warn(`Heater: startNotifications failed on ${c.uuid.slice(4,8)}:`, e.message);
      }
    }

    const wc = this.writeChar;
    const subList = toSubscribe.map(c => c.uuid.slice(4,8)).join('+');
    this.data.bleInfo = `chars: ${chars.map(c => `${c.uuid.slice(4,8)}[${pStr(c)}]`).join(' ')} | write→${wc.uuid.slice(4,8)} | rx←${subList}`;

    this.data.connected    = true;
    this.data.error        = null;
    this.data.lastWriteErr = null;
    this.onUpdate({ ...this.data });

    await this._send(CMD.STATUS);
    this._startPoll();
    return true;
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.writeChar = null; this.notifyChar = null;
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }

  async turnOn() {
    this.data.state = 1;
    this.onUpdate({ ...this.data });
    await this._send(CMD.ON);
    this._scheduleStatus(2000);
  }

  async turnOff() {
    this.data.state = 4;
    this.onUpdate({ ...this.data });
    await this._send(CMD.OFF);
    this._scheduleStatus(2000);
  }

  async setTemp(t) {
    this.data.targetTemp = t;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_TEMP(t));
    this._scheduleStatus(800);
  }

  async setLevel(l) {
    this.data.power = l;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_LVL(l));
    this._scheduleStatus(800);
  }

  async setMode(m) {
    this.data.mode = m;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_MODE(m === 2 ? 1 : 0));
    await this._delay(150);
    if (m === 2) await this._send(CMD.SET_TEMP(this.data.targetTemp));
    else         await this._send(CMD.SET_LVL(this.data.power));
    this._scheduleStatus(800);
  }

  _startPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._send(CMD.STATUS), 5000);
  }

  _scheduleStatus(ms) { setTimeout(() => this._send(CMD.STATUS), ms); }
  _delay(ms)          { return new Promise(r => setTimeout(r, ms)); }

  async _send(cmd) {
    if (!this.writeChar) return;
    const data = new Uint8Array(cmd);
    const hex  = [...data].map(b => b.toString(16).padStart(2,'0')).join(' ');
    const t    = new Date().toLocaleTimeString('it-IT', { hour12: false });
    console.log('Heater TX →', hex);
    this.data.lastTx = hex;
    this.data.bleLog = [{ dir: 'TX', hex, t }, ...this.data.bleLog].slice(0, 12);

    const c = this.writeChar;
    // writeValueWithResponse gives a BLE-layer ACK — we know delivery happened.
    // Try it first; fall back to writeValueWithoutResponse (fire-and-forget).
    // Some Chrome/macOS stacks silently swallow writeValueWithoutResponse without
    // actually sending, so ACK-based is the reliable path when supported.
    try {
      await c.writeValueWithResponse(data);
      if (this.data.lastWriteErr) { this.data.lastWriteErr = null; this.onUpdate({ ...this.data }); }
      return;
    } catch (e1) {
      console.warn('Heater writeWithResponse failed:', e1.message, '— trying writeWithoutResponse');
      try {
        await c.writeValueWithoutResponse(data);
        if (this.data.lastWriteErr) { this.data.lastWriteErr = null; this.onUpdate({ ...this.data }); }
        return;
      } catch (e2) {
        const msg = `TX failed: ${e1.message.slice(0, 50)}`;
        console.error('Heater write both methods failed —', e1.message, '/', e2.message);
        this.data.lastWriteErr = msg;
        this.onUpdate({ ...this.data });
      }
    }
  }

  _parse(dv) {
    const b = new Uint8Array(dv.buffer);
    const rawHex = [...b].map(x => x.toString(16).padStart(2,'0')).join(' ');
    const t      = new Date().toLocaleTimeString('it-IT', { hour12: false });
    console.log('Heater RX ←', rawHex);
    this.data.rawHex = rawHex;
    this.data.bleLog = [{ dir: 'RX', hex: rawHex, t }, ...this.data.bleLog].slice(0, 12);

    if (b.length >= 2 && (b[0] !== 0xAA || b[1] !== 0x55)) {
      console.warn('Heater RX: unexpected header —', rawHex);
      this.onUpdate({ ...this.data });
      return;
    }

    if (b.length >= 3) this.data.state       = b[2];
    if (b.length >= 4) this.data.targetTemp  = b[3];
    if (b.length >= 5) this.data.currentTemp = b[4];
    if (b.length >= 6) this.data.voltage     = (b[5] / 10).toFixed(1);
    if (b.length >= 7) this.data.power       = b[6] || this.data.power;
    this.data.errorCode = b.length > 7 ? b[7] : 0;
    this.data.mode      = b.length > 8 ? b[8] : this.data.mode;
    this.data.error     = null;
    this.onUpdate({ ...this.data });
  }

  _onDisconnect() {
    clearInterval(this.pollTimer);
    this.writeChar = null; this.notifyChar = null;
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }

  // Parse a hex string like "aa 55 01 01 00 00 00" and send it directly
  async sendHex(hexStr) {
    const bytes = (hexStr ?? '').replace(/[^0-9a-fA-F]/g, ' ').trim()
      .split(/\s+/).map(h => parseInt(h, 16)).filter(n => !isNaN(n) && n <= 255);
    if (!bytes.length) return;
    await this._send(bytes);
  }

  stateLabel() { return HEATER_STATE[this.data.state] ?? 'Sconosciuto'; }
}
