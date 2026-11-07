import { ConvexError } from 'convex/values';
import { WorkspaceModel } from '../../src/shared/model.js';
import { sha256 } from './sha256.js';

export const DAY = 86400_000;
export const COLORS = ['#e16259', '#d9730d', '#cb912f', '#448361', '#337ea9', '#9065b0', '#c14c8a', '#2e7d7a'];

/** Throw an error the client can read: err.data = { status, message, ... } */
export function fail(status, message, extra = {}) {
  throw new ConvexError({ status, message, ...extra });
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const publicUser = (u) => u && { id: u._id, name: u.name, email: u.email, color: u.color };
/**
 * Who may create an account, from the SIGNUP environment variable (only the deployment's
 * owner can change it, in the Convex dashboard):
 *   unset / "closed" — nobody (default); "invite" — people with an invite link; "open" — anyone.
 * The very first account of a fresh deployment can always be created (it owns the workspace).
 */
export const signupMode = () => {
  const m = String(process.env.SIGNUP || (process.env.OPEN_SIGNUP === 'true' ? 'open' : 'closed')).toLowerCase();
  return ['open', 'invite'].includes(m) ? m : 'closed';
};
export const hasUsers = async (ctx) => !!(await ctx.db.query('users').first());
export const openSignup = async (ctx) => signupMode() === 'open' || !(await hasUsers(ctx));
export const inviteSignup = () => signupMode() !== 'closed';

/** The logged-in user for a session token, or a 401. */
export async function requireUser(ctx, session) {
  if (!session) fail(401, 'Please log in');
  const s = await ctx.db
    .query('sessions')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', sha256(session)))
    .unique();
  if (!s || s.expiresAt < Date.now()) fail(401, 'Please log in');
  const user = await ctx.db.get(s.userId);
  if (!user) fail(401, 'Please log in');
  return user;
}

export async function membership(ctx, workspaceId, userId) {
  return ctx.db
    .query('members')
    .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', userId))
    .unique();
}

export async function requireMember(ctx, workspaceId, userId) {
  const ws = workspaceId && (await ctx.db.get(workspaceId).catch(() => null));
  if (!ws) fail(404, 'Workspace not found');
  const m = await membership(ctx, workspaceId, userId);
  if (!m) fail(403, 'You are not a member of this workspace');
  return { ws, role: m.role };
}

export async function requireOwner(ctx, workspaceId, userId) {
  const r = await requireMember(ctx, workspaceId, userId);
  if (r.role !== 'owner') fail(403, 'Only the workspace owner can do that');
  return r;
}

/**
 * Load a workspace's pages into a WorkspaceModel. Call `commit()` after mutating
 * to write back exactly the pages that changed (all inside the same transaction).
 */
export async function loadWorkspace(ctx, workspaceId) {
  const docs = await ctx.db
    .query('pages')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect();
  const pages = {};
  const rowId = new Map();
  const before = new Map();
  for (const d of docs) {
    const { _id, _creationTime, workspaceId: _ws, pid, ...rest } = d;
    pages[pid] = { id: pid, ...rest };
    rowId.set(pid, _id);
    before.set(pid, JSON.stringify(pages[pid]));
  }
  const model = new WorkspaceModel(pages, await workspaceMembers(ctx, workspaceId));
  async function commit() {
    const now = model.data.pages;
    for (const [pid, p] of Object.entries(now)) {
      const json = JSON.stringify(p);
      if (rowId.has(pid) && before.get(pid) === json) continue;
      const { id, ...fields } = JSON.parse(json); // drops undefined values
      const row = { workspaceId, pid, ...fields };
      if (rowId.has(pid)) await ctx.db.replace(rowId.get(pid), row);
      else await ctx.db.insert('pages', row);
    }
    for (const [pid, id] of rowId) if (!now[pid]) await ctx.db.delete(id);
  }
  return { model, commit };
}

/** Members of a workspace as person properties see them: [{ id, name, email, color, role }]. */
export async function workspaceMembers(ctx, workspaceId) {
  const rows = await ctx.db
    .query('members')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect();
  const out = [];
  for (const m of rows) {
    const u = await ctx.db.get(m.userId);
    if (u) out.push({ id: u._id, name: u.name, email: u.email, color: u.color, role: m.role });
  }
  return out;
}

/** Run a model operation, turning its errors into client-readable ones. */
export function runModel(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConvexError) throw err;
    fail(err.status || 500, err.message, err.page ? { page: err.page } : {});
  }
}

export async function createWorkspaceWithSeed(ctx, userId, name) {
  const id = await ctx.db.insert('workspaces', { name: String(name || 'Workspace').slice(0, 80), ownerId: userId, createdAt: Date.now() });
  await ctx.db.insert('members', { workspaceId: id, userId, role: 'owner', joinedAt: Date.now() });
  const { model, commit } = await loadWorkspace(ctx, id);
  model.seed();
  await commit();
  return id;
}
