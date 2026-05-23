'use strict';
// ── Victron SmartSolar MPPT BLE ──────────────────────────────────────────────
// Victron uses BLE advertisements with encrypted manufacturer data.
// Company ID: 0x02E1.  Encryption: AES-128-CTR with per-device key.
// Key visible in VictronConnect → device → ⋮ → "Show encryption data".
//
// Fallback: if key not set, shows raw advertisement values where available.

const VICTRON_COMPANY_ID = 0x02E1;

// Charging state labels (Victron MPPT)
const CS = {
  0:'Off', 1:'Low power', 2:'Fault', 3:'Bulk', 4:'Absorption',
  5:'Float', 6:'Storage', 7:'Equalize', 9:'Inverting', 11:'Power supply',
  245:'Starting up', 247:'Auto equalize', 248:'External control',
};

const ERR = {
  0:'No error', 1:'Battery temp high', 2:'Battery voltage high',
  17:'Charger temp high', 18:'Charger overcurrent', 19:'Charger current reversed',
  20:'Bulk time limit exceeded', 21:'Current sensor issue', 26:'Terminals overheated',
  28:'Converter issue', 33:'Input voltage high', 34:'Input current high',
  38:'Input shutdown (excess battery voltage)', 116:'Calibration data lost',
  117:'Incompatible firmware', 119:'Settings data invalid',
};

export class VictronMPPT {
  constructor(label, onUpdate) {
    this.label    = label;
    this.onUpdate = onUpdate;
    this.device   = null;
    this.encKey   = null; // set via setKey()
    this.data = {
      connected: false, label,
      battV: '--', battA: '--', pvV: '--', pvW: '--',
      yieldToday: '--', cs: '--', error: '--', raw: null,
    };
  }

  setKey(hexKey) {
    // hexKey: 32-char hex string from VictronConnect
    if (!hexKey || hexKey.length !== 32) { this.encKey = null; return; }
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hexKey.slice(i*2, i*2+2), 16);
    this.encKey = bytes;
  }

  async connect() {
    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['0000180a-0000-1000-8000-00805f9b34fb'],
      });
      // Use advertisement scanning if supported
      if ('watchAdvertisements' in this.device) {
        this.device.addEventListener('advertisementreceived', e => this._onAdv(e));
        await this.device.watchAdvertisements();
        this.data.connected = true;
        this.onUpdate({ ...this.data });
        return true;
      }
      // Fallback: GATT connection for device info only
      const server = await this.device.gatt.connect();
      this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
      this.data.connected = true;
      this.data.cs = 'Connesso (BLE)';
      this.onUpdate({ ...this.data });
      return true;
    } catch (e) {
      console.error('Victron connect error:', e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    try { await this.device?.unwatchAdvertisements?.(); } catch {}
  }

  _onAdv(event) {
    const mfr = event.manufacturerData?.get(VICTRON_COMPANY_ID);
    if (!mfr) return;
    const raw = new Uint8Array(mfr.buffer);
    this.data.raw = raw;
    if (!this.encKey) {
      // Try to parse unencrypted (older devices or test mode)
      this._parseUnencrypted(raw);
    } else {
      this._parseEncrypted(raw);
    }
  }

  _parseUnencrypted(b) {
    // Record type 0x01 = MPPT (unencrypted)
    if (b[0] !== 0x01) return;
    this.data.cs         = CS[b[3]] ?? `Stato ${b[3]}`;
    this.data.pvV        = ((b[5] | b[6]<<8) * 0.01).toFixed(1);
    this.data.battV      = ((b[7] | b[8]<<8) * 0.01).toFixed(2);
    this.data.battA      = ((b[9] | b[10]<<8) * 0.1).toFixed(1);
    this.data.pvW        = ((b[11]| b[12]<<8)).toString();
    this.data.yieldToday = ((b[13]| b[14]<<8) * 0.01).toFixed(2);
    this.data.error      = ERR[b[4]] ?? `Err ${b[4]}`;
    this.onUpdate({ ...this.data });
  }

  async _parseEncrypted(b) {
    // AES-128-CTR decryption using Web Crypto
    try {
      const iv  = new Uint8Array(16);
      iv[0] = b[1]; iv[1] = b[2]; // nonce from advertisement
      const ciphertext = b.slice(3);
      const key = await crypto.subtle.importKey('raw', this.encKey, { name:'AES-CTR' }, false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-CTR', counter:iv, length:128 }, key, ciphertext));
      this._parseUnencrypted(new Uint8Array([b[0], ...plain]));
    } catch (e) {
      console.warn('Victron decrypt error:', e);
    }
  }

  _onDisconnect() {
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }
}
