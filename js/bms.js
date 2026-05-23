'use strict';
// ── XiaoXiang BMS BLE ────────────────────────────────────────────────────────
// Service:  0000ff00-0000-1000-8000-00805f9b34fb
// Write:    0000ff02  Notify: 0000ff01

const SVC   = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE = '0000ff02-0000-1000-8000-00805f9b34fb';
const NOTIF = '0000ff01-0000-1000-8000-00805f9b34fb';

const CMD_BASIC = new Uint8Array([0xDD, 0xA5, 0x03, 0x00, 0xFF, 0xFD, 0x77]);
const CMD_CELLS = new Uint8Array([0xDD, 0xA5, 0x04, 0x00, 0xFF, 0xFC, 0x77]);

export class BMABLE {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.device   = null;
    this.wChar    = null;
    this.buf      = [];
    this.pollTimer = null;
    this.data = {
      connected: false, soc: '--', voltage: '--', current: '--',
      remaining: '--', capacity: '--', cycles: '--',
      temps: [], cells: [], protect: 0, error: null,
    };
  }

  async connect() {
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SVC] }],
        optionalServices: [SVC],
      });
      this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
      const server  = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SVC);
      this.wChar    = await service.getCharacteristic(WRITE);
      const nChar   = await service.getCharacteristic(NOTIF);
      await nChar.startNotifications();
      nChar.addEventListener('characteristicvaluechanged', e => this._rx(e.target.value));
      this.data.connected = true;
      this._startPoll();
      this.onUpdate({ ...this.data });
      return true;
    } catch (e) {
      console.error('BMS connect error:', e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  async disconnect() {
    clearInterval(this.pollTimer);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  _startPoll() {
    const poll = async () => {
      await this._send(CMD_BASIC);
      await new Promise(r => setTimeout(r, 600));
      await this._send(CMD_CELLS);
    };
    poll();
    this.pollTimer = setInterval(poll, 5000);
  }

  async _send(cmd) {
    if (!this.wChar) return;
    try { await this.wChar.writeValue(cmd); }
    catch (e) { console.warn('BMS write error:', e); }
  }

  _rx(dv) {
    const b = Array.from(new Uint8Array(dv.buffer));
    this.buf.push(...b);
    // look for complete frame (header DD, ends with 77)
    while (this.buf.length >= 7) {
      const start = this.buf.indexOf(0xDD);
      if (start === -1) { this.buf = []; break; }
      if (start > 0) { this.buf = this.buf.slice(start); continue; }
      const len = this.buf[3];
      if (this.buf.length < len + 7) break;
      const frame = this.buf.splice(0, len + 7);
      this._parseFrame(frame);
    }
  }

  _parseFrame(b) {
    const cmd = b[1];
    if (b[2] !== 0x00) return; // error response
    const d = b.slice(4, 4 + b[3]);

    if (cmd === 0x03) { // basic info
      const u16 = (i) => ((d[i] << 8) | d[i+1]);
      const i16 = (i) => { const v = u16(i); return v & 0x8000 ? v - 0x10000 : v; };
      this.data.voltage   = (u16(0) * 0.01).toFixed(2);
      this.data.current   = (i16(2) * 0.01).toFixed(2);
      this.data.remaining = (u16(4) * 0.01).toFixed(1);
      this.data.capacity  = (u16(6) * 0.01).toFixed(1);
      this.data.cycles    = u16(8);
      this.data.protect   = u16(16);
      this.data.soc       = d[19];
      const ntc = d[22];
      this.data.temps = [];
      for (let i = 0; i < ntc; i++) {
        const raw = ((d[23 + i*2] << 8) | d[24 + i*2]);
        this.data.temps.push(((raw - 2731) / 10).toFixed(1));
      }
      this.onUpdate({ ...this.data });
    }

    if (cmd === 0x04) { // cell voltages
      const count = b[3] / 2;
      this.data.cells = [];
      for (let i = 0; i < count; i++) {
        this.data.cells.push(((d[i*2] << 8 | d[i*2+1]) * 0.001).toFixed(3));
      }
      this.onUpdate({ ...this.data });
    }
  }

  _onDisconnect() {
    clearInterval(this.pollTimer);
    this.data.connected = false;
    this.wChar = null;
    this.onUpdate({ ...this.data });
  }
}
