'use strict';
// ── Victron SmartSolar MPPT BLE ──────────────────────────────────────────────
// Victron broadcasts encrypted BLE advertisements.
// Company ID: 0x02E1
//
// Manufacturer data layout (fonte: Victron "Extra Manufacturer Data" spec 2022-12-14,
// keshavdv/victron-ble, implementazioni ESP32/Arduino):
//
//   byte 0-1: model_id (LE uint16)
//   byte 2-3: (parte del prefisso di modello / padding, ignorati per la decifrazione)
//   byte 4:   readout_type / record_type  (0x01 = Solar Charger)
//   byte 5-6: nonce (LE uint16) — usato come IV per AES-128-CTR
//   byte 7:   primo byte della chiave di cifratura (key check, non parte del payload)
//   byte 8+:  AES-128-CTR encrypted payload
//
// Key (32 hex chars): VictronConnect → device → ⋮ → "Show encryption data"
//
// AES-CTR IV: il nonce (2 byte LE) va nei byte BASSI dell'IV a 128 bit:
//   iv[0] = raw[5]  (nonce low byte)
//   iv[1] = raw[6]  (nonce high byte)
//   iv[2..15] = 0x00
// Il contatore AES-CTR parte da 0 e incrementa ogni 16 byte di keystream (length=128).
//
// Decrypted Solar Charger payload (record_type 0x01) — LSB-first bit packing
// (fonte: Victron Extra Manufacturer Data spec, tabella Solar Charger):
//   offset  bits  field               scale
//   0       4     charge_state        enum CS
//   4       8     error_code          enum ERR
//   12      10    battery_voltage     × 0.01 V   (raw unit = 10 mV)
//   22      11    battery_current     × 0.1 A    (signed 11-bit, raw unit = 0.1 A)
//   33      9     yield_today         × 0.01 kWh (raw unit = 10 Wh)
//   42      8     solar_power         × 1 W
//   50      9     pv_voltage          × 0.1 V    (opzionale, non tutti i modelli)
//
// NOTA: battery_voltage raw è in unità da 10 mV → dividere per 100 per ottenere volt.
// Es: raw 1234 → 1234 × 0.01 = 12.34 V

const VICTRON_COMPANY_ID = 0x02E1;
const SOLAR_CHARGER_RECORD_TYPE = 0x01;

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
  38:'Input shutdown', 116:'Calibration data lost',
  117:'Incompatible firmware', 119:'Settings data invalid',
};

export class VictronMPPT {
  constructor(label, onUpdate) {
    this.label    = label;
    this.onUpdate = onUpdate;
    this.device   = null;
    this.encKey   = null;
    this.data = {
      connected: false, label,
      battV: '--', battA: '--', battW: '--',
      pvW: '--', pvV: '--', pvA: '--',
      yieldToday: '--', yieldYesterday: '--', maxPowerToday: '--',
      cs: '--', csNum: -1, isCharging: false, error: '--', raw: null,
      plainHex: null, plainRaw: null, lastUpdate: null,
    };
  }

  setKey(hexKey) {
    if (!hexKey || hexKey.length !== 32) { this.encKey = null; return; }
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
    this.encKey = bytes;
  }

