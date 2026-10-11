'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — tus equipos
   Dos Prism de la misma casa (la UCX y la UCK1) emparejados: se mandan
   pestañas, cada uno ve las que el otro tiene abiertas, y los favoritos son
   los mismos en los dos (la mezcla está en bmsync.cjs).

   ── Los dos son iguales ────────────────────────────────────────────────────
   No hay servidor y cliente: cada Prism escucha y cada Prism marca. Así anda
   aunque el firewall de una sola de las dos no deje entrar, y si la laptop
   cambió de IP, la conexión la arma la que sí la sabe. Si quedaron dos
   conexiones (marcaron los dos a la vez), sobrevive la que marcó el equipo
   de id menor: los dos lados aplican la misma regla y se quedan con la misma.

   ── Emparejar ─────────────────────────────────────────────────────────────
   El mismo esquema que NTX: un equipo muestra un PIN de 6 dígitos en SU
   pantalla, por 2 minutos y con 5 intentos; el otro lo manda y los dos se
   quedan con una llave de 64 hex que sirve para siempre. Cada conexión
   presenta esa llave en los primeros 5 segundos o se corta.

   ── Encontrarse ───────────────────────────────────────────────────────────
   Por UDP en el mismo puerto: "¿quién está?" a la dirección de difusión de
   cada red, y cada Prism prendido contesta con su nombre. Sirve para elegir
   el equipo al emparejar sin tipear una IP, y para reencontrar uno que
   cambió de dirección. Tailscale no difunde: ahí se escribe la dirección.

   ── Seguridad ──────────────────────────────────────────────────────────────
   Escucha solo en loopback y en las IP privadas (LAN y Tailscale), nunca en
   0.0.0.0 ni en una pública, y no le contesta a nadie de afuera. Todo lo que
   llega se valida: viene de otra máquina. Una pestaña mandada NO se abre
   sola: queda avisada hasta que la abrís vos.
   ═══════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const bmsync = require('./bmsync.cjs');

const PROTOCOL = 1;
/** NTX usa el 8724, NTX Mobile el 8723 y Umbral el 4747. */
const PORT = 8731;
const PAIR_WINDOW_MS = 120_000;
const PAIR_ATTEMPTS = 5;
const HELLO_MS = 5000;
const DIAL_TIMEOUT = 4000;
/** Cada cuánto se vuelve a marcar a un equipo que no está. */
const DIAL_EVERY = 15_000;
/** Cada cuánto se lo busca en la red, por si cambió de dirección. */
const SEEK_EVERY = 60_000;
/** Las interfaces cambian: la wifi de una laptop llega tarde o se mueve de red. */
const RESCAN_EVERY = 20_000;
const TABS_DELAY = 1500;
const BOOKMARKS_DELAY = 400;
const MAX_TABS = 300;
const MAX_INBOX = 50;
const MAX_OUTBOX = 100;
/** Ids de mandadas ya recibidas: una que vuelve a llegar (se perdió el acuse) no se repite. */
const MAX_SEEN = 300;
const MAX_ADDRS = 6;

const CLOSE = {
  helloTimeout: 4001,
  unauthorized: 4003,
  protocol: 4005,
  pairRejected: 4006,
  stopped: 4007,
  duplicate: 4009,
  forgotten: 4010,
};

/* ── Direcciones ─────────────────────────────────────────────────────────── */

const bare = (a) => String(a || '').replace(/^::ffff:/i, '');

/** Loopback, los rangos privados de la LAN y el de Tailscale. Nada más. */
function isPrivate(address) {
  const parts = bare(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Las IPv4 privadas de esta máquina, con su máscara. */
function interfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && isPrivate(i.address)) out.push(i);
    }
  }
  return out;
}

/** La dirección de difusión de cada red (la de Tailscale no difunde: se saltea). */
function broadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const i of interfaces()) {
    if (i.address.startsWith('100.')) continue;
    const ip = i.address.split('.').map(Number);
    const mask = String(i.netmask).split('.').map(Number);
    if (mask.length === 4) out.add(ip.map((n, k) => (n | (~mask[k] & 255))).join('.'));
  }
  return [...out];
}

