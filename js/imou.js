'use strict';
// ── Imou Open Platform API ────────────────────────────────────────────────────
// Register at: https://open.imoulife.com
// Docs: https://open.imoulife.com/book/en/

const BASE = 'https://openapi.lechange.cn:443/openapi';

export class ImouAPI {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.appId    = localStorage.getItem('imou_app_id')  || '';
    this.appSecret= localStorage.getItem('imou_app_secret') || '';
    this.token    = null;
    this.devices  = [];
    this.data     = { connected: false, devices: [], error: null };
  }

  hasCredentials() { return !!(this.appId && this.appSecret); }

  saveCredentials(id, secret) {
    this.appId     = id;
    this.appSecret = secret;
    localStorage.setItem('imou_app_id', id);
    localStorage.setItem('imou_app_secret', secret);
  }

  async connect() {
    if (!this.hasCredentials()) { this.data.error = 'Credenziali mancanti'; this.onUpdate({...this.data}); return false; }
    try {
      this.token = await this._getToken();
      const devs = await this._listDevices();
      this.data.devices   = devs;
      this.data.connected = true;
      this.data.error     = null;
      this.onUpdate({ ...this.data });
      return true;
    } catch (e) {
      this.data.error = e.message;
      this.onUpdate({ ...this.data });
      return false;
    }
  }

  async _call(cmd, params = {}) {
    const nonce   = Math.random().toString(36).slice(2);
    const time    = Math.floor(Date.now() / 1000);
    const sign    = await this._sign(this.appId, this.appSecret, time, nonce);
    const body = {
      system: { ver:'1.0', sign, appId:this.appId, time, nonce },
      params: { ...params, token: this.token ?? undefined },
    };
    const res = await fetch(`${BASE}/${cmd}`, {
      method: 'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (j.result?.code !== '0') throw new Error(j.result?.msg ?? 'API error');
    return j.result.data;
  }

  async _getToken() {
    const nonce = Math.random().toString(36).slice(2);
    const time  = Math.floor(Date.now() / 1000);
    const sign  = await this._sign(this.appId, this.appSecret, time, nonce);
    const body  = { system:{ ver:'1.0', sign, appId:this.appId, time, nonce }, params:{} };
    const res   = await fetch(`${BASE}/accessToken`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const j     = await res.json();
    if (j.result?.code !== '0') throw new Error(j.result?.msg ?? 'Auth failed');
    return j.result.data.accessToken;
  }

  async _listDevices() {
    const data = await this._call('deviceBaseList', { limit:20, offset:0 });
    return (data?.deviceList ?? []).map(d => ({ id:d.deviceId, name:d.deviceName, status:d.deviceStatus }));
  }

  async getSnapshot(deviceId) {
    const d = await this._call('getSnapShotAddress', { deviceId, channelId:'0' });
    return d?.url ?? null;
  }

  async _sign(appId, appSecret, time, nonce) {
    const str  = `time:${time},nonce:${nonce},appSecret:${appSecret}`;
    const buf  = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
}
