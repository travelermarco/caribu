'use strict';

const DB_NAME = 'caribu-docs';
const STORE   = 'docs';

const CATS = [
  { id: 'patente',       icon: '🪪',  label: 'Patente' },
  { id: 'libretto',      icon: '📘',  label: 'Libretto' },
  { id: 'assicurazione', icon: '🛡️', label: 'Assicurazione' },
  { id: 'bollo',         icon: '💳',  label: 'Bollo' },
  { id: 'revisione',     icon: '🔍',  label: 'Revisione' },
  { id: 'altro',         icon: '📎',  label: 'Altro' },
];

function catOf(id) { return CATS.find(c => c.id === id) || { icon: '📄', label: id }; }

function _db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function addDocument(doc) {
  const db = await _db();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(doc);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

export async function getDocuments() {
  const db = await _db();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

export async function deleteDocument(id) {
  const db = await _db();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

export async function renderDocuments(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  let docs;
  try { docs = await getDocuments(); }
  catch { docs = []; }

  const sorted = [...docs].sort((a, b) => b.ts - a.ts);

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <span style="font-size:12px;color:var(--text-2)">${docs.length} document${docs.length !== 1 ? 'i' : 'o'}</span>
      <label class="btn btn-primary" style="cursor:pointer;padding:8px 16px;font-size:13px">
        ＋ Aggiungi
        <input type="file" accept=".pdf,image/*" style="display:none" onchange="window._docPick(this)">
      </label>
    </div>

    ${sorted.length === 0 ? `
      <div class="connect-placeholder" style="padding:40px 0">
        <div class="icon" style="font-size:48px;opacity:.3">📂</div>
        <p style="color:var(--text-2);font-size:13px;text-align:center;max-width:200px">
          Nessun documento.<br>Aggiungi libretto, assicurazione, patente…
        </p>
      </div>` : `
      <div class="doc-list">
        ${sorted.map(d => {
          const cat  = catOf(d.category);
          const date = new Date(d.ts).toLocaleDateString('it-IT');
          return `
          <div class="doc-item">
            <div class="doc-icon">${cat.icon}</div>
            <div class="doc-info">
              <div class="doc-name">${_esc(d.name)}</div>
              <div class="doc-meta">${cat.label} · ${date}</div>
            </div>
            <div class="doc-actions">
              <button class="btn btn-ghost" style="padding:6px 10px" onclick="window._docView('${d.id}')">👁</button>
              <button class="btn btn-ghost" style="padding:6px 10px;color:var(--red)" onclick="window._docDel('${d.id}')">🗑</button>
            </div>
          </div>`;
        }).join('')}
      </div>`}

    <!-- Category picker bottom sheet -->
    <div id="doc-cat-picker" class="doc-modal" style="display:none"
         onclick="if(event.target===this)this.style.display='none'">
      <div class="doc-modal-box">
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;text-align:center">Tipo di documento</div>
        <div class="doc-cat-grid">
          ${CATS.map(c =>
            `<button class="doc-cat-btn" onclick="window._docCat('${c.id}')">
               ${c.icon}
               <span>${c.label}</span>
             </button>`
          ).join('')}
        </div>
        <button class="btn btn-ghost btn-full" style="margin-top:14px"
                onclick="document.getElementById('doc-cat-picker').style.display='none'">Annulla</button>
      </div>
    </div>
  `;
}

function _esc(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
