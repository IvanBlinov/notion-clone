'use node';
// Files stored in notion-clone: imports from a URL (or base64 data) for agents, and the
// finishing step of browser uploads. Each file is stored once per workspace (same content →
// same stored file, or the same `key` → no download at all) and images get a thumbnail
// (at most 480 px) so galleries and file chips don't load full-size originals.
import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';

const MAX_BYTES = 20 * 1024 * 1024;
const THUMB = 480;
const MAX_PER_CALL = 50;

const problem = (msg) => Object.assign(new Error(msg), { expected: true });

/** Only public http(s) hosts: never localhost, private networks or cloud metadata addresses. */
function urlProblem(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (!['https:', 'http:'].includes(u.protocol)) return 'Only http(s) URLs can be imported';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.')) return 'That host is not reachable from the internet';
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'Private and reserved IP addresses are not allowed';
  }
  if (h.includes(':')) return 'Use a host name, not an IPv6 address';
  return null;
}

async function download(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const p = urlProblem(current);
    if (p) throw problem(p);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'notion-clone-file-import' } });
    } catch (err) {
      clearTimeout(timer);
      throw problem(`Download failed: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    try {
      if (!res.ok) throw problem(`Download failed: HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw problem('Files are limited to 20 MB');
      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          throw problem('Files are limited to 20 MB');
        }
        chunks.push(Buffer.from(value));
      }
      return { buf: Buffer.concat(chunks), contentType: (res.headers.get('content-type') || '').split(';')[0].trim() || null };
    } finally {
      clearTimeout(timer);
    }
  }
  throw problem('Too many redirects');
}

// ---------- images ----------
function sniff(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

function decode(buf, type) {
  if (type === 'image/png') {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (type === 'image/jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 768, maxResolutionInMP: 120 });
    return { width: img.width, height: img.height, data: img.data };
  }
  return null;
}

/** Area-average downscale of RGBA pixels. */
function shrink(src, tw, th) {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8Array(tw * th * 4);
  const fx = sw / tw;
  const fy = sh / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const al = data[i + 3];
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = a ? Math.round(r / a) : 255;
      out[o + 1] = a ? Math.round(g / a) : 255;
      out[o + 2] = a ? Math.round(b / a) : 255;
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: tw, height: th, data: out };
}

/** { width, height, thumb?: { buf, type } } for PNG / JPEG; null for anything else. */
function thumbnail(buf, type) {
  let img;
  try {
    img = decode(buf, type);
  } catch {
    return null;
  }
  if (!img) return null;
  const { width, height } = img;
  const scale = Math.min(1, THUMB / Math.max(width, height));
  if (scale === 1 && buf.length < 150 * 1024) return { width, height, thumb: null }; // already small
  const small = scale < 1 ? shrink(img, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))) : img;
  let transparent = false;
  for (let i = 3; i < small.data.length; i += 4) if (small.data[i] < 250) { transparent = true; break; }
  if (transparent) {
    const png = new PNG({ width: small.width, height: small.height });
    png.data = Buffer.from(small.data.buffer, small.data.byteOffset, small.data.length);
    return { width, height, thumb: { buf: PNG.sync.write(png, { deflateLevel: 9 }), type: 'image/png' } };
  }
  const enc = jpeg.encode({ width: small.width, height: small.height, data: small.data }, 82);
  return { width, height, thumb: { buf: Buffer.from(enc.data), type: 'image/jpeg' } };
}

const nameFrom = (url, type) => {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last.slice(0, 200);
  } catch {}
  return `file${type === 'image/png' ? '.png' : type === 'image/jpeg' ? '.jpg' : ''}`;
};

