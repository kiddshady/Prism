/* Evalúa una expresión en el proceso principal de Prism (modo verificación,
   --inspect=9334). `ctx` está en globalThis.__prismCtx.
     node tools/main.mjs "ctx.tabs.list.length"                                */
const PORT = Number(process.env.INSPECT_PORT || 9334);
const [target] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const expr = `(async (ctx) => (${process.argv.slice(2).join(' ')}))(globalThis.__prismCtx)`;
const res = await new Promise((resolve) => {
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) resolve(msg.result); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
ws.close();
console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails?.exception?.description ?? res, null, 2));