  async connect() {
    try {
      // acceptAllDevices: Victron data arrives via BLE advertisements, no GATT needed.
      // optionalManufacturerData: without this Chrome 92+ strips manufacturer data
      // from advertisementreceived events, so event.manufacturerData.get(0x02E1) is always empty.
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [],
        optionalManufacturerData: [VICTRON_COMPANY_ID],
      });
      localStorage.setItem(`ble_${this.label.replace(/\s/g, '').toLowerCase()}_id`, this.device.id);
      localStorage.setItem(`ble_${this.label.replace(/\s/g, '').toLowerCase()}_name`, this.device.name || this.label);
      return await this._startAdvertisements();
    } catch (e) {
      console.error(`Victron ${this.label} connect error:`, e);
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  // Called by auto-reconnect: skips the BLE picker, uses existing device object
  async reconnect(device) {
    this.device = device;
    try {
      return await this._startAdvertisements();
    } catch (e) {
      console.warn(`Victron ${this.label} auto-reconnect failed:`, e);
      return false;
    }
  }

  async _startAdvertisements() {
    if (!('watchAdvertisements' in this.device)) {
      // watchAdvertisements not supported (e.g. iOS) — show connected but no live data
      this.data.connected = true;
      this.data.cs = 'Connesso (no adv.)';
      this.onUpdate({ ...this.data });
      return true;
    }
    this.device.addEventListener('advertisementreceived', e => this._onAdv(e));
    await this.device.watchAdvertisements();
    this.data.connected = true;
    this.onUpdate({ ...this.data });
    return true;
  }

  async disconnect() {
    try { await this.device?.unwatchAdvertisements?.(); } catch {}
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.data.connected = false;
    this.onUpdate({ ...this.data });
  }

  _onAdv(event) {
    const mfrKeys = [...(event.manufacturerData?.keys() ?? [])];
    console.log(`[Victron ${this.label}] adv received — mfr IDs:`, mfrKeys.map(k => '0x' + k.toString(16)));
    const mfr = event.manufacturerData?.get(VICTRON_COMPANY_ID);
    if (!mfr) { console.warn(`[Victron ${this.label}] no Victron mfr data (0x02E1) in adv`); return; }
    const raw = new Uint8Array(mfr.buffer);
    this.data.raw = raw;

    // Minimum: 2 (model_id) + 2 (prefix) + 1 (record_type) + 2 (nonce) + 1 (key_check) + 1 (≥1 byte payload)
    if (raw.length < 9) return;

    const modelId    = (raw[0] | (raw[1] << 8)).toString(16).toUpperCase().padStart(4, '0');
    const recordType = raw[4];

    if (!this.encKey) {
      console.log(`[Victron ${this.label}] Adv received, model 0x${modelId}, record_type 0x${recordType.toString(16).padStart(2,'0')} — imposta la chiave per vedere i dati`);
      return;
    }

    // Verifica opzionale: byte 7 deve corrispondere al primo byte della chiave
    if (raw[7] !== this.encKey[0]) {
      console.warn(`[Victron ${this.label}] Key check fallito: adv[7]=0x${raw[7].toString(16)} ≠ key[0]=0x${this.encKey[0].toString(16)}`);
      // Non interrompere: alcuni firmware potrebbero non implementare il key check
    }

    if (recordType !== SOLAR_CHARGER_RECORD_TYPE) {
      console.log(`[Victron ${this.label}] Record type 0x${recordType.toString(16).padStart(2,'0')} ignorato (atteso 0x01 Solar Charger)`);
      return;
    }

    this._decrypt(raw).catch(e => console.error(`[Victron ${this.label}] Unhandled decrypt:`, e));
  }

  async _decrypt(raw) {
    try {
      // Nonce: bytes 5-6 (LE uint16)
      // AES-CTR IV: nonce come intero little-endian nei byte BASSI del vettore a 128 bit.
      // Fonte: Victron Extra Manufacturer Data spec + keshavdv/victron-ble base.py
      //   Python: nonce_int = int.from_bytes(raw[5:7], "little")
      //           iv = nonce_int.to_bytes(16, "little")  → iv[0]=raw[5], iv[1]=raw[6], iv[2..15]=0
      const iv = new Uint8Array(16); // inizializzato a zero
      iv[0] = raw[5]; // nonce low byte  (LE: byte meno significativo prima)
      iv[1] = raw[6]; // nonce high byte

      // Payload cifrato: da byte 8 in poi (dopo model_id, prefix, record_type, nonce, key_check)
      const ciphertext = raw.slice(8);

      const key = await crypto.subtle.importKey(
        'raw', this.encKey, { name: 'AES-CTR' }, false, ['decrypt']
      );

      // length: 128 → il contatore occupa i 128 bit meno significativi (tutta la parola counter)
      // Web Crypto API AES-CTR: counter è big-endian, i bit del contatore sono i 'length' bit LSB.
      // Con length=64 e iv[0..7]=nonce, iv[8..15]=0: il contatore incrementa i byte 8-15.
      // Con length=128: il contatore incrementa tutti i 16 byte (usato per compatibilità con
      // pycryptodome CTR little-endian: nonce in iv[0..1], counter parte da 0 → primo blocco = iv).
      // Il primo blocco keystream è AES(key, iv) usato XOR sul primo blocco di ciphertext.
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: iv, length: 128 }, key, ciphertext
      ));

      console.log(`[Victron ${this.label}] Decrypted (${plain.length}B):`, [...plain].map(b => b.toString(16).padStart(2, '0')).join(' '));
      this._parseSolarPayload(plain);
    } catch (e) {
      console.warn(`[Victron ${this.label}] Decrypt error:`, e);
    }
  }

  _parseSolarPayload(d) {
    // Lettore bit LSB-first (Victron usa bit packing little-endian)
    const bits = (offset, len) => {
      let val = 0;
      for (let i = 0; i < len; i++) {
        const byteIdx = Math.floor((offset + i) / 8);
        const bitIdx  = (offset + i) % 8;
        if (byteIdx < d.length) val |= ((d[byteIdx] >> bitIdx) & 1) << i;
      }
      return val;
    };

    // Empirically verified: "03 00 46 05 6b 00 11 00 93 00 ff ff"
    // battV=13.50V ✓  battA=10.45A ✓  yieldToday=0.53kWh ✓  pvW=147W ✓
    const cs      = bits(0,  4);    // charge state enum
    const errCode = bits(4,  8);    // error code
    const battVr = bits(16, 11);  // 10mV/unit → ÷100 = V   (1350→13.50V ✓)
    const battIr = bits(22, 10);  // 0.5A/unit               (21×0.5=10.5A ✓, 10bit fixes jumping)
    const yTr    = bits(33, 9);   // 10Wh/unit → ÷100 = kWh  (53→0.53kWh ✓)
    // bits 40-63: unknown layout — pvV position not confirmed, shown as diagnostic raw
    const pvVr   = bits(48, 8);   // pvV candidate: byte6 — unit/pos to verify with VictronConnect
    const pvWr   = bits(64, 8);   // 1W/unit                  (0x93=147W ✓)
    const yYr    = bits(72, 8);   // yield yesterday candidate — verify with VictronConnect
    const maxPWr = bits(80, 8);   // max power today candidate — verify with VictronConnect

    const NA11 = 0x7FF;
    const NA10 = 0x3FF;
    const NA9  = 0x1FF;
    const NA8  = 0xFF;

    this.data.csNum      = cs;
    this.data.cs         = CS[cs]       ?? `CS ${cs}`;
    this.data.isCharging = (cs === 3 || cs === 4);
    this.data.error      = ERR[errCode] ?? (errCode === 0 ? 'No error' : `Err ${errCode}`);

    const battVval = battVr === NA11 ? null : battVr * 0.01;
    const battIval = battIr === NA10 ? null : battIr * 0.5;
    const pvWval   = pvWr   === NA8  ? null : pvWr;

    this.data.battV = battVval !== null ? battVval.toFixed(2) : '--';
    this.data.battA = battIval !== null ? battIval.toFixed(1) : '--';
    this.data.battW = (battVval !== null && battIval !== null)
      ? (battVval * battIval).toFixed(0) : '--';

    this.data.pvW = pvWval !== null ? pvWval.toString() : '--';

    // pvV/pvA: position not confirmed — shown only in diagnostic for calibration
    this.data.pvV = '--';
    this.data.pvA = '--';

    this.data.yieldToday     = yTr    === NA9 ? '--' : (yTr    * 0.01).toFixed(2);
    this.data.yieldYesterday = yYr    === NA8 ? '--' : (yYr * 0.1).toFixed(1);
    this.data.maxPowerToday  = maxPWr === NA8 ? '--' : maxPWr.toString();

    this.data.plainHex = [...d].map(b => b.toString(16).padStart(2,'0')).join(' ');
    this.data.plainRaw = { cs, errCode, battVr, battIr, yTr, pvVr, pvWr, yYr, maxPWr };
    this.data.lastUpdate = new Date().toLocaleTimeString('it-IT');

    this.onUpdate({ ...this.data });
  }

  _onDisconnect() {
    this.data.connected = false;
    this.onUpdate({ ...this.data });
    if (this.device) this._scheduleRetry(0);
  }

  async _scheduleRetry(attempt) {
    if (attempt >= 6 || this.data.connected) return;
    const delay = [3000, 5000, 10000, 15000, 20000, 30000][attempt];
    await new Promise(r => setTimeout(r, delay));
    if (this.data.connected) return;
    try { await this._startAdvertisements(); }
    catch { this._scheduleRetry(attempt + 1); }
  }
}
