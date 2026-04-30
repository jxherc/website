const API = 'https://api.jxherc.com';

export function getToken() {
  return localStorage.getItem('admin_token');
}

export function requireLogin() {
  if (!getToken()) location.href = 'login.html';
}

export async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res   = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  });
  if (res.status === 401) { localStorage.removeItem('admin_token'); location.href = 'login.html'; }
  return res;
}

export function fmt(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-CA', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

export function msg(el, text, type = 'ok') {
  el.innerHTML = `<div class="msg ${type}">${text}</div>`;
  setTimeout(() => { if (el.textContent === text) el.innerHTML = ''; }, 3000);
}
