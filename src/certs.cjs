'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — certificados que no son válidos
   Por defecto, Electron rechaza todo certificado que Chromium no puede
   verificar, y la pestaña cae en la página de error sin salida. En internet
   eso es lo correcto: un certificado inválido puede ser alguien haciéndose
   pasar por el sitio.

   En la red de casa no: el router, el NAS o la impresora sirven su página
   por https con un certificado que se fabricaron ellos mismos (nadie les
   puede firmar uno para 192.168.1.1). Para esos, y SOLO para esos, la
   persona puede confiar en el certificado desde la página de error.

   Lo que se recuerda es el certificado EXACTO (su huella SHA-256) para ese
   sitio, no el sitio: si el router cambia de certificado —o alguien en la red
   pone otro en su lugar—, Prism vuelve a preguntar. Se olvida desde Ajustes.

   "Local" se decide por la dirección escrita, nunca por a dónde resuelve: un
   nombre de internet que resuelva a 192.168.x.x sigue siendo de internet.
   ═══════════════════════════════════════════════════════════════════════════ */

/** El host de una URL, sin corchetes (IPv6) y en minúsculas. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; }
}

function ipv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** ¿Es una dirección de la red de casa o de la propia compu? */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // Nombres que por norma no existen en internet (mDNS y la red de casa).
  if (h.endsWith('.local') || h.endsWith('.home.arpa')) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return a === 10                          // 10.0.0.0/8
      || a === 127                           // la propia compu
      || (a === 172 && b >= 16 && b <= 31)   // 172.16.0.0/12
      || (a === 192 && b === 168)            // 192.168.0.0/16
      || (a === 169 && b === 254);           // enlace local (sin DHCP)
  }
  if (h.includes(':')) {
    return h === '::1'
      || /^fe[89ab][0-9a-f]:/.test(h)        // fe80::/10, enlace local
      || /^f[cd][0-9a-f]{2}:/.test(h);       // fc00::/7, direcciones privadas
  }
  return false;
}

function createCerts(ctx) {
  const { app } = require('electron');
  /* El último certificado rechazado de cada pestaña (por webContents): la
     página de error lo ofrece, y aceptar es aceptar ESE, no el que mande el
     sitio la próxima vez. */
  const rejected = new Map();
  // Un solo escuchador de cierre por pestaña, aunque rechace varios certificados.
  const watched = new WeakSet();

  const list = () => ctx.settings?.certAllow || [];
  const allowed = (host, fp) => list().some((c) => c.host === host && c.fp === fp);

  app.on('certificate-error', (event, wc, url, error, cert, callback, isMainFrame) => {
    const host = hostOf(url);
    const fp = cert?.fingerprint || '';
    if (fp && isLocalHost(host) && allowed(host, fp)) {
      event.preventDefault();
      callback(true);
      return;
    }
    if (isMainFrame) {
      rejected.set(wc.id, { host, fp, error, local: isLocalHost(host), issuer: cert?.issuerName || '' });
      if (!watched.has(wc)) {
        watched.add(wc);
        const id = wc.id;
        wc.once('destroyed', () => rejected.delete(id));
      }
    }
    callback(false);
  });

  return {
    isLocalHost,
    /** Lo que se le cuenta a la página de error (sin la huella: no hace falta allá). */
    rejectedFor(wcId, url) {
      const r = rejected.get(wcId);
      return r && r.host === hostOf(url) ? { host: r.host, local: r.local, issuer: r.issuer } : null;
    },
    /** ¿La página se abrió confiando en un certificado que Chromium no valida? */
    acceptedFor(url) {
      if (!/^https:/i.test(String(url))) return false;
      const host = hostOf(url);
      return isLocalHost(host) && list().some((c) => c.host === host);
    },
    /** Confiar en el certificado que se rechazó en esta pestaña. */
    async allow(wcId, url) {
      const r = rejected.get(wcId);
      if (!r || r.host !== hostOf(url)) throw new Error('No hay un certificado para aceptar en esta pestaña.');
      if (!r.local) throw new Error('Solo se puede confiar en certificados de la red local.');
      if (!r.fp) throw new Error('El certificado no trae huella.');
      await ctx.updateSettings((s) => ({
        // Uno por sitio: el nuevo reemplaza al que hubiera.
        certAllow: [...(s.certAllow || []).filter((c) => c.host !== r.host), { host: r.host, fp: r.fp, at: Date.now() }],
      }));
      rejected.delete(wcId);
      return r.host;
    },
    /* Olvidar tiene que notarse en el acto: una conexión que ya está abierta
       con el sitio no vuelve a verificar el certificado, y recargar entraba
       igual. Se cierran las conexiones y se recargan sus pestañas, salvo con
       una descarga en curso (cerrar las conexiones la cortaría): ahí rige
       desde la próxima conexión. */
    async forget(host) {
      const h = String(host || '').toLowerCase();
      await ctx.updateSettings((s) => ({ certAllow: (s.certAllow || []).filter((c) => c.host !== h) }));
      if (ctx.downloads?.activeCount) return false;
      await ctx.web?.closeAllConnections?.().catch(() => {});
      for (const t of ctx.tabs?.list || []) {
        if (t.view && /^https:/i.test(t.url) && hostOf(t.url) === h) t.view.webContents.reload();
      }
      return true;
    },
  };
}

module.exports = { createCerts, isLocalHost, hostOf };
