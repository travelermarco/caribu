'use strict';
// ── Diesel Heater BLE (Vevor / Hcalory / generic Chinese UART-over-BLE) ────
// Service:        0000ffe0-0000-1000-8000-00805f9b34fb
// Characteristic: 0000ffe1-0000-1000-8000-00805f9b34fb (notify + write-without-response)
// Protocol:       7-byte command frames, 20-byte status responses

const HEATER_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const HEATER_CHAR    = '0000ffe1-0000-1000-8000-00805f9b34fb';

const CMD = {
  STATUS:   [0xAA, 0x55, 0x10, 0x00, 0x00, 0x00, 0x00],
  ON:       [0xAA, 0x55, 0x01, 0x00, 0x00, 0x00, 0x00],
  OFF:      [0xAA, 0x55, 0x02, 0x00, 0x00, 0x00, 0x00],
  SET_TEMP: (t) => [0xAA, 0x55, 0x03, t & 0xFF, 0x00, 0x00, 0x00],
  SET_LVL:  (l) => [0xAA, 0x55, 0x04, l & 0xFF, 0x00, 0x00, 0x00],
  // mode: 0=manual 1=thermostat (byte matches response inverted: resp 1=manual, 2=thermostat)
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
    this.onUpdate  = onUpdate;
    this.device    = null;
    this.char      = null;
    this.pollTimer = null;
    this.data = {
      connected: false, state: 0, currentTemp: '--', targetTemp: 20,
      voltage: '--', power: 1, errorCode: 0, mode: 1, error: null,
    };
  }

  async connect() {
    if (!navigator.bluetooth) {
      const msg = 'Web Bluetooth non supportato. Usa Chrome su Android/Desktop via HTTPS.';
      this.data.error = msg;
      this.onUpdate({ ...this.data });
      return false;
    }
    try {
      // acceptAllDevices: cheap BLE-UART modules (HM-10 etc.) don't advertise their
      // service UUID in the advertising packet, so filtering by service gives empty picker.
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [HEATER_SERVICE],
      });
      localStorage.setItem('ble_heater_id', this.device.id);
      return await this._connectDevice();
    } catch (e) {
      if (e.name === 'NotFoundError') return false; // utente ha annullato
      console.error('Heater connect error:', e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  // Called by auto-reconnect: skips the BLE picker, uses existing device object
  async reconnect(device) {
    this.device = device;
    try {
      return await this._connectDevice();
    } catch (e) {
      console.warn('Heater auto-reconnect failed:', e);
      return false;
    }
  }

  async _connectDevice() {
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    const server  = await this.device.gatt.connect();
    const service = await server.getPrimaryService(HEATER_SERVICE);
    this.char     = await service.getCharacteristic(HEATER_CHAR);
    await this.char.startNotifications();
    this.char.addEventListener('characteristicvaluechanged', e => this._parse(e.target.value));
    this.data.connected = true;
    this.data.error = null;
    this._startPoll();
    this.onUpdate({ ...this.data });
    return true;
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async turnOn() {
    this.data.state = 1; // optimistic: Avvio
    this.onUpdate({ ...this.data });
    await this._send(CMD.ON);
    await new Promise(r => setTimeout(r, 300));
    await this._send(CMD.ON); // send twice — some BLE-UART bridges drop the first packet
    setTimeout(() => this._send(CMD.STATUS), 1000);
  }

  async turnOff() {
    this.data.state = 4; // optimistic: Raffreddamento
    this.onUpdate({ ...this.data });
    await this._send(CMD.OFF);
    await new Promise(r => setTimeout(r, 300));
    await this._send(CMD.OFF);
    setTimeout(() => this._send(CMD.STATUS), 1000);
  }

  async setTemp(t) {
    this.data.targetTemp = t;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_TEMP(t));
  }

  async setLevel(l) {
    this.data.power = l;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_LVL(l));
  }

  // mode 1 = Manuale, mode 2 = Termostato
  // Dual approach: dedicated SET_MODE + reinforce with the matching control command
  async setMode(m) {
    this.data.mode = m;
    this.onUpdate({ ...this.data });
    await this._send(CMD.SET_MODE(m === 2 ? 1 : 0));
    await new Promise(r => setTimeout(r, 150));
    if (m === 2) await this._send(CMD.SET_TEMP(this.data.targetTemp));
    else         await this._send(CMD.SET_LVL(this.data.power));
    setTimeout(() => this._send(CMD.STATUS), 600);
  }

  _startPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._send(CMD.STATUS), 3000);
  }

  async _send(cmd) {
    if (!this.char) return;
    const data = new Uint8Array(cmd);
    console.log('Heater TX:', [...data].map(b => b.toString(16).padStart(2,'0')).join(' '),
      '| wwr:', this.char.properties.writeWithoutResponse, '| wr:', this.char.properties.write);
    try {
      if (this.char.properties.writeWithoutResponse) {
        await this.char.writeValueWithoutResponse(data);
      } else if (this.char.properties.write) {
        await this.char.writeValueWithResponse(data);
      } else {
        console.error('Heater char has no write property — cannot send commands');
      }
    } catch (e) {
      console.warn('Heater write error:', e);
      // Last-resort fallback: try the other method
      try {
        if (this.char.properties.writeWithoutResponse) await this.char.writeValueWithResponse(data);
        else await this.char.writeValueWithoutResponse(data);
      } catch (e2) { console.error('Heater write fallback failed:', e2); }
    }
  }

  _parse(dv) {
    const b = new Uint8Array(dv.buffer);
    if (b.length < 7) return; // need at least 7 bytes including power byte (b[6])
    this.data.state       = b[2];
    this.data.targetTemp  = b[3];
    this.data.currentTemp = b[4];
    this.data.voltage     = (b[5] / 10).toFixed(1);
    this.data.power       = b[6] ?? this.data.power;
    this.data.errorCode   = b.length > 7 ? b[7] : 0;
    this.data.mode        = b.length > 8 ? b[8] : 1; // 1=manuale, 2=termostato
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
