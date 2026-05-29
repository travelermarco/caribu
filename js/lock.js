'use strict';

const PIN_KEY = 'caribu_pin_hash';
const BIO_KEY = 'caribu_bio_cred';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const isPinSet = () => !!localStorage.getItem(PIN_KEY);
export const isBioSet = () => !!localStorage.getItem(BIO_KEY);

export async function setPin(pin) {
  localStorage.setItem(PIN_KEY, await sha256(pin));
}

export function clearLock() {
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(BIO_KEY);
}

export async function verifyPin(pin) {
  const stored = localStorage.getItem(PIN_KEY);
  if (!stored) return true;
  return (await sha256(pin)) === stored;
}

export async function registerBiometric() {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Caribù' },
        user: { id: new TextEncoder().encode('caribu-user'), name: 'caribu', displayName: 'Caribù' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
      }
    });
    localStorage.setItem(BIO_KEY, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))));
    return true;
  } catch { return false; }
}

export async function verifyBiometric() {
  const stored = localStorage.getItem(BIO_KEY);
  if (!stored) return false;
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: Uint8Array.from(atob(stored), c => c.charCodeAt(0)), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      }
    });
    return true;
  } catch { return false; }
}

// ── Shared PIN pad overlay ─────────────────────────────────────────────────────
function _makePad(logo, title, onFourDigits, hasBio) {
  const overlay = document.createElement('div');
  overlay.className = 'lock-overlay';

  let pin = '';

  function updateDots() {
    for (let i = 0; i < 4; i++) {
      const d = overlay.querySelector(`#ld${i}`);
      if (d) d.classList.toggle('filled', i < pin.length);
    }
  }

  function shake(msg) {
    pin = '';
    updateDots();
    overlay.querySelectorAll('.lock-dot').forEach(d => {
      d.classList.add('error');
      setTimeout(() => d.classList.remove('error'), 500);
    });
    const err = overlay.querySelector('#lock-err');
    if (err) { err.textContent = msg; setTimeout(() => { err.textContent = ''; }, 1500); }
  }

  overlay.innerHTML = `
    <div class="lock-box">
      <div class="lock-logo">${logo}</div>
      <div class="lock-title">${title}</div>
      <div class="lock-dots">
        ${[0,1,2,3].map(i => `<span class="lock-dot" id="ld${i}"></span>`).join('')}
      </div>
      <div class="lock-err" id="lock-err"></div>
      <div class="lock-pad">
        ${[1,2,3,4,5,6,7,8,9,'','0','⌫'].map(k =>
          k === '' ? '<div></div>' :
          `<button class="pad-key${k === '⌫' ? ' pad-del' : ''}" data-k="${k}">${k}</button>`
        ).join('')}
      </div>
      ${hasBio ? `<button class="btn btn-ghost lock-bio-btn" style="margin-top:18px;width:220px">🫆 Impronta / Face ID</button>` : ''}
    </div>`;

  overlay.querySelectorAll('.pad-key').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.k;
      if (key === '⌫') { pin = pin.slice(0, -1); updateDots(); return; }
      if (pin.length >= 4) return;
      pin += key;
      updateDots();
      if (pin.length === 4) {
        const result = await onFourDigits(pin, shake);
        if (result === true) overlay.remove();
        else { pin = ''; updateDots(); }
      }
    });
  });

  return { overlay, shake };
}

// ── Lock screen ────────────────────────────────────────────────────────────────
export function showLockScreen(onUnlock) {
  const { overlay } = _makePad('🔒', 'Caribù', async (pin, shake) => {
    const ok = await verifyPin(pin);
    if (ok) { onUnlock(); return true; }
    shake('PIN errato');
  }, isBioSet());

  async function tryBio() {
    const ok = await verifyBiometric();
    if (ok) { overlay.remove(); onUnlock(); }
    else {
      const err = overlay.querySelector('#lock-err');
      if (err) { err.textContent = 'Autenticazione fallita'; setTimeout(() => { err.textContent = ''; }, 1500); }
    }
  }

  const bioBtn = overlay.querySelector('.lock-bio-btn');
  if (bioBtn) bioBtn.addEventListener('click', tryBio);

  document.body.appendChild(overlay);

  if (isBioSet()) setTimeout(tryBio, 300);
}

// ── PIN setup ──────────────────────────────────────────────────────────────────
export function showPinSetup(onDone) {
  let firstPin = null;

  let overlay;

  function build() {
    if (overlay) overlay.remove();
    const isConfirm = firstPin !== null;
    const result = _makePad('🔏', isConfirm ? 'Conferma PIN' : 'Nuovo PIN', async (pin, shake) => {
      if (!isConfirm) {
        firstPin = pin;
        build();
        return true; // overlay removed by _makePad, build() adds a new one
      }
      if (pin !== firstPin) {
        firstPin = null;
        shake('PIN diverso — riprova');
        setTimeout(() => build(), 800);
        return; // don't return true (don't remove)
      }
      await setPin(pin);
      onDone(true);
      return true;
    }, false);

    overlay = result.overlay;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.style.cssText = 'margin-top:14px;width:220px';
    cancelBtn.textContent = 'Annulla';
    cancelBtn.addEventListener('click', () => { overlay.remove(); onDone(false); });
    overlay.querySelector('.lock-box').appendChild(cancelBtn);

    document.body.appendChild(overlay);
  }

  build();
}

// ── Security settings section ──────────────────────────────────────────────────
export function renderSecuritySettings(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const pinSet  = isPinSet();
  const bioSet  = isBioSet();
  const bioAvail = !!(window.PublicKeyCredential);

  el.innerHTML = `
    <div class="settings-row">
      <label>Blocco PIN</label>
      <div style="display:flex;gap:8px">
        ${pinSet
          ? `<button class="btn btn-ghost" style="padding:8px 12px;font-size:13px" onclick="window.secChangePIN()">Cambia</button>
             <button class="btn btn-danger" style="padding:8px 12px;font-size:13px" onclick="window.secRemovePIN()">Disattiva</button>`
          : `<button class="btn btn-primary" style="padding:8px 14px;font-size:13px" onclick="window.secSetPIN()">Imposta PIN</button>`}
      </div>
    </div>
    ${pinSet && bioAvail ? `
    <div class="settings-row">
      <label>Biometria</label>
      ${bioSet
        ? `<div style="display:flex;gap:8px;align-items:center">
             <span style="font-size:12px;color:var(--green);font-weight:600">✓ Attiva</span>
             <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" onclick="window.secRemoveBIO()">Rimuovi</button>
           </div>`
        : `<button class="btn btn-ghost" onclick="window.secEnableBIO()">🫆 Attiva impronta</button>`}
    </div>` : ''}
    <div style="font-size:11px;color:var(--text-2);padding:6px 0 2px">
      ${pinSet ? '🔒 App protetta. Il PIN viene richiesto ad ogni avvio.' : 'Imposta un PIN per bloccare l\'accesso all\'app.'}
    </div>
  `;
}

// ── Init ───────────────────────────────────────────────────────────────────────
export function initLock(onUnlock) {
  if (!isPinSet()) { onUnlock(); return; }
  showLockScreen(onUnlock);
}
