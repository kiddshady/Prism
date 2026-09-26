'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: contraseñas
   Corre en el documento principal de cada página, en el mundo aislado del
   preload: la página no ve este código ni `ipcRenderer`, aunque comparten el
   DOM. Hace dos cosas:

   · Completar. Al enfocar un campo de login, si Prism tiene contraseñas para
     ESTE sitio, cuelga una lista debajo del campo. Elegir una completa usuario
     y contraseña. La contraseña recién viaja cuando se elige (y el proceso
     principal vuelve a chequear el sitio: acá no se decide nada).
     La lista vive en un shadow root cerrado, así los estilos de la página no
     la deforman y sus scripts no la leen.

   · Ofrecer guardar. Un envío (submit, Enter, un clic en un botón) anota lo
     que había en los campos; se ofrece guardar recién cuando la página se va
     o el campo de contraseña desaparece. Así un clic en "mostrar contraseña"
     no pregunta nada, y un login fallido (que deja el campo ahí) tampoco.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcRenderer } = require('electron');

if (window.top === window) {
  /* ── Los campos ──────────────────────────────────────────────────────── */

  const TEXTY = new Set(['text', 'email', 'tel']);
  const USERISH = /user|e-?mail|login|correo|usuario|identifier|account|cuenta|dni|cuit|documento/i;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  const isInput = (el) => el instanceof HTMLInputElement;
  function visible(el) {
    if (!el?.isConnected || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }
  const isPw = (el) => isInput(el) && el.type === 'password' && visible(el);
  const isTexty = (el) => isInput(el) && TEXTY.has(el.type) && !el.readOnly && visible(el);
  function isUserish(el) {
    if (!isTexty(el)) return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.includes('username') || ac === 'email' || el.type === 'email') return true;
    return USERISH.test(`${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`);
  }
  const pwFields = () => [...document.querySelectorAll('input[type=password]')].filter(isPw);
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  /** El campo de usuario de una contraseña: el último de texto antes de ella, en su formulario. */
  function userFieldFor(pw) {
    const scope = pw.form || document;
    const cands = [...scope.querySelectorAll('input')].filter((el) => isTexty(el) && before(el, pw));
    return cands.filter(isUserish).pop() || cands.pop() || null;
  }

  /** Usuario y contraseña alrededor de un campo de login (cualquiera puede faltar). */
  function around(el) {
    if (isPw(el)) return { user: userFieldFor(el), pw: el };
    const pw = pwFields().find((p) => before(el, p) && (!el.form || p.form === el.form)) || null;
    return { user: el, pw };
  }

  /** Si un campo es de login: una contraseña, su usuario, o el correo solo del primer paso. */
  function isLoginField(el) {
    if (isPw(el)) return true;
    if (!isTexty(el)) return false;
    const pws = pwFields();
    if (pws.length) return pws.some((p) => userFieldFor(p) === el);
    return isUserish(el);
  }

  function setValue(el, v) {
    if (!el || v == null) return;
    // El setter del prototipo, no `el.value =`: si la página es React, su
    // rastreador de valor tiene que ver la diferencia y disparar onChange.
    valueSetter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ── La lista ────────────────────────────────────────────────────────── */

  const KEY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(-45 8 8)"><path d="M8.31 6.6H1.9V9.4H3.2V11H5.8V9.4H8.31A3.3 3.3 0 1 0 8.31 6.6Z"/><circle cx="12.3" cy="8" r="1" fill="currentColor" stroke="none"/></g></svg>';
  const CSS = `
    :host { all: initial; }
    .box {
      position: fixed; z-index: 2147483647; box-sizing: border-box;
      min-width: 240px; max-width: 380px; padding: 4px;
      border-radius: 10px; background: rgb(22 22 24);
      box-shadow: inset 0 0 0 1px rgb(255 255 255 / .08), 0 14px 36px rgb(0 0 0 / .5), 0 2px 6px rgb(0 0 0 / .3);
      font: 13px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #ececec;
      opacity: 0; transform: translateY(-4px) scale(.985); transform-origin: top left;
      transition: opacity .14s cubic-bezier(.2,.7,.2,1), transform .16s cubic-bezier(.2,.7,.2,1);
      user-select: none; -webkit-user-select: none;
    }
    .box.is-up { transform-origin: bottom left; transform: translateY(4px) scale(.985); }
    .box.is-on { opacity: 1; transform: none; }
    .row {
      display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 10px;
      border-radius: 7px; cursor: default;
      transition: background-color .12s ease;
    }
    .row.is-active { background: rgb(255 255 255 / .075); }
    .tile {
      display: grid; place-items: center; width: 26px; height: 26px; flex: none;
      border-radius: 7px; background: rgb(255 255 255 / .06); color: #b8b8b8;
    }
    .tile svg { width: 14px; height: 14px; }
    .text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .title, .login { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title { font-weight: 500; }
    .login { font-size: 12px; color: #9a9a9a; }
    .foot { padding: 6px 10px 4px; font-size: 11px; color: #707070; }
  `;

  let host = null; let root = null; let box = null;
  let anchor = null; let items = []; let active = -1; let openSeq = 0; let rafId = 0;

  function ensureBox() {
    if (host) return;
    host = document.createElement('div');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="box" role="listbox"></div>`;
    box = root.querySelector('.box');
    // Que tocar la lista no le saque el foco al campo.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('pointermove', (e) => {
      const row = e.target.closest?.('.row');
      if (row) setActive(Number(row.dataset.i));
    });
    box.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      const row = e.target.closest?.('.row');
      if (row) choose(Number(row.dataset.i));
    });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function place() {
    if (!anchor || !box) return;
    if (!anchor.isConnected || !visible(anchor)) { close(); return; }
    const r = anchor.getBoundingClientRect();
    const w = Math.min(380, Math.max(240, r.width));
    const h = box.offsetHeight;
    const up = r.bottom + 4 + h > innerHeight && r.top - 4 - h > 0;
    box.classList.toggle('is-up', up);
    box.style.width = `${Math.round(w)}px`;
    box.style.left = `${Math.round(Math.min(Math.max(4, r.left), innerWidth - w - 4))}px`;
    box.style.top = `${Math.round(up ? r.top - 4 - h : r.bottom + 4)}px`;
  }
  const schedule = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(place); };

  function setActive(i) {
    active = i;
    box.querySelectorAll('.row').forEach((row, n) => row.classList.toggle('is-active', n === i));
  }

  async function open(el) {
    const seq = ++openSeq;
    const found = await ipcRenderer.invoke('pass:page-query').catch(() => []);
    if (seq !== openSeq || document.activeElement !== el || !found.length) return;
    ensureBox();
    anchor = el;
    items = found;
    active = -1;
    box.innerHTML = found.map((it, i) => `
      <div class="row" role="option" data-i="${i}">
        <div class="tile">${KEY}</div>
        <div class="text"><div class="title">${esc(it.title)}</div><div class="login">${esc(it.login || 'Sin usuario')}</div></div>
      </div>`).join('') + '<div class="foot">Contraseñas de Prism</div>';
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    box.classList.remove('is-on');
    place();
    requestAnimationFrame(() => box.classList.add('is-on'));
  }

  function close() {
    openSeq++;
    anchor = null;
    if (!box?.classList.contains('is-on')) { host?.remove(); return; }
    box.classList.remove('is-on');
    const b = box;
    setTimeout(() => { if (!b.classList.contains('is-on')) host?.remove(); }, 180);
  }

  /* Abierta apenas está armada, no cuando termina de entrar: una flecha que
     llega en el mismo frame en que aparece la lista no se tiene que perder. */
  const isOpen = () => !!anchor && !!host?.isConnected;

  async function choose(i) {
    const it = items[i];
    const el = anchor;
    if (!it || !el) return;
    close();
    const cred = await ipcRenderer.invoke('pass:page-fill', it.id).catch(() => null);
    if (!cred) return;
    const { user, pw } = around(el);
    if (user && cred.login) setValue(user, cred.login);
    if (pw && cred.password) setValue(pw, cred.password);
    el.focus();
  }

  /* ── Cuándo aparece ──────────────────────────────────────────────────── */

  document.addEventListener('focusin', (e) => {
    if (isLoginField(e.target)) open(e.target);
    else if (anchor) close();
  }, true);
  document.addEventListener('focusout', (e) => { if (e.target === anchor) close(); }, true);
  // Un clic en el campo que ya tenía el foco (y cuya lista se cerró) la vuelve a abrir.
  document.addEventListener('pointerdown', (e) => {
    if (e.isTrusted && e.target === document.activeElement && !isOpen() && isLoginField(e.target)) open(e.target);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!isOpen() || e.target !== anchor) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      choose(active);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      close();
    }
  }, true);
  addEventListener('scroll', () => { if (anchor) schedule(); }, true);
  addEventListener('resize', () => { if (anchor) schedule(); });

  /* ── Ofrecer guardar ─────────────────────────────────────────────────── */

  let pending = null;       // { login, password, pw }
  let watch = 0;
  let lastSent = '';

  function send() {
    clearInterval(watch);
    const p = pending;
    pending = null;
    if (!p) return;
    const key = `${p.login}\n${p.password}`;
    if (key === lastSent) return;
    lastSent = key;
    ipcRenderer.send('pass:page-capture', { login: p.login, password: p.password });
  }

  /** Anota lo que hay en los campos en el momento del envío. */
  function note(target) {
    const pws = pwFields().filter((p) => p.value);
    if (!pws.length) {
      // El primer paso de un login en dos pasos: solo el usuario.
      const scope = target?.form || target?.closest?.('form') || document;
      const u = [...scope.querySelectorAll('input')].find((el) => isUserish(el) && el.value.trim());
      if (u) ipcRenderer.send('pass:page-step', u.value.trim());
      return;
    }
    // En un cambio de contraseña (actual, nueva, repetir) la que vale es la última.
    const pw = pws[pws.length - 1];
    pending = { login: userFieldFor(pws[0])?.value.trim() || '', password: pw.value, pw };
    clearInterval(watch);
    const t0 = Date.now();
    // Una SPA no navega: se nota que entró porque el campo desaparece.
    watch = setInterval(() => {
      if (!pending) { clearInterval(watch); return; }
      if (!isPw(pending.pw)) send();
      else if (Date.now() - t0 > 10000) { clearInterval(watch); pending = null; }
    }, 400);
  }

  document.addEventListener('submit', (e) => {
    if (e.isTrusted || navigator.userActivation?.isActive) note(e.target);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && isInput(e.target)) note(e.target);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest?.('button, input[type=submit], input[type=image], [role=button]');
    if (b) note(b);
  }, true);
  addEventListener('pagehide', () => { if (pending) send(); close(); });
}
