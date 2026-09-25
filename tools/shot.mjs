/* ═══════════════════════════════════════════════════════════════════════════
   Captura fiel de Prism en modo verificación: le pide al proceso principal
   (por el inspector de Node, --inspect=9334) la foto del cromo y la de la
   página activa, y las compone donde van — con el mismo radio de esquina que
   lleva la vista. Es lo que ve la persona.

     node tools/shot.mjs .shots/algo.png
   ═══════════════════════════════════════════════════════════════════════════ */

import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const out = path.resolve(process.argv[2] || '.shots/prism.png');
const PORT = Number(process.env.INSPECT_PORT || 9334);
const [target] = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const tmp = path.join(os.tmpdir(), 'prism-shot-parts');
const res = await new Promise((resolve) => {
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id === 1) resolve(msg.result); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `globalThis.__prismShot(${JSON.stringify(tmp)})`, awaitPromise: true, returnByValue: true } }));
});
ws.close();
const info = JSON.parse(res.result.value);
execFileSync('python', ['-c', `
import json, sys
from PIL import Image, ImageDraw
tmp, out, info = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
base = Image.open(tmp + '/chrome.png').convert('RGBA')
b = info['bounds']
if b:
    v = Image.open(tmp + '/view.png').convert('RGBA').resize((b['width'], b['height']))
    m = Image.new('L', v.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, v.size[0]-1, v.size[1]-1], radius=10, fill=255)
    base.paste(v, (b['x'], b['y']), m)
base.convert('RGB').save(out)
print(out)
`, tmp, out, JSON.stringify(info)], { stdio: 'inherit' });
