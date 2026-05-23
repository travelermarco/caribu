'use strict';
// ── Diesel Heater BLE (Vevor / Hcalory / generic Chinese UART-over-BLE) ────
// Service:        FFE0   Characteristic: FFE1 (notify + write-without-response)
// Protocol:       7-byte command frames, 20-byte status responses

const HEATER_SERVICE = 'ffe0';
const HEATER_CHAR    = 'ffe1';

const CMD = {
  STATUS:   [0xAA, 0x55, 0x10, 0x00, 0x00, 0x00, 0x00],
  ON:       [0xAA, 0x55, 0x01, 0x00, 0x00, 0x00, 0x00],
  OFF:      [0xAA, 0x55, 0x02, 0x00, 0x00, 0x00, 0x00],
  SET_TEMP: (t) => [0xAA, 0x55, 0x03, t & 0xFF, 0x00, 0x00, 0x00],
  SET_LVL:  (l) => [0xAA, 0x55, 0x04, l & 0xFF, 0x00, 0x00, 0x00],
};

const HEATER_STATE = {
  0: 'Spento', 1: 'Avvio', 2: 'Riscaldamento', 3: 'Standby',
  4: 'Raffreddamento', 5: 'Errore',
};

export class HeaterBLE {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.device = null;
    this.char   = null;
    this.pollTimer = null;
    this.data = { connected: false, state: 0, currentTemp: '--', targetTemp: 20, voltage: '--', power: 1, error: null };
  }

  async connect() {
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEATER_SERVICE] }],
        optionalServices: [HEATER_SERVICE],
      });
      this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
      const server  = await this.device.gatt.connect();
      const service = await server.getPrimaryService(HEATER_SERVICE);
      this.char     = await service.getCharacteristic(HEATER_CHAR);
      await this.char.startNotifications();
      this.char.addEventListener('characteristicvaluechanged', e => this._parse(e.target.value));
      this.data.connected = true;
      this._startPoll();
      this.onUpdate({ ...this.data });
      return true;
    } catch (e) {
      console.error('Heater connect error:', e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async turnOn()  { await this._send(CMD.ON);  }
  async turnOff() { await this._send(CMD.OFF); }
  async setTemp(t) { this.data.targetTemp = t; await this._send(CMD.SET_TEMP(t)); }
  async setLevel(l) { this.data.power = l; await this._send(CMD.SET_LVL(l)); }

  _startPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._send(CMD.STATUS), 3000);
  }

  async _send(cmd) {
    if (!this.char) return;
    try { await this.char.writeValueWithoutResponse(new Uint8Array(cmd)); }
    catch (e) { console.warn('Heater write error:', e); }
  }

  _parse(dv) {
    const b = new Uint8Array(dv.buffer);
    if (b.length < 6) return;
    this.data.state       = b[2];
    this.data.targetTemp  = b[3];
    this.data.currentTemp = b[4];
    this.data.voltage     = (b[5] / 10).toFixed(1);
    this.data.power       = b[6] ?? this.data.power;
    this.data.error       = null;
    this.onUpdate({ ...this.data });
  }

  _onDisconnect() {
    clearInterval(this.pollTimer);
    this.data.connected = false;
    this.char = null;
    this.onUpdate({ ...this.data });
  }

  stateLabel() { return HEATER_STATE[this.data.state] ?? 'Sconosciuto'; }
}
