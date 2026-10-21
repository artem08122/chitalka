/**
 * Cloud sync of books between devices via a PRIVATE GitHub repo (artem08122/chitalka-library).
 * Layout in the repo:  files/<bookId>.<ext>  (original file)  +  meta/<bookId>.json  ({id,name,ext,shelfId,addedAt})
 * The access token (fine-grained, Contents: read/write on that single repo) is entered once by the user
 * and kept in localStorage + Telegram CloudStorage (private to the user's Telegram account).
 */
const OWNER = 'artem08122';
const REPO = 'chitalka-library';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
const LS_KEY = 'agy_gh_token';
const TG_KEY = 'gh_token';

function tgCloud() {
  return window.Telegram?.WebApp?.CloudStorage || null;
}

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64FromText(text) {
  return b64FromBuffer(new TextEncoder().encode(text));
}

class CloudSync {
  constructor() {
    this.token = '';
    this.busy = false;
  }

  async init() {
    try { this.token = localStorage.getItem(LS_KEY) || ''; } catch (e) { /* ignore */ }
    if (!this.token && tgCloud()) {
      this.token = await new Promise((resolve) => {
        try {
          tgCloud().getItem(TG_KEY, (err, val) => resolve(!err && val ? val : ''));
          setTimeout(() => resolve(''), 2500);
        } catch (e) { resolve(''); }
      });
      if (this.token) { try { localStorage.setItem(LS_KEY, this.token); } catch (e) { /* ignore */ } }
    }
    return this.enabled;
  }

  get enabled() { return !!this.token; }

  setToken(token) {
    this.token = (token || '').trim();
    try { localStorage.setItem(LS_KEY, this.token); } catch (e) { /* ignore */ }
    if (tgCloud()) {
      try { tgCloud().setItem(TG_KEY, this.token, () => {}); } catch (e) { /* ignore */ }
    }
  }

  async req(path, opts = {}) {
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const resp = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return resp;
  }

  async list(dir) {
    const r = await this.req(dir);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  }

  async put(path, b64, message) {
    let sha;
    const ex = await this.req(path);
    if (ex.ok) sha = (await ex.json()).sha;
    const r = await this.req(path, { method: 'PUT', body: { message, content: b64, sha } });
    if (!r.ok) throw new Error(`PUT ${path}: ${r.status}`);
  }

  async remove(path) {
    const ex = await this.req(path);
    if (!ex.ok) return;
    const sha = (await ex.json()).sha;
    await this.req(path, { method: 'DELETE', body: { message: 'delete', sha } });
  }

  extOf(name) {
    const lower = (name || '').toLowerCase();
    if (lower.endsWith('.fb2.zip')) return 'fb2.zip';
    return lower.split('.').pop() || 'bin';
  }

  /** Upload a book (original file + meta). */
  async push(id, fileName, arrayBuffer, shelfId) {
    if (!this.enabled) return false;
    const ext = this.extOf(fileName);
    const meta = { id, name: fileName, ext, shelfId: shelfId || 'shelf_none', addedAt: Date.now() };
    await this.put(`files/${id}.${ext}`, b64FromBuffer(arrayBuffer), `add ${id}`);
    await this.put(`meta/${id}.json`, b64FromText(JSON.stringify(meta)), `meta ${id}`);
    return true;
  }

  async updateShelf(id, shelfId) {
    if (!this.enabled) return;
    try {
      const r = await this.req(`meta/${id}.json`, { raw: true });
      if (!r.ok) return;
      const meta = await r.json();
      meta.shelfId = shelfId;
      await this.put(`meta/${id}.json`, b64FromText(JSON.stringify(meta)), `shelf ${id}`);
    } catch (e) { console.warn('cloud updateShelf', e); }
  }

  async removeBook(id) {
    if (!this.enabled) return;
    try {
      const metaR = await this.req(`meta/${id}.json`, { raw: true });
      if (metaR.ok) {
        const meta = await metaR.json();
        await this.remove(`files/${id}.${meta.ext}`);
      }
      await this.remove(`meta/${id}.json`);
    } catch (e) { console.warn('cloud removeBook', e); }
  }

  /**
   * Two-way sync: download books missing locally, upload local books missing in the cloud.
   * Returns { down, up }.
   */
  async sync(storage, parseBookFile, onStatus = () => {}) {
    if (!this.enabled || this.busy) return { down: 0, up: 0 };
    this.busy = true;
    let down = 0;
    let up = 0;
    try {
      const remoteMeta = (await this.list('meta')).filter(i => i.name.endsWith('.json'));
      const remoteIds = new Set(remoteMeta.map(i => i.name.replace(/\.json$/, '')));
      const localBooks = await storage.getAllBooks();
      const localIds = new Set(localBooks.map(b => b.id));

      for (const item of remoteMeta) {
        const id = item.name.replace(/\.json$/, '');
        if (localIds.has(id)) continue;
        try {
          onStatus(`Загрузка книги из облака… (${down + 1})`);
          const mr = await this.req(`meta/${id}.json`, { raw: true });
          if (!mr.ok) continue;
          const meta = await mr.json();
          const fr = await this.req(`files/${id}.${meta.ext}`, { raw: true });
          if (!fr.ok) continue;
          const buf = await fr.arrayBuffer();
          const file = new File([buf], meta.name, { type: 'application/octet-stream' });
          const parsed = await parseBookFile(file, meta.shelfId || 'shelf_none');
          parsed.id = id;
          parsed.shelfId = meta.shelfId || parsed.shelfId;
          await storage.saveFileBlob(id, buf);
          await storage.saveBook(parsed);
          down++;
        } catch (e) { console.warn('cloud download failed', id, e); }
      }

      for (const b of localBooks) {
        if (remoteIds.has(b.id)) continue;
        try {
          const blob = await storage.getFileBlob(b.id);
          if (!blob) continue;
          onStatus('Отправка книги в облако…');
          const buf = blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer();
          const name = b.fileName || `${b.title}.${b.format || 'bin'}`;
          await this.push(b.id, name, buf, b.shelfId);
          up++;
        } catch (e) { console.warn('cloud upload failed', b.id, e); }
      }
    } finally {
      this.busy = false;
    }
    return { down, up };
  }

  /** Small token dialog (no dependency on index.html markup). */
  askToken() {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
      wrap.innerHTML = `
        <div style="background:var(--bg-elevated,#fff);color:var(--text,#111);max-width:420px;width:100%;border-radius:16px;padding:18px;font:15px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.4)">
          <div style="font-weight:700;font-size:17px;margin-bottom:8px">☁ Синхронизация книг</div>
          <div style="opacity:.8;margin-bottom:10px">Вставьте токен доступа к приватному хранилищу. Он запомнится в вашем Telegram и подхватится на других устройствах.</div>
          <input id="cloud-token-input" type="password" placeholder="github_pat_…" style="width:100%;box-sizing:border-box;padding:11px;border-radius:10px;border:1px solid #8884;font-size:15px;background:transparent;color:inherit">
          <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
            <button id="cloud-cancel" style="padding:10px 14px;border-radius:10px;border:1px solid #8884;background:transparent;color:inherit;font-size:15px">Отмена</button>
            <button id="cloud-save" style="padding:10px 14px;border-radius:10px;border:0;background:#2481cc;color:#fff;font-size:15px">Сохранить</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const close = (val) => { wrap.remove(); resolve(val); };
      wrap.querySelector('#cloud-cancel').onclick = () => close(null);
      wrap.querySelector('#cloud-save').onclick = () => close(wrap.querySelector('#cloud-token-input').value.trim());
    });
  }
}

export const cloud = new CloudSync();
