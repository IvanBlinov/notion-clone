// Login / sign-up / accept-invite screens shown before the workspace loads.
import { cx, query, mutation, action, session } from './backend.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const goHome = () => {
  location.hash = '';
  location.reload();
};

function shell(inner) {
  document.getElementById('app').hidden = true;
  let el = document.getElementById('auth');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auth';
    document.body.prepend(el);
  }
  el.innerHTML = `<div class="auth-card"><div class="auth-logo">N</div>${inner}</div>`;
  return el;
}

/** Inviting screen header, if an invite token is present. */
async function inviteHeader(token) {
  if (!token) return { html: '', info: null };
  const info = await query(cx.workspaces.inviteInfo, { token });
  if (!info.valid) {
    return { html: `<div class="auth-note error">${esc(info.reason || 'This invite link is not valid.')}</div>`, info: null };
  }
  return {
    info,
    html: `<div class="auth-invite"><b>${esc(info.invitedBy)}</b> invited you to join<div class="auth-ws">${esc(info.workspace.name)}</div></div>`,
  };
}

export async function renderAuth({ inviteToken = null } = {}) {
  const status = await query(cx.auth.status, {});
  const { html: inviteHtml, info } = await inviteHeader(inviteToken);
  const canSignup = status.openSignup || !!info;
  let mode = !status.hasUsers || (info && !info.email) ? 'signup' : info ? 'signup' : 'login';

  const render = () => {
    const signup = mode === 'signup';
    const el = shell(`
      ${inviteHtml}
      <h1>${signup ? (status.hasUsers ? 'Create your account' : 'Set up your workspace') : 'Log in'}</h1>
      ${!status.hasUsers ? '<p class="auth-sub">You are the first user — your account will own the existing workspace.</p>' : ''}
      <form class="auth-form">
        ${signup ? '<label>Name<input name="name" autocomplete="name" required></label>' : ''}
        <label>Email<input name="email" type="email" autocomplete="email" required value="${esc(info?.email || '')}" ${info?.email ? 'readonly' : ''}></label>
        <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 8 : 1}" required></label>
        <div class="auth-error" hidden></div>
        <button class="auth-btn" type="submit">${signup ? (info ? 'Create account & join' : 'Create account') : info ? 'Log in & join' : 'Log in'}</button>
      </form>
      <div class="auth-switch">
        ${
          signup
            ? status.hasUsers
              ? 'Already have an account? <a href="#" data-mode="login">Log in</a>'
              : ''
            : canSignup
              ? 'New here? <a href="#" data-mode="signup">Create an account</a>'
              : '<span>Sign-up is by invitation only.</span>'
        }
      </div>`);
    el.querySelector('[data-mode]')?.addEventListener('click', (e) => {
      e.preventDefault();
      mode = e.target.dataset.mode;
      render();
    });
    const form = el.querySelector('form');
    form.querySelector('input:not([readonly])')?.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('button');
      const errEl = form.querySelector('.auth-error');
      btn.disabled = true;
      errEl.hidden = true;
      try {
        const args = { email: data.email, password: data.password, inviteToken: info ? inviteToken : undefined };
        const r = signup ? await action(cx.authNode.signUp, { ...args, name: data.name }) : await action(cx.authNode.logIn, args);
        session.set(r.session);
        if (info) localStorage.setItem('ws', info.workspace.id);
        goHome();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
      }
    });
  };
  render();
}

/** Logged-in user opening an invite link. */
export async function renderAcceptInvite(token, me) {
  const { html, info } = await inviteHeader(token);
  const already = info && me.workspaces.some((w) => w.id === info.workspace.id);
  const el = shell(`
    ${html}
    ${
      info
        ? already
          ? `<p class="auth-sub">You're already a member of this workspace.</p><button class="auth-btn" data-go>Open workspace</button>`
          : `<p class="auth-sub">Signed in as ${esc(me.user.email)}</p><div class="auth-error" hidden></div><button class="auth-btn" data-accept>Join workspace</button>`
        : '<button class="auth-btn" data-home>Go to my workspace</button>'
    }
    <div class="auth-switch"><a href="#" data-logout>Use a different account</a></div>`);
  el.querySelector('[data-home]')?.addEventListener('click', goHome);
  el.querySelector('[data-go]')?.addEventListener('click', () => {
    localStorage.setItem('ws', info.workspace.id);
    goHome();
  });
  el.querySelector('[data-accept]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await mutation(cx.workspaces.accept, { session: session.get(), token });
      localStorage.setItem('ws', info.workspace.id);
      goHome();
    } catch (err) {
      const errEl = el.querySelector('.auth-error');
      errEl.textContent = err.message;
      errEl.hidden = false;
      e.target.disabled = false;
    }
  });
  el.querySelector('[data-logout]').addEventListener('click', async (e) => {
    e.preventDefault();
    await mutation(cx.auth.logOut, { session: session.get() }).catch(() => {});
    session.clear();
    location.reload();
  });
}
