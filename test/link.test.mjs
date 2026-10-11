/* ═══════════════════════════════════════════════════════════════════════════
   Tus equipos: dos Prism de verdad hablando por loopback (src/link.cjs), y
   la mezcla de favoritos (src/bmsync.cjs).
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
import { WebSocket } from 'ws';
const require = createRequire(import.meta.url);
const { createLibrary } = require('../src/library.cjs');
const { createLink } = require('../src/link.cjs');
const bmsync = require('../src/bmsync.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(40); }
  return false;
}
const rejects = (p) => p.then(() => null, (err) => err.message);

function memDoc() {
  let data = null;
  return {
    read: async () => structuredClone(data),
    write: async (d) => { data = structuredClone(d); },
    writeSync: (d) => { data = structuredClone(d); },
    get data() { return data; },
  };
}

console.log('\n1. La mezcla de favoritos');
const T0 = Date.UTC(2026, 9, 10, 12);
const item = (url, at, extra = {}) => ({ url, title: url.slice(8), favicon: null, createdAt: at, at, ...extra });
const A = { items: [item('https://a.com', T0), item('https://b.com', T0 + 1)], gone: { 'https://x.com': T0 + 5 }, orderAt: T0 + 10 };
const B = { items: [item('https://c.com', T0 + 20), item('https://b.com', T0 + 30, { title: 'B nuevo' }), item('https://x.com', T0 + 2)], gone: {}, orderAt: T0 };
const ab = bmsync.merge(A, B, T0 + 100);
const ba = bmsync.merge(B, A, T0 + 100);
ok('A con B da lo mismo que B con A', bmsync.digest(ab, T0 + 100) === bmsync.digest(ba, T0 + 100));
ok('mezclar algo consigo mismo no lo cambia', bmsync.digest(bmsync.merge(ab, ab, T0 + 100), T0 + 100) === bmsync.digest(ab, T0 + 100));
ok('y mezclar lo mezclado con una de las partes, tampoco', bmsync.digest(bmsync.merge(B, ab, T0 + 100), T0 + 100) === bmsync.digest(ab, T0 + 100));
ok('el cambio más nuevo gana', ab.items.find((x) => x.url === 'https://b.com')?.title === 'B nuevo');
ok('pero conserva la fecha en que se guardó primero', ab.items.find((x) => x.url === 'https://b.com')?.createdAt === T0 + 1);
ok('una lápida le gana a un favorito más viejo', !ab.items.some((x) => x.url === 'https://x.com') && ab.gone['https://x.com'] === T0 + 5);
const later = bmsync.merge(ab, { items: [item('https://x.com', T0 + 50)], gone: {}, orderAt: 0 }, T0 + 100);
ok('y pierde contra uno guardado después', later.items.some((x) => x.url === 'https://x.com') && !later.gone['https://x.com']);
ok('el orden es del que reordenó último, y lo que no conocía va arriba', ab.items.map((x) => x.url).join() === 'https://c.com,https://a.com,https://b.com', ab.items.map((x) => x.url).join());
ok('lo que no es una página no entra', bmsync.clean({ items: [{ url: 'javascript:alert(1)' }, { url: 'prism://ajustes' }] }).items.length === 0);
ok('una lápida de hace más de medio año se olvida', !Object.keys(bmsync.clean({ gone: { 'https://v.com': T0 - bmsync.KEEP_GONE - 1 } }, T0).gone).length);

console.log('\n2. Emparejar');
const PA = 18731;
const PB = 18732;
function machine(port, otherPort, tabs) {
  const lib = createLibrary({ historyDoc: memDoc(), bookmarksDoc: memDoc(), saveDelay: 5 });
  const doc = memDoc();
  const got = [];
  let merged = 0;
  const link = createLink({
    doc, library: lib, port, tabs: () => tabs.list,
    seekAlso: [{ address: '127.0.0.1', port: otherPort }],
    onReceive: (it) => got.push(it),
    onBookmarks: () => { merged += 1; },
    log: () => {},
  });
  return { lib, doc, link, got, tabs, get merged() { return merged; } };
}
const ta = { list: [{ url: 'https://wikipedia.org', title: 'Wikipedia', favicon: 'data:image/png;base64,AAA', pinned: true }, { url: 'prism://ajustes', title: 'Ajustes' }] };
const tb = { list: [] };
const ucx = machine(PA, PB, ta);
const uck = machine(PB, PA, tb);
await ucx.lib.load();
await uck.lib.load();
// Cada uno ya tenía favoritos antes de conocerse.
ucx.lib.addBookmark({ url: 'https://pubmed.ncbi.nlm.nih.gov', title: 'PubMed' });
uck.lib.addBookmark({ url: 'https://sied.umaza.edu.ar', title: 'SIED' });
await ucx.link.load();
await uck.link.load();
ok('arranca apagado', !ucx.link.state().enabled && !ucx.link.running);
ok('apagado no muestra PIN', /Prendé/.test((() => { try { ucx.link.openPairing(); return ''; } catch (e) { return e.message; } })()));
ucx.link.setEnabled(true);
uck.link.setEnabled(true);
await sleep(200);
ok('prendido, escucha', ucx.link.running && uck.link.running);

const quiet = await uck.link.discover();
ok('sin PIN a la vista, un desconocido no le saca el nombre', !quiet.some((f) => f.id === ucx.link.state().me.id), JSON.stringify(quiet));

ok('sin PIN abierto, emparejar falla', /PIN/.test(await rejects(uck.link.pair('127.0.0.1', '123456', PA))));
const { pin } = ucx.link.openPairing();
const found = await uck.link.discover();
ok('mostrando el PIN, el otro lo encuentra con su nombre', found.some((f) => f.id === ucx.link.state().me.id && f.address === '127.0.0.1' && f.port === PA), JSON.stringify(found));
ok('el PIN son 6 números', /^\d{6}$/.test(pin));
const wrong = pin === '000000' ? '111111' : '000000';
ok('un PIN equivocado no empareja', /PIN/.test(await rejects(uck.link.pair('127.0.0.1', wrong, PA))));
ok('y la ventana sigue abierta para reintentar', !!ucx.link.state().pairing);
ok('una dirección de afuera ni se intenta', /red/.test(await rejects(uck.link.pair('8.8.8.8', pin, PA))));
const paired = await uck.link.pair('127.0.0.1', pin, PA);
ok('con el PIN bien, empareja', paired.id === ucx.link.state().me.id);
ok('y el PIN se cierra: sirve una sola vez', !ucx.link.state().pairing);
ok('los dos se conocen', ucx.link.state().peers.length === 1 && uck.link.state().peers.length === 1);
ok('y se conectan solos', await until(() => ucx.link.state().peers[0]?.online && uck.link.state().peers[0]?.online));
ok('queda UNA conexión por lado aunque marquen los dos', await until(() => ucx.link.state().peers.length === 1 && uck.link.state().peers[0].online));
ok('ya emparejados, se siguen encontrando sin PIN (por si cambia la IP)', !ucx.link.state().pairing && (await uck.link.discover()).some((f) => f.id === ucx.link.state().me.id && f.paired));

console.log('\n3. Las pestañas del otro');
ok('la UCK1 ve las pestañas web de la UCX', await until(() => uck.link.state().peers[0].tabs.length === 1));
const seen = uck.link.state().peers[0].tabs[0];
ok('con su título y si está fijada', seen.title === 'Wikipedia' && seen.pinned === true);
ok('sin las páginas propias de Prism ni los íconos pesados', seen.favicon === null);
ta.list.push({ url: 'https://youtube.com', title: 'YouTube' });
ucx.link.tabsChanged();
ok('abrir otra se ve del otro lado', await until(() => uck.link.state().peers[0].tabs.length === 2));

console.log('\n4. Mandar una pestaña');
const ucxId = ucx.link.state().me.id;
const uckId = uck.link.state().me.id;
const r = uck.link.send(ucxId, { url: 'https://chembl.ebi.ac.uk', title: 'ChEMBL' });
ok('conectado, no queda en fila', r.queued === false);
ok('llega del otro lado', await until(() => ucx.got.length === 1 && ucx.link.state().inbox.length === 1));
ok('dice de quién vino', ucx.link.state().inbox[0].fromName === uck.link.state().me.name);
ok('y el que la mandó se entera (sale de su fila)', await until(() => uck.link.state().peers[0].pending === 0));
ok('no se manda lo que no es una página web', /web/.test((() => { try { uck.link.send(ucxId, { url: 'file:///C:/secreto.txt' }); return ''; } catch (e) { return e.message; } })()));
const taken = ucx.link.take(ucx.link.state().inbox[0].id);
ok('abrirla la saca de la lista', taken?.url === 'https://chembl.ebi.ac.uk' && ucx.link.state().inbox.length === 0);

ucx.link.setEnabled(false);
ok('la UCX se apaga y la UCK1 se entera', await until(() => !uck.link.state().peers[0].online));
const q = uck.link.send(ucxId, { url: 'https://pharos.example.com', title: 'Pharos' });
ok('mandar a un equipo apagado la deja en fila', q.queued === true && uck.link.state().peers[0].pending === 1);
ucx.link.setEnabled(true);
ok('al volver, llega sola', await until(() => ucx.got.length === 2, 8000));
ok('una sola vez', (await sleep(500), ucx.got.length === 2 && ucx.link.state().inbox.length === 1));

console.log('\n5. Favoritos');
const urls = (m) => m.lib.listBookmarks().map((b) => b.url).sort().join();
ok('al conocerse, cada uno tiene los del otro', await until(() => urls(ucx) === urls(uck) && urls(ucx).includes('pubmed') && urls(ucx).includes('sied')), `${urls(ucx)} | ${urls(uck)}`);
ucx.lib.addBookmark({ url: 'https://pubchem.ncbi.nlm.nih.gov', title: 'PubChem' });
ok('guardar uno acá aparece allá', await until(() => uck.lib.isBookmarked('https://pubchem.ncbi.nlm.nih.gov')));
ok('y allá se redibuja', uck.merged > 0);
uck.lib.removeBookmark('https://sied.umaza.edu.ar');
ok('quitar uno allá lo quita acá', await until(() => !ucx.lib.isBookmarked('https://sied.umaza.edu.ar')));
const first = ucx.lib.listBookmarks().at(-1);
ucx.lib.moveBookmark(first.id, 0);
ok('reordenar acá reordena allá', await until(() => uck.lib.listBookmarks()[0]?.url === first.url));
const id = uck.lib.listBookmarks().find((b) => b.url === 'https://pubchem.ncbi.nlm.nih.gov').id;
uck.lib.updateBookmark(id, { title: 'PubChem (compuestos)' });
ok('renombrar allá renombra acá', await until(() => ucx.lib.listBookmarks().find((b) => b.url.includes('pubchem'))?.title === 'PubChem (compuestos)'));

console.log('\n6. Llaves y olvido');
const intruso = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PA}`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, id: uckId, key: 'f'.repeat(64), name: 'intruso' })));
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => {});
});
ok('una llave falsa se corta', intruso === 4003, String(intruso));
ok('y no tumba la conexión de verdad', uck.link.state().peers[0].online);
const mudo = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PA}`);
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => {});
});
ok('quien no se presenta en 5 segundos se corta', mudo === 4001, String(mudo));
ucx.link.setName('UCX');
ok('renombrar este equipo se ve del otro lado al toque', await until(() => uck.link.state().peers[0].name === 'UCX'));
ucx.link.forget(uckId);
ok('olvidar acá', ucx.link.state().peers.length === 0);
ok('hace que el otro también olvide', await until(() => uck.link.state().peers.length === 0));

ucx.link.stop();
uck.link.stop();
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
