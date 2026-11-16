import '../shared/tokens.css';
import './login.css';
import { applyStoredTheme } from '../shared/theme.js';

applyStoredTheme();

function safeNext(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

// If the session cookie exists but wasn't sent (SameSite=Strict on a
// cross-site redirect, e.g. back from Kite), a same-origin fetch will carry
// it. If we're already signed in, continue to where we were going.
void fetch('/api/me', { credentials: 'same-origin' }).then((r) => {
  if (r.ok) location.replace(safeNext());
});

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form') as HTMLFormElement;
  const email = document.getElementById('email') as HTMLInputElement;
  const password = document.getElementById('password') as HTMLInputElement;
  const error = document.getElementById('error') as HTMLParagraphElement;
  const submit = document.getElementById('submit') as HTMLButtonElement;
  email.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!email.value || !password.value) {
      error.textContent = 'Enter your email and password.';
      (email.value ? password : email).focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.value, password: password.value }),
      });
      if (res.ok) {
        location.replace(safeNext());
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      error.textContent = res.status === 429 ? 'Too many attempts. Try again later.' : (body.error ?? 'Sign in failed.');
      password.value = '';
      password.focus();
    } catch {
      error.textContent = 'Network error. Check your connection.';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Continue';
    }
  });
});