/** La red de casa primero; Tailscale (100.x) al final. */
const lanFirst = (list) => list.slice().sort((x, y) => (x.startsWith('100.') ? 1 : 0) - (y.startsWith('100.') ? 1 : 0));

/* ── Lo que llega se limpia ──────────────────────────────────────────────── */

const webUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\//i.test(u);
const text = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const icon = (f) => (typeof f === 'string' && f.length <= 1024 && /^https?:\/\//i.test(f) ? f : null);
const addrList = (list) => (Array.isArray(list) ? list.map(bare).filter((a) => isPrivate(a) && a !== '127.0.0.1') : []).slice(0, MAX_ADDRS);
const portOk = (p) => (Number.isInteger(p) && p > 0 && p < 65536 ? p : PORT);

function cleanTabs(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && webUrl(t.url)).slice(0, MAX_TABS)
    .map((t) => ({ url: t.url, title: text(t.title), favicon: icon(t.favicon), pinned: !!t.pinned }));
}

/** Suma direcciones adelante (la última que anduvo primero), sin repetir. */
function remember(peer, ...addrs) {
  const next = [...addrs.flat().map(bare).filter((a) => isPrivate(a)), ...(peer.addrs || [])];
  peer.addrs = [...new Set(next)].slice(0, MAX_ADDRS);
}

/* ═══════════════════════════════════════════════════════════════════════════ */

