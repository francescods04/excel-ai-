import { API_BASE } from '../ui/tabs.js';

const STORAGE_KEY_TOKEN = 'excelai_access_token';
const STORAGE_KEY_REFRESH = 'excelai_refresh_token';
const STORAGE_KEY_USER = 'excelai_user';

let currentUser = null;

function getAccessToken() {
  return localStorage.getItem(STORAGE_KEY_TOKEN);
}

function getRefreshToken() {
  return localStorage.getItem(STORAGE_KEY_REFRESH);
}

function getUser() {
  if (currentUser) return currentUser;
  const raw = localStorage.getItem(STORAGE_KEY_USER);
  if (raw) {
    try { currentUser = JSON.parse(raw); } catch (_) {}
  }
  return currentUser;
}

function saveTokens(accessToken, refreshToken, user) {
  localStorage.setItem(STORAGE_KEY_TOKEN, accessToken);
  localStorage.setItem(STORAGE_KEY_REFRESH, refreshToken);
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  currentUser = user;
}

function clearTokens() {
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_REFRESH);
  localStorage.removeItem(STORAGE_KEY_USER);
  currentUser = null;
}

async function authFetch(url, options = {}) {
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getAccessToken()}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  return res;
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) { clearTokens(); return false; }
    const data = await res.json();
    localStorage.setItem(STORAGE_KEY_TOKEN, data.accessToken);
    localStorage.setItem(STORAGE_KEY_REFRESH, data.refreshToken);
    return true;
  } catch (_) {
    clearTokens();
    return false;
  }
}

async function apiCall(method, path, body = null) {
  const token = getAccessToken();
  const headers = token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  let res = await fetch(`${API_BASE}${path}`, options);

  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getAccessToken()}`;
      options.headers = headers;
      res = await fetch(`${API_BASE}${path}`, options);
    }
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Errore API');
  return data;
}

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').style.display = '';
}

function initAuthUI() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const loginError = document.getElementById('login-error');
  const registerError = document.getElementById('register-error');

  document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const formId = tab.dataset.form;
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      document.getElementById(formId).classList.add('active');
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login fallito');
      saveTokens(data.accessToken, data.refreshToken, data.user);
      hideLoginOverlay();
      document.dispatchEvent(new CustomEvent('auth:login', { detail: data.user }));
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.textContent = '';
    const name = document.getElementById('register-name').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;

    if (password.length < 6) {
      registerError.textContent = 'Password minima 6 caratteri';
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registrazione fallita');
      saveTokens(data.accessToken, data.refreshToken, data.user);
      hideLoginOverlay();
      document.dispatchEvent(new CustomEvent('auth:login', { detail: data.user }));
    } catch (err) {
      registerError.textContent = err.message;
    }
  });
}

function addLogoutButton() {
  const headerRight = document.getElementById('header-right');
  if (!headerRight) return;
  const btn = document.createElement('button');
  btn.id = 'logout-btn';
  btn.textContent = 'Esci';
  btn.addEventListener('click', async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch (_) {}
    }
    clearTokens();
    showLoginOverlay();
    document.dispatchEvent(new CustomEvent('auth:logout'));
  });
  headerRight.appendChild(btn);
}

function init() {
  initAuthUI();
  addLogoutButton();

  const token = getAccessToken();
  if (token) {
    hideLoginOverlay();
  } else {
    showLoginOverlay();
  }
}

export { init, getAccessToken, getUser, apiCall, clearTokens, showLoginOverlay, hideLoginOverlay };