/** Store bytes (deduplicated by content) and make the thumbnail. */
async function storeBytes(ctx, workspaceId, { buf, contentType, name, key, sourceUrl, storageId = null }) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const existing = await ctx.runQuery(internal.files.byHash, { workspaceId, sha256 });
  if (existing) {
    if (storageId && storageId !== existing.storageId) await ctx.storage.delete(storageId); // same content uploaded again
    if (key && existing.key !== key) await ctx.runMutation(internal.files.setKey, { id: existing.id, key });
    return { ...existing.out, name: name || existing.out.name, reused: true };
  }
  const type = sniff(buf) || contentType || 'application/octet-stream';
  const sid = storageId || (await ctx.storage.store(new Blob([buf], { type })));
  const t = /^image\/(png|jpeg)$/.test(type) ? thumbnail(buf, type) : null;
  const thumbId = t?.thumb ? await ctx.storage.store(new Blob([t.thumb.buf], { type: t.thumb.type })) : null;
  const out = await ctx.runMutation(internal.files.insert, {
    workspaceId,
    storageId: sid,
    thumbId,
    sha256,
    key: key || null,
    name: String(name || nameFrom(sourceUrl || '', type)).slice(0, 200),
    size: buf.length,
    contentType: type,
    width: t?.width ?? null,
    height: t?.height ?? null,
    sourceUrl: sourceUrl || null,
  });
  return { ...out, reused: false };
}

async function importOne(ctx, workspaceId, f) {
  const key = f.key ? String(f.key).slice(0, 200) : null;
  if (key) {
    const hit = await ctx.runQuery(internal.files.byKey, { workspaceId, key });
    if (hit) return { ...hit, name: f.name || hit.name, reused: true };
  }
  let buf, contentType;
  if (f.data_base64 || f.dataBase64) {
    buf = Buffer.from(String(f.data_base64 || f.dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw problem('data_base64 is empty');
    if (buf.length > MAX_BYTES) throw problem('Files are limited to 20 MB');
    contentType = f.content_type || f.contentType || null;
  } else if (f.url) {
    ({ buf, contentType } = await download(String(f.url)));
  } else throw problem('Each file needs a url or data_base64');
  return storeBytes(ctx, workspaceId, { buf, contentType, name: f.name, key, sourceUrl: f.url ? String(f.url).split('?')[0] : null });
}

/** Agents (via convex/http.js): import up to 50 files; results per index. */
export const importForAgent = internalAction({
  args: { token: v.string(), files: v.any() },
  handler: async (ctx, { token, files }) => {
    const workspaceId = await ctx.runQuery(internal.agent.tokenWorkspace, { token });
    if (!workspaceId) throw new Error('Invalid or revoked agent token');
    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw new Error('Pass at least one file');
    if (list.length > MAX_PER_CALL) throw new Error(`At most ${MAX_PER_CALL} files per call`);
    const results = [];
    for (const [index, f] of list.entries()) {
      try {
        results.push({ index, ok: true, ...(await importOne(ctx, workspaceId, f || {})) });
      } catch (err) {
        if (!err.expected) console.error('import failed', err);
        results.push({ index, ok: false, error: err.expected ? err.message : `Import failed: ${err.message}` });
      }
    }
    return results;
  },
});

/** Browser uploads: after POSTing to the upload URL, store the file record and its thumbnail. */
export const finishUpload = action({
  args: { session: v.string(), workspaceId: v.id('workspaces'), storageId: v.id('_storage'), name: v.string() },
  handler: async (ctx, { session, workspaceId, storageId, name }) => {
    const meta = await ctx.runQuery(internal.files.checkUpload, { session, workspaceId, storageId });
    if (meta.size > MAX_BYTES) {
      await ctx.storage.delete(storageId);
      throw new Error('Files are limited to 20 MB');
    }
    const blob = await ctx.storage.get(storageId);
    const buf = Buffer.from(await blob.arrayBuffer());
    const out = await storeBytes(ctx, workspaceId, { buf, contentType: meta.contentType, name, storageId });
    return { name: out.name, url: out.url, thumbnail: out.thumbnail, storageId: out.storageId, size: out.size };
  },
});