function createLink({
  doc,
  library,
  tabs = () => [],
  onState = () => {},
  onReceive = () => {},
  onBookmarks = () => {},
  port = PORT,
  /** Más destinos para el "¿quién está?" (las pruebas, en una sola máquina). */
  seekAlso = [],
  now = () => Date.now(),
  log = (...a) => console.log('[equipos]', ...a),
} = {}) {
  let data = null;                 // lo que se guarda (ver load)
  const servers = new Map();       // dirección → http.Server
  const links = new Map();         // id del equipo → { ws, dialer }
  const dialing = new Set();
  const found = new Map();         // id → { id, name, address, port, seen }
  let pairing = null;              // { pin, until, attempts, timer }
  let udp = null;
  let timers = [];
  let running = false;
  let error = null;
  let saveTimer = null;
  let tabsTimer = null;
  let bmTimer = null;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  /* ── Lo guardado ───────────────────────────────────────────────────────── */

  async function load() {
    const d = (await doc.read().catch(() => null)) || {};
    data = {
      id: idOk(d.id) ? d.id : crypto.randomBytes(9).toString('base64url'),
      name: text(d.name, 40).trim() || os.hostname(),
      enabled: !!d.enabled,
      peers: (Array.isArray(d.peers) ? d.peers : []).filter((p) => p && idOk(p.id) && typeof p.key === 'string'),
      inbox: Array.isArray(d.inbox) ? d.inbox.slice(-MAX_INBOX) : [],
      outbox: Array.isArray(d.outbox) ? d.outbox.slice(-MAX_OUTBOX) : [],
      seen: Array.isArray(d.seen) ? d.seen.slice(-MAX_SEEN) : [],
    };
    if (!d.id) save();
    if (data.enabled) start();
    emit();
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doc.write(data).catch((err) => log('no se pudo guardar:', err.message)); }, 300);
  }

  function flushSync() {
    if (!saveTimer || !data) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try { doc.writeSync(data); } catch (err) { log('no se pudo guardar:', err.message); }
  }

  /* ── Estado hacia la interfaz ──────────────────────────────────────────── */

  const peerOf = (id) => data?.peers.find((p) => p.id === id) || null;
  const online = (id) => links.get(id)?.ws.readyState === WebSocket.OPEN;

  function state() {
    if (!data) return { ready: false };
    return {
      ready: true,
      enabled: data.enabled,
      error,
      me: { id: data.id, name: data.name },
      port,
      addresses: lanFirst([...servers.keys()].filter((a) => a !== '127.0.0.1')),
      pairing: pairing ? { pin: pairing.pin, until: pairing.until } : null,
      peers: data.peers.map((p) => ({
        id: p.id,
        name: p.name,
        online: online(p.id),
        lastSeen: p.lastSeen || 0,
        tabs: p.tabs || [],
        tabsAt: p.tabsAt || 0,
        pending: data.outbox.filter((o) => o.to === p.id).length,
      })),
      inbox: data.inbox.slice().reverse(),
      found: [...found.values()].map((f) => ({ ...f, paired: !!peerOf(f.id) })),
    };
  }

  let emitTimer = null;
  function emit() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; onState(state()); }, 30);
  }

  /* ── Mensajes ──────────────────────────────────────────────────────────── */

  const sendTo = (ws, msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const sendPeer = (id, msg) => sendTo(links.get(id)?.ws, msg);
  const me = () => ({ id: data.id, name: data.name, port, addrs: [...servers.keys()].filter((a) => a !== '127.0.0.1') });

  function myTabs() {
    try { return cleanTabs(tabs()); } catch { return []; }
  }

  const sendTabs = (id) => sendPeer(id, { t: 'tabs', list: myTabs(), at: now() });
  const sendBookmarks = (id) => sendPeer(id, { t: 'bm', state: library.syncState() });
  function flushOutbox(id) {
    for (const item of data.outbox) if (item.to === id) sendPeer(id, { t: 'send', item: { id: item.id, url: item.url, title: item.title, at: item.at } });
  }

  /** Las pestañas de acá cambiaron (tabs.cjs): se cuentan, con un respiro. */
  function tabsChanged() {
    if (!running || tabsTimer || !links.size) return;
    tabsTimer = setTimeout(() => { tabsTimer = null; for (const id of links.keys()) sendTabs(id); }, TABS_DELAY);
  }

  /** Los favoritos cambiaron acá (library.cjs). */
  function bookmarksChanged() {
    if (!running || !links.size) return;
    clearTimeout(bmTimer);
    bmTimer = setTimeout(() => { for (const id of links.keys()) sendBookmarks(id); }, BOOKMARKS_DELAY);
  }

  function onMessage(peer, msg) {
    switch (msg.t) {
      case 'tabs':
        peer.tabs = cleanTabs(msg.list);
        peer.tabsAt = Math.min(now(), Number(msg.at) || now());
        save();
        emit();
        return;
      case 'bm': {
        let changed = false;
        try { changed = library.mergeSync(msg.state); } catch (err) { log('favoritos que no se pudieron mezclar:', err.message); return; }
        const mine = library.syncState();
        // Si acá había algo que allá no, va de vuelta. Con la misma lista, nada.
        if (bmsync.digest(mine, now()) !== bmsync.digest(msg.state, now())) sendBookmarks(peer.id);
        if (changed) {
          onBookmarks();
          for (const id of links.keys()) if (id !== peer.id) sendBookmarks(id);
        }
        return;
      }
      case 'send': {
        const it = msg.item || {};
        if (!idOk(it.id) || !webUrl(it.url)) return;
        sendPeer(peer.id, { t: 'got', id: it.id });
        if (data.seen.includes(it.id)) return;
        data.seen.push(it.id);
        if (data.seen.length > MAX_SEEN) data.seen.splice(0, data.seen.length - MAX_SEEN);
        const item = { id: it.id, from: peer.id, fromName: peer.name, url: it.url, title: text(it.title), at: now() };
        data.inbox.push(item);
        if (data.inbox.length > MAX_INBOX) data.inbox.splice(0, data.inbox.length - MAX_INBOX);
        save();
        emit();
        onReceive(item);
        return;
      }
      case 'got': {
        const before = data.outbox.length;
        data.outbox = data.outbox.filter((o) => !(o.id === msg.id && o.to === peer.id));
        if (data.outbox.length !== before) { save(); emit(); }
        return;
      }
      case 'name':
        peer.name = text(msg.name, 40) || peer.name;
        save();
        emit();
        return;
      case 'forget':
        drop(peer.id, { tell: false });
        return;
      default:
    }
  }

  /* ── Conexiones ────────────────────────────────────────────────────────── */

  /** Una conexión ya autenticada queda como LA conexión con ese equipo. */
  function adopt(ws, peer, dialer) {
    const cur = links.get(peer.id);
    if (cur && cur.ws !== ws && cur.ws.readyState === WebSocket.OPEN) {
      // Dos conexiones con el mismo equipo: queda la que marcó el id menor.
      if (cur.dialer !== dialer && cur.dialer < dialer) { ws.close(CLOSE.duplicate, 'duplicate'); return; }
      cur.ws.close(CLOSE.duplicate, 'duplicate');
    }
    const link = { ws, dialer };
    links.set(peer.id, link);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => {
      if (links.get(peer.id) !== link) return;
      links.delete(peer.id);
      peer.lastSeen = now();
      save();
      emit();
    });
    peer.lastSeen = now();
    save();
    emit();
    log(`conectado con ${peer.name}`);
    sendTabs(peer.id);
    sendBookmarks(peer.id);
    flushOutbox(peer.id);
  }

  /** Lo que es igual de los dos lados de una conexión: leer mensajes JSON. */
  function onJson(ws, fn) {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try { fn(msg); } catch (err) { log('error atendiendo', msg.t, err.message); }
    });
    ws.on('error', () => { /* el close se encarga */ });
  }

  const keyMatches = (given, key) => {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** Alguien marcó acá. */
  function incoming(ws, from) {
    let peer = null;
    const helloTimer = setTimeout(() => { if (!peer) ws.close(CLOSE.helloTimeout, 'hello timeout'); }, HELLO_MS);
    ws.on('close', () => clearTimeout(helloTimer));
    onJson(ws, (msg) => {
      if (peer) { onMessage(peer, msg); return; }
      if (msg.v !== PROTOCOL) { ws.close(CLOSE.protocol, 'protocol'); return; }

      if (msg.t === 'pair') {
        clearTimeout(helloTimer);
        if (!idOk(msg.id) || msg.id === data.id || !tryPair(msg.pin)) {
          log(`PIN rechazado desde ${from}`);
          ws.close(CLOSE.pairRejected, 'pairing rejected');
          return;
        }
        const key = crypto.randomBytes(32).toString('hex');
        const p = upsertPeer({ id: msg.id, name: text(msg.name, 40) || from, key, port: portOk(msg.port) });
        remember(p, from, addrList(msg.addrs));
        save();
        emit();
        log(`emparejado con ${p.name} (${from})`);
        sendTo(ws, { t: 'paired', v: PROTOCOL, ...me(), key });
        ws.close(1000, 'paired');
        // Ahora marca el otro; si no llega, marcamos nosotros.
        setTimeout(() => dial(p), 600);
        return;
      }

      if (msg.t !== 'hello') return;
      const p = idOk(msg.id) ? peerOf(msg.id) : null;
      if (!p || !keyMatches(msg.key, p.key)) {
        log(`llave rechazada desde ${from}`);
        ws.close(CLOSE.unauthorized, 'unauthorized');
        return;
      }
      clearTimeout(helloTimer);
      peer = p;
      p.name = text(msg.name, 40) || p.name;
      p.port = portOk(msg.port);
      remember(p, from, addrList(msg.addrs));
      sendTo(ws, { t: 'ready', v: PROTOCOL, ...me() });
      adopt(ws, p, p.id);
    });
  }

  /** Marca a un equipo emparejado, probando sus direcciones de a una. */
  async function dial(peer) {
    if (!running || online(peer.id) || dialing.has(peer.id)) return;
    dialing.add(peer.id);
    try {
      for (const address of peer.addrs || []) {
        if (!running || online(peer.id) || !peerOf(peer.id)) break;
        const ok = await tryDial(peer, address);
        if (ok) { remember(peer, address); save(); break; }
      }
    } finally {
      dialing.delete(peer.id);
    }
  }

  function tryDial(peer, address) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      const ws = new WebSocket(`ws://${address}:${peer.port || PORT}`, { handshakeTimeout: DIAL_TIMEOUT, maxPayload: 4 * 1024 * 1024 });
      const timer = setTimeout(() => { ws.terminate(); finish(false); }, DIAL_TIMEOUT + HELLO_MS);
      let authed = false;
      ws.on('open', () => sendTo(ws, { t: 'hello', v: PROTOCOL, ...me(), key: peer.key }));
      ws.on('close', (code) => {
        if (code === CLOSE.unauthorized) log(`${peer.name} no reconoce la llave: hay que volver a emparejar`);
        finish(authed);
      });
      onJson(ws, (msg) => {
        if (authed) { onMessage(peer, msg); return; }
        if (msg.t !== 'ready' || msg.id !== peer.id) { ws.close(); return; }
        authed = true;
        peer.name = text(msg.name, 40) || peer.name;
        remember(peer, addrList(msg.addrs));
        adopt(ws, peer, data.id);
        finish(true);
      });
    });
  }

  function dialAll() {
    for (const p of data.peers) dial(p);
  }

  /* ── Emparejar ─────────────────────────────────────────────────────────── */

  function upsertPeer(p) {
    const cur = peerOf(p.id);
    if (cur) { Object.assign(cur, p); return cur; }
    const fresh = { addrs: [], lastSeen: 0, tabs: [], tabsAt: 0, ...p };
    data.peers.push(fresh);
    return fresh;
  }

  /** Este equipo muestra un PIN y espera que el otro lo mande. */
  function openPairing() {
    if (!running) throw new Error('Prendé la conexión con tus equipos primero.');
    closePairing(false);
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const until = now() + PAIR_WINDOW_MS;
    pairing = { pin, until, attempts: 0, timer: setTimeout(() => closePairing(), PAIR_WINDOW_MS) };
    emit();
    return { pin, until };
  }

  function closePairing(tell = true) {
    if (pairing) clearTimeout(pairing.timer);
    pairing = null;
    if (tell) emit();
  }

  function tryPair(pin) {
    const open = pairing;
    if (!open || now() > open.until || typeof pin !== 'string') return false;
    const given = Buffer.from(pin.padEnd(6).slice(0, 6));
    if (crypto.timingSafeEqual(given, Buffer.from(open.pin))) { closePairing(); return true; }
    open.attempts += 1;
    if (open.attempts >= PAIR_ATTEMPTS) closePairing();
    else emit();
    return false;
  }

  /** Este equipo manda el PIN que muestra el otro. → el equipo emparejado. */
  function pair(address, pin, peerPort = port) {
    if (!running) return Promise.reject(new Error('Prendé la conexión con tus equipos primero.'));
    const addr = bare(String(address || '').trim());
    if (!isPrivate(addr)) return Promise.reject(new Error('Esa dirección no es de tu red.'));
    if (!/^\d{6}$/.test(String(pin || ''))) return Promise.reject(new Error('El PIN son 6 números.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (m) => { if (!settled) { settled = true; reject(new Error(m)); } };
      const ws = new WebSocket(`ws://${addr}:${portOk(Number(peerPort))}`, { handshakeTimeout: DIAL_TIMEOUT });
      const timer = setTimeout(() => { ws.terminate(); fail('El otro equipo no contestó.'); }, DIAL_TIMEOUT + HELLO_MS);
      ws.on('open', () => sendTo(ws, { t: 'pair', v: PROTOCOL, pin: String(pin), ...me() }));
      ws.on('close', (code) => {
        clearTimeout(timer);
        if (code === CLOSE.pairRejected) fail('El PIN no es ese, o ya venció.');
        else if (code === CLOSE.protocol) fail('El otro Prism es de otra versión: actualizalos a los dos.');
        else fail('No se pudo emparejar: el otro equipo cortó.');
      });
      ws.on('error', (err) => { clearTimeout(timer); fail(err.code === 'ECONNREFUSED' ? 'En esa dirección no hay un Prism escuchando.' : 'No se pudo llegar al otro equipo.'); });
      onJson(ws, (msg) => {
        if (msg.t !== 'paired' || !idOk(msg.id) || typeof msg.key !== 'string' || !/^[0-9a-f]{64}$/.test(msg.key)) return;
        const p = upsertPeer({ id: msg.id, name: text(msg.name, 40) || addr, key: msg.key, port: portOk(msg.port) });
        remember(p, addr, addrList(msg.addrs));
        found.delete(p.id);
        save();
        emit();
        log(`emparejado con ${p.name} (${addr})`);
        settled = true;
        clearTimeout(timer);
        resolve({ id: p.id, name: p.name });
        setTimeout(() => dial(p), 200);
      });
    });
  }

  /** Olvida un equipo. Si está conectado, le avisa para que olvide este. */
  function drop(id, { tell = true } = {}) {
    const p = peerOf(id);
    if (!p) return false;
    if (tell) sendPeer(id, { t: 'forget' });
    data.peers = data.peers.filter((x) => x.id !== id);
    data.outbox = data.outbox.filter((o) => o.to !== id);
    const l = links.get(id);
    links.delete(id);
    // Un respiro para que el "forget" salga antes del corte.
    if (l) setTimeout(() => l.ws.close(CLOSE.forgotten, 'forgotten'), 150);
    save();
    emit();
    log(`olvidado ${p.name}`);
    return true;
  }

  /* ── Encontrarse en la red (UDP) ───────────────────────────────────────── */

  function openUdp() {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', (err) => log('UDP:', err.code || err.message));
    udp.on('message', (buf, rinfo) => {
      if (!isPrivate(rinfo.address) || buf.length > 2048) return;
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!msg || msg.v !== PROTOCOL || msg.id === data.id || !idOk(msg.id)) return;
      if (msg.t === 'who') {
        const reply = Buffer.from(JSON.stringify({ t: 'here', v: PROTOCOL, id: data.id, name: data.name, port }));
        udp.send(reply, rinfo.port, rinfo.address);
      } else if (msg.t === 'here') {
        const f = { id: msg.id, name: text(msg.name, 40) || rinfo.address, address: rinfo.address, port: portOk(msg.port), seen: now() };
        found.set(f.id, f);
        const p = peerOf(f.id);
        // Un equipo emparejado que apareció en otra dirección: se lo marca ahí.
        if (p && !online(p.id)) { remember(p, f.address); p.port = f.port; save(); dial(p); }
        emit();
      }
    });
    udp.bind(port, () => { try { udp.setBroadcast(true); } catch { /* nada */ } });
  }

  /** "¿Quién está?" a cada red. Las respuestas van llegando a `found`. */
  function seek() {
    if (!udp) return;
    const msg = Buffer.from(JSON.stringify({ t: 'who', v: PROTOCOL, id: data.id, name: data.name }));
    for (const a of broadcasts()) udp.send(msg, port, a, () => {});
    for (const t of seekAlso) udp.send(msg, t.port, t.address, () => {});
  }

  /** Busca y espera un momento las respuestas. → los encontrados. */
  async function discover(ms = 1500) {
    if (!running) throw new Error('Prendé la conexión con tus equipos primero.');
    for (const [id, f] of found) if (now() - f.seen > 30_000) found.delete(id);
    seek();
    await new Promise((r) => setTimeout(r, ms));
    return state().found;
  }

  /* ── Escuchar ──────────────────────────────────────────────────────────── */

  function rescan() {
    if (!running) return;
    const wanted = new Set(['127.0.0.1', ...interfaces().map((i) => i.address)]);
    for (const [address, server] of servers) {
      if (wanted.has(address)) continue;
      server.close();
      servers.delete(address);
      emit();
    }
    for (const address of wanted) if (!servers.has(address)) listen(address);
  }

  function listen(address) {
    const server = http.createServer((_req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('Prism\n'); });
    server.on('upgrade', (req, socket, head) => {
      const from = bare(req.socket.remoteAddress);
      // Solo la red de la casa: una conexión de afuera ni llega al WebSocket.
      if (!isPrivate(from)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => incoming(ws, from));
    });
    servers.set(address, server);
    server.on('listening', () => { if (error && address === '127.0.0.1') error = null; emit(); });
    server.on('error', (err) => {
      if (servers.get(address) === server) servers.delete(address);
      if (address === '127.0.0.1') error = err.code === 'EADDRINUSE' ? `El puerto ${port} lo tiene otro programa.` : (err.message || String(err));
      log(`no pude escuchar en ${address}:${port}: ${err.code || err.message}`);
      emit();
    });
    server.listen(port, address);
  }

  /* ── Prender y apagar ──────────────────────────────────────────────────── */

  function start() {
    if (running) return;
    running = true;
    error = null;
    rescan();
    openUdp();
    library.onBookmarks = bookmarksChanged;
    timers = [
      setInterval(rescan, RESCAN_EVERY),
      setInterval(dialAll, DIAL_EVERY),
      setInterval(() => { if (data.peers.some((p) => !online(p.id))) seek(); }, SEEK_EVERY),
      // Las conexiones se mueren sin avisar (la laptop se durmió): ping cada 30 s.
      setInterval(() => {
        for (const { ws } of links.values()) {
          if (ws.alive === false) { ws.terminate(); continue; }
          ws.alive = false;
          try { ws.ping(); } catch { /* nada */ }
        }
      }, 30_000),
    ];
    setTimeout(() => { dialAll(); seek(); }, 300);
    log(`escuchando en el puerto ${port}`);
  }

  function stop() {
    if (!running) return;
    running = false;
    closePairing(false);
    timers.forEach(clearInterval);
    timers = [];
    clearTimeout(tabsTimer); tabsTimer = null;
    clearTimeout(bmTimer);
    library.onBookmarks = null;
    for (const { ws } of links.values()) ws.close(CLOSE.stopped, 'stopped');
    links.clear();
    for (const server of servers.values()) server.close();
    servers.clear();
    try { udp?.close(); } catch { /* nada */ }
    udp = null;
    found.clear();
  }

  function setEnabled(on) {
    data.enabled = !!on;
    save();
    if (data.enabled) start(); else stop();
    emit();
  }

  function setName(name) {
    const n = text(name, 40).trim();
    if (!n) throw new Error('El nombre no puede quedar vacío.');
    data.name = n;
    for (const id of links.keys()) sendPeer(id, { t: 'name', name: n });
    save();
    emit();
  }

  /* ── Pestañas mandadas ─────────────────────────────────────────────────── */

  /** Manda una dirección a otro equipo. Si no está, queda en fila hasta que aparezca. */
  function send(peerId, { url, title = '' } = {}) {
    if (!peerOf(peerId)) throw new Error('Ese equipo ya no está emparejado.');
    if (!webUrl(url)) throw new Error('Solo se pueden mandar páginas web.');
    const item = { id: crypto.randomBytes(9).toString('base64url'), to: peerId, url, title: text(title), at: now() };
    data.outbox.push(item);
    if (data.outbox.length > MAX_OUTBOX) data.outbox.splice(0, data.outbox.length - MAX_OUTBOX);
    save();
    sendPeer(peerId, { t: 'send', item: { id: item.id, url: item.url, title: item.title, at: item.at } });
    emit();
    return { queued: !online(peerId) };
  }

  /** Saca una recibida de la lista (al abrirla o al descartarla). → la que era. */
  function take(id) {
    const item = data.inbox.find((x) => x.id === id) || null;
    if (!item) return null;
    data.inbox = data.inbox.filter((x) => x.id !== id);
    save();
    emit();
    return item;
  }

  function clearInbox() {
    data.inbox = [];
    save();
    emit();
  }

  return {
    load, state, flushSync,
    setEnabled, setName,
    openPairing, closePairing, pair, discover, forget: (id) => drop(id),
    send, take, clearInbox,
    tabsChanged, bookmarksChanged,
    stop,
    get running() { return running; },
  };
}

module.exports = { createLink, isPrivate, PORT, PROTOCOL };
