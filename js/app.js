'use strict';
import { HeaterBLE, HEATER_ERROR }  from './heater.js';
import { BMABLE }                    from './bms.js';
import { VictronMPPT }               from './victron.js';
import { ImouAPI }                   from './imou.js';
import { MiniChart }                 from './chart.js';

// ── Charts ────────────────────────────────────────────────────────────────────
const chartSOC = new MiniChart({
  maxPoints: 60,
  height: 100,
  yMin: 0,
  yMax: 100,
  yLabel: '%',
  colorFn: (v) => v >= 50 ? '#4ADE80' : v >= 20 ? '#F59E0B' : '#F87171',
});

const chartBMSPower = new MiniChart({
  maxPoints: 60,
  height: 80,
  yLabel: 'W',
  dualColor: true,
});

const chartPVPower = new MiniChart({
  maxPoints: 60,
  height: 100,
  yMin: 0,
  yLabel: 'W',
  colorFn: () => '#F59E0B',
});

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  heater: { connected:false, state:0, currentTemp:'--', targetTemp:20, voltage:'--', power:1, errorCode:0, mode:1 },
  bms:    { connected:false, soc:'--', voltage:'--', current:'--', remaining:'--', capacity:'--', cycles:'--', temps:[], cells:[], protect:0, fetCharge:true, fetDischarge:true, balance:0, cellCount:0 },
  mppt1:  { connected:false, label:'MPPT 1', battV:'--', battA:'--', pvW:'--', pvV:'--', yieldToday:'--', yieldYesterday:'--', maxPowerToday:'--', cs:'--', error:'--' },
  mppt2:  { connected:false, label:'MPPT 2', battV:'--', battA:'--', pvW:'--', pvV:'--', yieldToday:'--', yieldYesterday:'--', maxPowerToday:'--', cs:'--', error:'--' },
  imou:   { connected:false, devices:[], error:null },
};

// ── Device instances ──────────────────────────────────────────────────────────
const heater = new HeaterBLE(d => { Object.assign(state.heater, d); renderHeater(); renderDash(); updateDots(); });
const bms    = new BMABLE   (d => {
  Object.assign(state.bms, d);
  // Push chart data
  const socN = parseInt(state.bms.soc);
  if (!isNaN(socN)) chartSOC.push(socN);
  const bmsW = battWatts(state.bms.voltage, state.bms.current);
  if (bmsW !== null) chartBMSPower.push(bmsW);
  renderBMS();    renderDash(); updateDots();
});
const mppt1  = new VictronMPPT('MPPT 1', d => {
  Object.assign(state.mppt1, d);
  _pushPVChart();
  renderVictron(); renderDash(); updateDots();
});
const mppt2  = new VictronMPPT('MPPT 2', d => {
  Object.assign(state.mppt2, d);
  _pushPVChart();
  renderVictron(); renderDash(); updateDots();
});

function _pushPVChart() {
  const w1 = parseFloat(state.mppt1.pvW) || 0;
  const w2 = parseFloat(state.mppt2.pvW) || 0;
  if (w1 + w2 > 0 || state.mppt1.connected || state.mppt2.connected) {
    chartPVPower.push(w1 + w2);
  }
}
const imou   = new ImouAPI  (d => { Object.assign(state.imou, d); renderImou(); updateDots(); });

// ── Heater schedule ───────────────────────────────────────────────────────────
const sched = {
  startTime: localStorage.getItem('heater_sched_start') || '',
  stopTime:  localStorage.getItem('heater_sched_stop')  || '',
  enabled:   localStorage.getItem('heater_sched_on') === '1',
  startTimer: null,
  stopTimer:  null,
  countdownTimer: null,
};

function schedApply() {
  clearTimeout(sched.startTimer);
  clearTimeout(sched.stopTimer);
  clearInterval(sched.countdownTimer);
  if (!sched.enabled) { renderHeaterSched(); return; }

  const msUntil = (hhmm) => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const t = new Date(now); t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t - now;
  };

  const ms1 = msUntil(sched.startTime);
  const ms2 = msUntil(sched.stopTime);
  if (ms1 !== null) sched.startTimer = setTimeout(() => { heater.turnOn(); toast('⏰ Riscaldatore acceso (timer)'); }, ms1);
  if (ms2 !== null) sched.stopTimer  = setTimeout(() => { heater.turnOff(); toast('⏰ Riscaldatore spento (timer)'); }, ms2);

  sched.countdownTimer = setInterval(renderHeaterSched, 10000);
  renderHeaterSched();
}

