'use strict';

// ── Maintenance reminders ─────────────────────────────────────────────────────

const STORE_KEY = 'caribu_maint_v1';

const DEFAULT_ITEMS = [
  { id: 'tagliando',    emoji: '🔧', name: 'Tagliando',           intervalDays: 365  },
  { id: 'gas',          emoji: '🔥', name: 'Bombola gas',          intervalDays: 90   },
  { id: 'filtro-acqua', emoji: '💧', name: 'Filtro acqua',         intervalDays: 180  },
  { id: 'pneumatici',   emoji: '🛞', name: 'Pneumatici',           intervalDays: 730  },
  { id: 'batt-avv',     emoji: '⚡', name: 'Batteria avviamento',  intervalDays: 1095 },
  { id: 'freni',        emoji: '🛑', name: 'Freni',                intervalDays: 365  },
];

function _load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}

function _save(obj) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); }
  catch (e) { console.warn('maintenance.js: save failed', e); }
}

export function getItems() {
  const saved = _load();
  return DEFAULT_ITEMS.map(d => ({ ...d, ...(saved[d.id] || {}) }));
}

export function markDone(id) {
  const saved = _load();
  saved[id] = { ...saved[id], lastDone: new Date().toISOString() };
  _save(saved);
}

export function checkMaintenanceAlerts(notifyFn) {
  const now = Date.now();
  for (const item of getItems()) {
    if (!item.lastDone) continue;
    const dueMs = new Date(item.lastDone).getTime() + item.intervalDays * 86400000;
    if (now >= dueMs) {
      notifyFn(`🔧 ${item.name}`, `Scaduto il ${new Date(dueMs).toLocaleDateString('it-IT')}`);
    }
  }
}

export function renderMaintenance(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const now = Date.now();

  container.innerHTML = getItems().map(item => {
    const lastDate = item.lastDone ? new Date(item.lastDone) : null;
    const dueMs    = lastDate ? lastDate.getTime() + item.intervalDays * 86400000 : null;
    const daysLeft = dueMs !== null ? Math.ceil((dueMs - now) / 86400000) : null;
    const overdue  = daysLeft !== null && daysLeft < 0;
    const soon     = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
    const color    = overdue ? 'var(--red)' : soon ? 'var(--amber)' : daysLeft !== null ? 'var(--green)' : 'var(--text-2)';
    const label    = daysLeft === null ? '—' : overdue ? `${Math.abs(daysLeft)}gg fa` : daysLeft === 0 ? 'Oggi!' : `${daysLeft}gg`;

    return `
    <div class="maint-item${overdue ? ' maint-overdue' : soon ? ' maint-soon' : ''}">
      <div class="maint-left">
        <span class="maint-emoji">${item.emoji}</span>
        <div>
          <div class="maint-name">${item.name}</div>
          <div class="maint-sub">${lastDate ? `Fatto: ${lastDate.toLocaleDateString('it-IT')}` : 'Mai eseguito'} · ogni ${item.intervalDays}gg</div>
        </div>
      </div>
      <div class="maint-right">
        <div style="font-size:13px;font-weight:700;color:${color}">${label}</div>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;margin-top:5px" onclick="window.maintMarkDone('${item.id}')">✓ Fatto</button>
      </div>
    </div>`;
  }).join('');
}
