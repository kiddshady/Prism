/* ═══════════════════════════════════════════════════════════════════════════
   Manejar el cromo de Prism desde afuera, por el protocolo de DevTools.
   Para probar a mano sin tocar el mouse: Prism tiene que estar corriendo con
   `npm run dev -- --remote-debugging-port=9333`.

     node tools/cdp.mjs eval "document.title"
     node tools/cdp.mjs type "wikipedia.org"
     node tools/cdp.mjs key Enter [ctrl|shift|alt …]
     node tools/cdp.mjs targets
   ═══════════════════════════════════════════════════════════════════════════ */

const PORT = Number(process.env.CDP_PORT || 9333);
const [, , cmd, ...rest] = process.argv;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
if (cmd === 'targets') {
  for (const t of targets) console.log(`${t.type}\t${t.url}`);
  process.exit(0);
}
const target = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
if (!target) { console.error('No encontré el cromo de Prism'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') console.log(`[${msg.params.type}]`, msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') console.log('[excepción]', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
};
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  F5: { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
};

if (cmd === 'reload') {
  // Recarga el cromo y muestra lo que diga la consola durante unos segundos.
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, Number(rest[0]) || 3000));
} else if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: rest.join(' '), awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result, null, 2));
} else if (cmd === 'type') {
  for (const ch of rest.join(' ')) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await new Promise((r) => setTimeout(r, 25));
  }
} else if (cmd === 'key') {
  const [name, ...mods] = rest;
  const k = KEYS[name] || { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  const modifiers = (mods.includes('alt') ? 1 : 0) | (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k, text: modifiers & 2 ? undefined : k.text });
  if (k.text && !(modifiers & 2)) await send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
} else if (cmd === 'click') {
  const [x, y, button = 'left'] = rest;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: Number(x), y: Number(y), button, clickCount: 1 });
  }
}
ws.close();