function renderHeaterSched() {
  const el2 = document.getElementById('heater-sched');
  if (!el2) return;
  const countdown = (hhmm) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const t = new Date(now); t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    const diff = Math.round((t - now) / 60000);
    const dh = Math.floor(diff / 60), dm = diff % 60;
    return ` <span style="color:var(--text-2);font-size:11px">(tra ${dh > 0 ? dh + 'h ' : ''}${dm}m)</span>`;
  };
  el2.innerHTML = `
    <div class="settings-row">
      <label>Programmazione</label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="sched-enabled" ${sched.enabled ? 'checked' : ''} onchange="schedToggle(this.checked)" style="width:18px;height:18px;accent-color:var(--amber)">
        <span style="font-size:13px">${sched.enabled ? 'Attiva' : 'Disattiva'}</span>
      </label>
    </div>
    <div class="settings-row">
      <label>Accendi alle${sched.enabled && sched.startTime ? countdown(sched.startTime) : ''}</label>
      <input type="time" id="sched-start" value="${sched.startTime}"
        style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:14px"
        onchange="schedSave('start',this.value)">
    </div>
    <div class="settings-row">
      <label>Spegni alle${sched.enabled && sched.stopTime ? countdown(sched.stopTime) : ''}</label>
      <input type="time" id="sched-stop" value="${sched.stopTime}"
        style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:14px"
        onchange="schedSave('stop',this.value)">
    </div>
    ${sched.enabled ? `<div style="font-size:11px;color:var(--amber);margin-top:4px">⏰ Timer attivo — mantieni l'app aperta</div>` : ''}
  `;
}

window.schedToggle = (on) => { sched.enabled = on; localStorage.setItem('heater_sched_on', on ? '1' : '0'); schedApply(); };
window.schedSave   = (k, v) => {
  if (k === 'start') { sched.startTime = v; localStorage.setItem('heater_sched_start', v); }
  else               { sched.stopTime  = v; localStorage.setItem('heater_sched_stop',  v); }
  if (sched.enabled) schedApply(); else renderHeaterSched();
};

// Load saved Victron keys
const k1 = localStorage.getItem('victron_key_1');
const k2 = localStorage.getItem('victron_key_2');
if (k1) mppt1.setKey(k1);
if (k2) mppt2.setKey(k2);

// ── Tab routing ───────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${t}`));
  });
});

// ── Connection dots ───────────────────────────────────────────────────────────
function updateDots() {
  const dot = (id, ok) => {
    const el = document.getElementById(id);
    if (el) el.className = 'conn-dot' + (ok ? ' ok' : '');
  };
  dot('dot-heater', state.heater.connected);
  dot('dot-bms',    state.bms.connected);
  dot('dot-mppt1',  state.mppt1.connected);
  dot('dot-mppt2',  state.mppt2.connected);
}

