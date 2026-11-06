// The browser's connection to the Convex backend. Loaded after vendor/convex.js and config.js.
const { ConvexClient, anyApi } = window.convex;
const config = window.NOTION_CONFIG || {};
if (!config.convexUrl) document.body.innerHTML = '<p style="padding:24px;font-family:sans-serif">Missing config.js — run <code>npm run build</code>.</p>';

export const client = new ConvexClient(config.convexUrl);
export const cx = anyApi;
export const siteUrl = config.siteUrl;
export const mcpUrl = `${config.siteUrl}/mcp`;

export const session = {
  get: () => localStorage.getItem('session') || '',
  set: (t) => localStorage.setItem('session', t),
  clear: () => localStorage.removeItem('session'),
};

/** ConvexError → Error with .status (and .page for save conflicts). */
export function toError(e) {
  const d = e?.data;
  if (d && typeof d === 'object' && d.message) return Object.assign(new Error(d.message), { status: d.status, page: d.page });
  return e instanceof Error ? e : new Error(String(e));
}
const wrap = (p) =>
  p.catch((e) => {
    const err = toError(e);
    if (err.status === 401 && session.get()) {
      session.clear(); // session expired or logged out elsewhere
      location.reload();
    }
    throw err;
  });

export const query = (fn, args = {}) => wrap(client.query(fn, args));
export const mutation = (fn, args = {}) => wrap(client.mutation(fn, args));
export const action = (fn, args = {}) => wrap(client.action(fn, args));

/** Live query. Returns an unsubscribe function. */
export function watch(fn, args, onValue, onError = () => {}) {
  return client.onUpdate(fn, args, onValue, (e) => onError(toError(e)));
}

/** Links that open the app on a given route, wherever it is hosted (e.g. GitHub Pages sub-path). */
export const appUrl = (hashRoute) => `${location.origin}${location.pathname}#/${hashRoute}`;
export const inviteUrl = (token) => appUrl(`invite/${token}`);
