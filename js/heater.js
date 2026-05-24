'use strict';
// ── Diesel Heater BLE (Vevor / Hcalory / generic Chinese UART-over-BLE) ────
// Service:        0000ffe0-0000-1000-8000-00805f9b34fb
// Characteristic: 0000ffe1-0000-1000-8000-00805f9b34fb (notify + write)
//   Some HM-10 clones split Tx/Rx: FFE1=notify, FFE2=write.
//   _connectDevice() enumerates all chars and picks the right ones.
//
// Protocol: 7-byte command frames [0xAA, 0x55, cmd, data, 0x00, 0x00, 0x00]
//           Response: ≥3 bytes, typically [0xAA, 0x55, state, targetT, currentT, volt×10, power, ...]

const HEATER_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';

const CMD = {
  STATUS:   [0xAA, 0x55, 0x10, 0x00, 0x00, 0x00, 0x00],
  ON_A:     [0xAA, 0x55, 0x01, 0x00, 0x00, 0x00, 0x00],
  ON_B:     [0xAA, 0x55, 0x01, 0x01, 0x00, 0x00, 0x00],
  OFF_A:    [0xAA, 0x55, 0x02, 0x00, 0x00, 0x00, 0x00],
  OFF_B:    [0xAA, 0x55, 0x02, 0x01, 0x00, 0x00, 0x00],
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
      voltage: '--', power: 1, errorCode: 0, mode: 1, error: null, rawHex: null,
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

    // Enumerate all characteristics — some HM-10 clones split notify (FFE1) and write (FFE2)
    const chars = await service.getCharacteristics();
    console.log('Heater characteristics:',
      chars.map(c => `${c.uuid.slice(4,8)} [n:${c.properties.notify} w:${c.properties.write} wwr:${c.properties.writeWithoutResponse}]`).join(' | ')
    );

    let notifyChar = null;
    let writeChar  = null;

    for (const c of chars) {
      if ((c.properties.notify || c.properties.indicate) && !notifyChar) notifyChar = c;
      if ((c.properties.write || c.properties.writeWithoutResponse) && !writeChar)  writeChar  = c;
    }

    // Fallback: if nothing matched (e.g. properties not exposed), use first char for both
    if (!notifyChar && !writeChar && chars.length > 0) { notifyChar = chars[0]; writeChar = chars[0]; }
    if (!notifyChar) notifyChar = writeChar;
    if (!writeChar)  writeChar  = notifyChar;

    if (!notifyChar) throw new Error('Nessuna caratteristica trovata nel servizio FFE0');

    console.log(`Heater: notifyChar=${notifyChar.uuid.slice(4,8)} writeChar=${writeChar.uuid.slice(4,8)}`);

    this.notifyChar = notifyChar;
    this.writeChar  = writeChar;

    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', e => this._parse(e.target.value));

    this.data.connected = true;
    this.data.error = null;
    this.onUpdate({ ...this.data });

    // Initial status request, then slow poll
    await this._send(CMD.STATUS);
    this._startPoll();
    return true;
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.writeChar  = null;
    this.notifyChar = null;
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }

  async turnOn() {
    this.data.state = 1;
    this.onUpdate({ ...this.data });
    await this._send(CMD.ON_A);
    await this._delay(300);
    await this._send(CMD.ON_B);
    this._scheduleStatus(1500);
  }

  async turnOff() {
    this.data.state = 4;
    this.onUpdate({ ...this.data });
    await this._send(CMD.OFF_A);
    await this._delay(300);
    await this._send(CMD.OFF_B);
    this._scheduleStatus(1500);
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

  _scheduleStatus(ms) {
    setTimeout(() => this._send(CMD.STATUS), ms);
  }

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async _send(cmd) {
    if (!this.writeChar) return;
    const data = new Uint8Array(cmd);
    console.log('Heater TX →', [...data].map(b => b.toString(16).padStart(2,'0')).join(' '));
    // Always try writeValueWithoutResponse first (standard for HM-10 BLE-UART)
    // then fall back to writeValueWithResponse — property flags are unreliable on clones
    try {
      await this.writeChar.writeValueWithoutResponse(data);
    } catch (e1) {
      try {
        await this.writeChar.writeValueWithResponse(data);
      } catch (e2) {
        console.error('Heater write failed (wwr:', e1.message, '/ wr:', e2.message + ')');
      }
    }
  }

  _parse(dv) {
    const b = new Uint8Array(dv.buffer);
    const rawHex = [...b].map(x => x.toString(16).padStart(2,'0')).join(' ');
    console.log('Heater RX ←', rawHex);
    this.data.rawHex = rawHex;

    // Validate header [0xAA, 0x55] if we have at least 2 bytes
    if (b.length >= 2 && (b[0] !== 0xAA || b[1] !== 0x55)) {
      console.warn('Heater RX: unexpected header', rawHex);
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
    this.writeChar  = null;
    this.notifyChar = null;
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }

  stateLabel() { return HEATER_STATE[this.data.state] ?? 'Sconosciuto'; }
}