function setDotConnecting(id) {
  const el = document.getElementById(id);
  if (el) el.className = 'conn-dot connecting';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function badge(type, text) {
  return `<span class="badge badge-${type}"><span class="badge-dot"></span>${text}</span>`;
}
function placeholder(icon, text) {
  return `<div style="text-align:center;padding:4px 0"><div style="font-size:28px;opacity:.4">${icon}</div><div style="font-size:12px;color:var(--text-2);margin-top:4px">${text}</div></div>`;
}
function statCard(label, color, value, unit) {
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" style="color:${color}">${value}<span class="stat-unit">${unit}</span></div></div>`;
}

// Calcola ETA a pieno (se in carica) o a scarico (se in scarica).
// Ritorna null se non applicabile (standby o dati mancanti).
function calcETA(current, remaining, capacity) {
  const curr = parseFloat(current);
  const rem  = parseFloat(remaining);
  const cap  = parseFloat(capacity);
  if (isNaN(curr) || isNaN(rem) || isNaN(cap) || cap <= 0) return null;
  let hours;
  if (curr > 0.1) {
    const toFull = cap - rem;
    if (toFull <= 0) return null; // già piena
    hours = toFull / curr;
  } else if (curr < -0.1) {
    if (rem <= 0) return null;
    hours = rem / Math.abs(curr);
  } else {
    return null; // standby
  }
  if (hours < 0 || !isFinite(hours)) return null;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function chargeStatus(current) {
  const curr = parseFloat(current);
  if (curr > 0.1)  return { label: 'In carica',  badge: 'green' };
  if (curr < -0.1) return { label: 'In scarica', badge: 'amber' };
  return { label: 'Standby', badge: 'grey' };
}

function battWatts(voltage, current) {
  const v = parseFloat(voltage);
  const a = parseFloat(current);
  if (isNaN(v) || isNaN(a)) return null;
  const w = v * a;
  if (Math.abs(w) < 0.5) return null;
  return w;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDash() {
  // Heater card
  const hs = state.heater;
  const heaterOn = hs.state === 1 || hs.state === 2;
  const heaterErr = hs.errorCode && HEATER_ERROR[hs.errorCode];
  el('dash-heater').innerHTML = hs.connected
    ? `<div class="temp-row" style="padding:0">
         <div class="temp-box"><div class="label">Attuale</div><div class="temp-current" style="font-size:36px">${hs.currentTemp}°</div></div>
         <div class="temp-box"><div class="label">Target</div><div class="temp-target" style="font-size:28px">${hs.targetTemp}°</div></div>
       </div>
       <div style="margin-top:8px">${badge(heaterOn ? 'green' : 'grey', heaterOn ? 'Attivo' : heater.stateLabel())}</div>
       ${heaterErr ? `<div style="font-size:11px;color:var(--red);margin-top:4px">⚠ ${heaterErr}</div>` : ''}`
    : placeholder('🔥', 'Non connesso');

  // BMS card
  const bs = state.bms;
  const socNum = parseInt(bs.soc);
  const socColor = socNum >= 50 ? 'var(--green)' : socNum >= 20 ? 'var(--amber)' : 'var(--red)';
  const cs  = chargeStatus(bs.current);
  const eta = calcETA(bs.current, bs.remaining, bs.capacity);
  const bmsW = battWatts(bs.voltage, bs.current);
  const bmsWColor = bmsW > 0 ? 'var(--green)' : 'var(--amber)';
  el('dash-bms').innerHTML = bs.connected
    ? `<div class="big-num" style="color:${socColor};font-size:42px">${bs.soc}<span class="big-unit" style="font-size:16px">%</span></div>
       <div class="stat-sub" style="margin-bottom:4px">${bs.voltage} V · ${bs.current} A${bmsW !== null ? ` · <span style="color:${bmsWColor};font-weight:700">${bmsW > 0 ? '+' : ''}${bmsW.toFixed(0)} W</span>` : ''}</div>
       <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
         ${badge(cs.badge, cs.label)}
         ${eta !== null ? `<span class="badge badge-grey">⏱ ${eta}</span>` : ''}
       </div>`
    : placeholder('🔋', 'Non connesso');

  // Solar card
  const totalW = (() => {
    const w1 = parseFloat(state.mppt1.pvW) || 0;
    const w2 = parseFloat(state.mppt2.pvW) || 0;
    return (w1 + w2) > 0 ? (w1 + w2).toFixed(0) : '--';
  })();
  const yT = (() => {
    const y1 = parseFloat(state.mppt1.yieldToday) || 0;
    const y2 = parseFloat(state.mppt2.yieldToday) || 0;
    return (y1 + y2) > 0 ? (y1 + y2).toFixed(2) : '--';
  })();
  el('dash-solar').innerHTML = (state.mppt1.connected || state.mppt2.connected)
    ? `<div class="big-num" style="color:var(--amber);font-size:38px">${totalW}<span class="big-unit" style="font-size:14px">W</span></div>
       <div class="stat-sub">Oggi: ${yT} kWh</div>`
    : placeholder('☀️', 'Non connesso');

  // Imou card
  const ic = state.imou;
  el('dash-imou').innerHTML = ic.connected
    ? `<div style="font-size:13px;color:var(--text-2)">${ic.devices.length} camera${ic.devices.length !== 1 ? 'e' : ''}</div>
       ${badge('green', 'Online')}`
    : placeholder('📷', 'Non connesso');
}

// ── Heater screen ─────────────────────────────────────────────────────────────
function renderHeater() {
  const hs = state.heater;
  if (!hs.connected) {
    el('heater-body').innerHTML = `<div class="connect-placeholder"><div class="icon">🔥</div><p>Connetti il riscaldatore via Bluetooth</p><button class="btn btn-primary btn-full" onclick="connectHeater()">Connetti</button></div>`;
    return;
  }
  const heaterOn  = hs.state === 1 || hs.state === 2;
  const errLabel  = hs.errorCode ? (HEATER_ERROR[hs.errorCode] ?? `E-${String(hs.errorCode).padStart(2, '0')}`) : null;
  const modeLabel = hs.mode === 2 ? 'Termostato' : 'Manuale';

  el('heater-body').innerHTML = `
    <div class="card">
      <div class="card-row" style="justify-content:center;flex-direction:column;gap:12px">
        <div class="temp-row">
          <div class="temp-box"><div class="label">Temperatura attuale</div><div class="temp-current">${hs.currentTemp}°C</div></div>
          <div class="temp-box"><div class="label">Target</div><div class="temp-target">${hs.targetTemp}°C</div></div>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          ${badge(heaterOn ? 'green' : hs.state === 4 ? 'amber' : 'grey', heater.stateLabel())}
          ${badge('grey', modeLabel)}
        </div>
        ${errLabel ? `<div class="alert alert-err" style="margin:0">⚠️ ${errLabel}</div>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Accensione</div>
      <button class="power-btn ${heaterOn ? 'on' : ''}" onclick="toggleHeater()">⏻</button>
      <div style="text-align:center;font-size:12px;color:var(--text-2);margin-top:4px">${heaterOn ? 'Tocca per spegnere' : 'Tocca per accendere'}</div>
    </div>

    <div class="card">
      <div class="card-title">Modalità</div>
      <div style="display:flex;gap:8px">
        <button class="btn ${hs.mode !== 2 ? 'btn-primary' : 'btn-ghost'} btn-full" onclick="setHeaterMode(1)">🔥 Manuale</button>
        <button class="btn ${hs.mode === 2 ? 'btn-primary' : 'btn-ghost'} btn-full" onclick="setHeaterMode(2)">🌡️ Termostato</button>
      </div>
      ${hs.mode === 2 ? `
      <div class="slider-wrap" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:8px">Temperatura target</div>
        <div class="slider-label"><span>15°C</span><span id="temp-val">${hs.targetTemp}°C</span><span>35°C</span></div>
        <input type="range" min="15" max="35" value="${hs.targetTemp}" id="temp-slider"
          oninput="document.getElementById('temp-val').textContent=this.value+'°C'"
          onchange="setHeaterTemp(+this.value)">
      </div>` : `
      <div style="margin-top:14px">
        <div class="card-title" style="margin-bottom:8px">Livello potenza</div>
        <div class="level-pills">
          ${[1,2,3,4,5,6,7,8,9,10].map(l => `<div class="level-pill ${hs.power===l?'active':''}" onclick="setHeaterLevel(${l})">${l}</div>`).join('')}
        </div>
      </div>`}
    </div>

    <div class="card">
      <div class="card-title">Programmazione accensione</div>
      <div id="heater-sched"></div>
    </div>

    <div class="card">
      <div class="card-title">Info</div>
      <div class="settings-row"><label>Tensione batteria</label><span style="color:var(--amber)">${hs.voltage} V</span></div>
      <div class="settings-row"><label>Modalità attiva</label><span>${modeLabel}</span></div>
      ${errLabel ? `<div class="settings-row"><label>Errore</label><span style="color:var(--red)">${errLabel}</span></div>` : ''}
      <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="window.heater.disconnect();renderHeater()">Disconnetti</button>
    </div>
  `;
  renderHeaterSched();
}

// ── BMS screen ────────────────────────────────────────────────────────────────
function renderBMS() {
  const bs = state.bms;
  if (!bs.connected) {
    el('bms-body').innerHTML = `<div class="connect-placeholder"><div class="icon">🔋</div><p>Connetti il BMS XiaoXiang via Bluetooth</p><button class="btn btn-primary btn-full" onclick="connectBMS()">Connetti</button></div>`;
    return;
  }
  const socN = parseInt(bs.soc) || 0;
  const socColor = socN >= 50 ? '#4ADE80' : socN >= 20 ? '#F59E0B' : '#F87171';
  const cs   = chargeStatus(bs.current);
  const eta  = calcETA(bs.current, bs.remaining, bs.capacity);
  const bmsW = battWatts(bs.voltage, bs.current);

  // SVG semicircle gauge
  const r = 70, cx = 90, cy = 95, sw = 14;
  const angle = (socN / 100) * 180;
  const arcX  = cx + r * Math.cos(Math.PI - angle * Math.PI / 180);
  const arcY  = cy - r * Math.sin(angle * Math.PI / 180);
  const la    = angle > 180 ? 1 : 0;

  // Protection flags
  const protFlags = [
    [0, 'Sovratensione cella'], [1, 'Sottotensione cella'],
    [2, 'Sovratensione pacco'], [3, 'Sottotensione pacco'],
    [4, 'Temp carica alta'],    [5, 'Temp carica bassa'],
    [6, 'Temp scarica alta'],   [7, 'Temp scarica bassa'],
    [8, 'Sovracorrente carica'],[9, 'Sovracorrente scarica'],
    [10, 'Cortocircuito'],      [11, 'Errore MOSFET'],
  ].filter(([bit]) => bs.protect & (1 << bit)).map(([, name]) => name);

  // Cell stats
  let cellStatsHtml = '';
  if (bs.cells.length) {
    const vCells = bs.cells.map(v => parseFloat(v));
    const vMin   = Math.min(...vCells).toFixed(3);
    const vMax   = Math.max(...vCells).toFixed(3);
    const vDelta = (Math.max(...vCells) - Math.min(...vCells)).toFixed(3);
    const deltaColor = parseFloat(vDelta) > 0.050 ? 'var(--red)' : parseFloat(vDelta) > 0.020 ? 'var(--amber)' : 'var(--green)';
    cellStatsHtml = `
    <div class="grid-2" style="margin-bottom:10px">
      ${statCard('Cella min', 'var(--blue)', vMin, 'V')}
      ${statCard('Cella max', 'var(--green)', vMax, 'V')}
      ${statCard('Delta', deltaColor, vDelta, 'V')}
      ${statCard('N° celle', 'var(--text-2)', bs.cells.length, '')}
    </div>`;
  }

  // Temperature cards (all NTCs)
  const tempCards = bs.temps.map((t, i) => {
    const tN = parseFloat(t);
    const tC = tN > 40 ? 'var(--red)' : tN > 30 ? 'var(--amber)' : 'var(--green)';
    return statCard(`NTC ${i + 1}`, tC, t, '°C');
  }).join('');

  el('bms-body').innerHTML = `
    <div class="card" style="text-align:center">
      <div class="card-title">Stato di carica</div>
      <svg viewBox="0 0 180 110" style="width:200px;height:120px">
        <path d="M ${cx-r},${cy} A ${r},${r} 0 0 1 ${cx+r},${cy}" fill="none" stroke="var(--surface2)" stroke-width="${sw}" stroke-linecap="round"/>
        ${socN > 0 ? `<path d="M ${cx-r},${cy} A ${r},${r} 0 ${la} 1 ${arcX},${arcY}" fill="none" stroke="${socColor}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
        <text x="${cx}" y="${cy-10}" text-anchor="middle" class="gauge-text" style="fill:${socColor}">${bs.soc}%</text>
        <text x="${cx}" y="${cy+12}" text-anchor="middle" class="gauge-sub">SOC</text>
      </svg>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px">
        ${badge(cs.badge, cs.label)}
        ${eta !== null ? `<span class="badge badge-grey">⏱ ${eta}</span>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Storico SOC</div>
      <div id="chart-soc-mount"></div>
    </div>

    <div class="card">
      <div class="card-title">Potenza batteria</div>
      <div id="chart-bms-power-mount"></div>
    </div>

    <div class="grid-2">
      ${statCard('Tensione', 'var(--blue)', bs.voltage, 'V')}
      ${statCard('Corrente', cs.badge === 'green' ? 'var(--green)' : cs.badge === 'amber' ? 'var(--amber)' : 'var(--text-2)', bs.current, 'A')}
      ${bmsW !== null ? statCard('Potenza', bmsW > 0 ? 'var(--green)' : 'var(--amber)', (bmsW > 0 ? '+' : '') + bmsW.toFixed(0), 'W') : ''}
      ${statCard('Capacità res.', socColor, bs.remaining, 'Ah')}
      ${statCard('Capacità nom.', 'var(--text-2)', bs.capacity, 'Ah')}
      ${statCard('Cicli', 'var(--text)', bs.cycles, '')}
    </div>

    <div class="card">
      <div class="card-title">Stato MOSFET</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${badge(bs.fetCharge    ? 'green' : 'red', bs.fetCharge    ? 'CHG ON' : 'CHG OFF')}
        ${badge(bs.fetDischarge ? 'green' : 'red', bs.fetDischarge ? 'DSG ON' : 'DSG OFF')}
      </div>
    </div>

    ${bs.temps.length > 0 ? `
    <div class="card">
      <div class="card-title">Temperature NTC</div>
      <div class="grid-2" style="margin:0">${tempCards}</div>
    </div>` : ''}

    ${bs.cells.length ? `
    <div class="card">
      <div class="card-title">Tensioni celle</div>
      ${cellStatsHtml}
      <div class="cell-grid">
        ${bs.cells.map((v, i) => {
          const vn  = parseFloat(v);
          // LiFePO4 range: 2.50–3.65 V (non Li-Ion 2.8–4.2 V)
          const pct = Math.min(100, Math.max(0, ((vn - 2.5) / (3.65 - 2.5)) * 100)).toFixed(0);
          const cls = vn < 2.8 ? 'danger' : vn < 3.1 ? 'warn' : '';
          const isBalancing = (bs.balance >> i) & 1;
          return `<div class="cell-item">
            <div class="cell-label">C${i+1}${isBalancing ? ' ⚖' : ''}</div>
            <div class="cell-v" style="color:${cls==='danger'?'var(--red)':cls==='warn'?'var(--amber)':'var(--green)'}">${v}V</div>
            <div class="cell-bar"><div class="cell-bar-fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${protFlags.length ? `<div class="alert alert-err">⚠️ ${protFlags.join(' · ')}</div>` : ''}
    <button class="btn btn-ghost btn-full" onclick="window.bms.disconnect();renderBMS()">Disconnetti</button>
  `;
  chartSOC.mount('#chart-soc-mount');
  chartBMSPower.mount('#chart-bms-power-mount');
}

// ── Victron screen ────────────────────────────────────────────────────────────
function renderVictron() {
  const mpptCard = (m, idx) => {
    const keyId = `victron_key_${idx}`;
    return `
    <div class="card">
      <div class="card-row" style="margin-bottom:10px">
        <span class="card-title" style="margin:0">${m.label}</span>
        ${badge(m.connected ? 'green' : 'grey', m.connected ? 'BLE' : 'Off')}
      </div>
      ${m.connected ? `
      <div class="grid-2" style="margin-bottom:10px">
        ${statCard('Potenza PV', 'var(--amber)', m.pvW, 'W')}
        ${statCard('Tensione PV', 'var(--blue)', m.pvV, 'V')}
        ${statCard('Batt. V', 'var(--green)', m.battV, 'V')}
        ${statCard('Batt. A', 'var(--text)', m.battA, 'A')}
      </div>
      <div class="divider"></div>
      <div class="card-row"><span style="font-size:12px;color:var(--text-2)">Stato</span><span style="font-size:12px">${m.cs}</span></div>
      <div class="card-row"><span style="font-size:12px;color:var(--text-2)">Errore</span><span style="font-size:12px">${m.error}</span></div>
      <div class="card-row"><span style="font-size:12px;color:var(--text-2)">Resa oggi</span><span style="font-size:12px;color:var(--amber)">${m.yieldToday} kWh</span></div>
      <div class="card-row"><span style="font-size:12px;color:var(--text-2)">Resa ieri</span><span style="font-size:12px;color:var(--text)">${m.yieldYesterday} kWh</span></div>
      <div class="card-row"><span style="font-size:12px;color:var(--text-2)">Max potenza oggi</span><span style="font-size:12px;color:var(--text)">${m.maxPowerToday} W</span></div>
      <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="(${idx===1?'window.mppt1':'window.mppt2'}).disconnect();renderVictron()">Disconnetti</button>
      ` : `
      <button class="btn btn-primary btn-full" onclick="connectMPPT(${idx})">Connetti</button>
      `}
      <div class="divider"></div>
      <div class="settings-row">
        <label>Chiave cifratura</label>
        <input type="password" id="${keyId}" placeholder="32 char hex" style="max-width:160px"
          value="${localStorage.getItem(keyId) ?? ''}"
          onchange="saveVictronKey(${idx},this.value)">
      </div>
    </div>`;
  };

  el('victron-body').innerHTML = `
    <div class="alert alert-warn">ℹ️ Chiave: VictronConnect → dispositivo → ⋮ → <strong>Show encryption data</strong></div>
    <div class="alert alert-warn" style="font-size:11px">Su Android potrebbe servire abilitare <strong>chrome://flags/#enable-experimental-web-platform-features</strong></div>
    ${(state.mppt1.connected || state.mppt2.connected) ? `
    <div class="card">
      <div class="card-title">Potenza solare totale</div>
      <div id="chart-pv-power-mount"></div>
    </div>` : ''}
    ${mpptCard(state.mppt1, 1)}
    ${mpptCard(state.mppt2, 2)}
  `;
  if (state.mppt1.connected || state.mppt2.connected) {
    chartPVPower.mount('#chart-pv-power-mount');
  }
}

// ── Imou screen ───────────────────────────────────────────────────────────────
function renderImou() {
  const ic = state.imou;
  if (!imou.hasCredentials()) {
    el('imou-body').innerHTML = `
      <div class="card">
        <div class="card-title">Configurazione Imou</div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.6">
          Registrati su <strong style="color:var(--amber)">open.imoulife.com</strong>, crea un'app e incolla le credenziali qui sotto.
        </p>
        <div class="settings-row"><label>App ID</label><input type="text" id="imou-id" placeholder="appId"></div>
        <div class="settings-row"><label>App Secret</label><input type="password" id="imou-secret" placeholder="appSecret"></div>
        <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="saveImouCreds()">Salva e connetti</button>
      </div>`;
    return;
  }
  el('imou-body').innerHTML = ic.connected
    ? `
      ${ic.devices.length === 0 ? '<div class="connect-placeholder"><div class="icon">📷</div><p>Nessuna camera trovata</p></div>' : ''}
      <div class="cam-grid">
        ${ic.devices.map(d => `
          <div class="cam-card" onclick="loadImouSnap('${d.id}',this)">
            <div class="cam-offline">📷</div>
            <div class="cam-name">${d.name}</div>
          </div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-full" style="margin-top:12px" onclick="imou.connect()">🔄 Aggiorna</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="clearImouCreds()">Cambia credenziali</button>`
    : `
      <div class="connect-placeholder">
        ${ic.error ? `<div class="alert alert-err" style="width:100%">❌ ${ic.error}</div>` : ''}
        <div class="icon">📷</div><p>Non connesso</p>
      </div>
      <button class="btn btn-primary btn-full" onclick="imou.connect()">Connetti</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="clearImouCreds()">Cambia credenziali</button>`;
}

// ── Settings screen ───────────────────────────────────────────────────────────
function renderSettings() {
  const saved = (key) => localStorage.getItem(key) ? '✅ memorizzato' : '—';
  el('settings-body').innerHTML = `
    <div class="card">
      <div class="card-title">Generale</div>
      <div class="settings-row"><label>Versione app</label><span style="color:var(--text-2)">1.1.0</span></div>
      <div class="settings-row"><label>Aggiornamento</label><button class="btn btn-ghost" onclick="checkUpdate()">🔄 Verifica</button></div>
    </div>
    <div class="card">
      <div class="card-title">Dispositivi salvati</div>
      <div style="font-size:12px;color:var(--text-2);line-height:2">
        BMS: ${saved('ble_bms_id')}<br>
        Riscaldatore: ${saved('ble_heater_id')}<br>
        MPPT 1: ${saved('ble_mppt1_id')}<br>
        MPPT 2: ${saved('ble_mppt2_id')}
      </div>
      <button class="btn btn-danger btn-full" style="margin-top:10px" onclick="clearSavedDevices()">🗑 Dimentica tutti i dispositivi</button>
    </div>
    <div class="card">
      <div class="card-title">Reset connessioni</div>
      <button class="btn btn-danger btn-full" onclick="disconnectAll()">Disconnetti tutto</button>
    </div>`;
}

// ── Auto-reconnect on startup ─────────────────────────────────────────────────
async function autoReconnect() {
  if (!navigator.bluetooth?.getDevices) return;
  let devices;
  try { devices = await navigator.bluetooth.getDevices(); }
  catch (e) { console.warn('getDevices not available:', e); return; }
  if (!devices.length) return;

  const bmsId    = localStorage.getItem('ble_bms_id');
  const heaterId = localStorage.getItem('ble_heater_id');
  const mppt1Id  = localStorage.getItem('ble_mppt1_id');
  const mppt2Id  = localStorage.getItem('ble_mppt2_id');

  let any = false;
  for (const device of devices) {
    if (device.id === bmsId)    { any = true; setDotConnecting('dot-bms');    bms.reconnect(device); }
    if (device.id === heaterId) { any = true; setDotConnecting('dot-heater'); heater.reconnect(device); }
    if (device.id === mppt1Id)  { any = true; setDotConnecting('dot-mppt1'); mppt1.reconnect(device); }
    if (device.id === mppt2Id)  { any = true; setDotConnecting('dot-mppt2'); mppt2.reconnect(device); }
  }
  if (any) toast('🔄 Riconnessione automatica…');
}

// ── Global actions ────────────────────────────────────────────────────────────
window.connectHeater = async () => {
  setDotConnecting('dot-heater');
  const ok = await heater.connect();
  if (!ok) updateDots();
};
window.connectBMS = async () => {
  setDotConnecting('dot-bms');
  const ok = await bms.connect();
  if (!ok) updateDots();
};
window.connectMPPT = async (i) => {
  setDotConnecting(i === 1 ? 'dot-mppt1' : 'dot-mppt2');
  const ok = await (i === 1 ? mppt1 : mppt2).connect();
  if (!ok) updateDots();
};

window.toggleHeater = async () => {
  const on = state.heater.state === 1 || state.heater.state === 2;
  on ? await heater.turnOff() : await heater.turnOn();
};
window.setHeaterTemp  = (t) => heater.setTemp(t);
window.setHeaterLevel = (l) => {
  heater.setLevel(l);
  document.querySelectorAll('.level-pill').forEach((p, i) => p.classList.toggle('active', i + 1 === l));
};
window.setHeaterMode = (m) => heater.setMode(m);

window.saveVictronKey = (idx, val) => {
  localStorage.setItem(`victron_key_${idx}`, val);
  (idx === 1 ? mppt1 : mppt2).setKey(val);
  toast('Chiave salvata');
};

window.saveImouCreds = () => {
  const id     = el('imou-id')?.value?.trim();
  const secret = el('imou-secret')?.value?.trim();
  if (!id || !secret) { toast('Inserisci App ID e Secret'); return; }
  imou.saveCredentials(id, secret);
  imou.connect();
};
window.clearImouCreds = () => {
  localStorage.removeItem('imou_app_id');
  localStorage.removeItem('imou_app_secret');
  imou.appId = ''; imou.appSecret = '';
  renderImou();
};
window.loadImouSnap = async (deviceId, card) => {
  const url = await imou.getSnapshot(deviceId);
  if (url) { const img = document.createElement('img'); img.src = url; card.prepend(img); }
};

window.disconnectAll = () => {
  heater.disconnect(); bms.disconnect();
  mppt1.disconnect();  mppt2.disconnect();
  toast('Disconnesso');
};
window.clearSavedDevices = () => {
  ['ble_bms_id', 'ble_heater_id', 'ble_mppt1_id', 'ble_mppt2_id'].forEach(k => localStorage.removeItem(k));
  toast('Dispositivi dimenticati');
  renderSettings();
};
window.checkUpdate = () => { location.reload(true); };

// Expose instances globally for inline onclick
window.heater = heater;
window.bms    = bms;
window.mppt1  = mppt1;
window.mppt2  = mppt2;

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
window.toast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
};

// ── Init ──────────────────────────────────────────────────────────────────────
renderDash();
renderHeater();
renderBMS();
renderVictron();
renderImou();
renderSettings();
updateDots();

if (imou.hasCredentials()) imou.connect();
schedApply();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

autoReconnect();
