'use node';
// Password hashing needs real crypto (scrypt), so sign-up / log-in run as Node actions.
import crypto from 'node:crypto';
import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { fail, normEmail, validEmail } from './lib/util.js';

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const signUp = action({
  args: { name: v.string(), email: v.string(), password: v.string(), inviteToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const name = a.name.trim().slice(0, 60);
    const email = normEmail(a.email);
    if (!name) fail(400, 'Please enter your name');
    if (!validEmail(email)) fail(400, 'Please enter a valid email');
    if (a.password.length < 8) fail(400, 'Password must be at least 8 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    const session = newToken();
    const user = await ctx.runMutation(internal.auth.createAccount, {
      name,
      email,
      salt,
      passwordHash: hash(a.password, salt),
      sessionHash: sha256(session),
      inviteToken: a.inviteToken,
    });
    return { session, user };
  },
});

export const logIn = action({
  args: { email: v.string(), password: v.string(), inviteToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const cred = await ctx.runQuery(internal.auth.credentials, { email: normEmail(a.email) });
    if (cred?.lockedUntil && cred.lockedUntil > Date.now()) fail(429, 'Too many failed attempts. Try again in a few minutes.');
    const ok = cred && crypto.timingSafeEqual(Buffer.from(hash(a.password, cred.salt), 'hex'), Buffer.from(cred.passwordHash, 'hex'));
    if (!ok) {
      if (cred) await ctx.runMutation(internal.auth.recordFailure, { userId: cred.userId });
      fail(401, 'Wrong email or password');
    }
    const session = newToken();
    const user = await ctx.runMutation(internal.auth.createSession, { userId: cred.userId, sessionHash: sha256(session) });
    if (a.inviteToken) await ctx.runMutation(internal.workspaces.acceptInviteFor, { userId: cred.userId, token: a.inviteToken });
    return { session, user };
  },
});
