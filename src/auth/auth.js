import { API_BASE } from '../ui/tabs.js';

let supabase = null;
let currentSession = null;

async function getSupabase() {
  if (supabase) return supabase;

  const res = await fetch(`${API_BASE}/api/config`);
  const config = await res.json();

  const { createClient } = window.supabase || {};
  if (!createClient) {
    throw new Error('Supabase client non caricato');
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storage: localStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  });

  const { data: { session } } = await supabase.auth.getSession();
  currentSession = session;

  supabase.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
  });

  return supabase;
}

function getAccessToken() {
  return currentSession?.access_token || null;
}

async function login(email, password) {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  currentSession = data.session;
  return data.user;
}

async function register(email, password, name) {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw new Error(error.message);
  if (data.session) currentSession = data.session;
  return data.user;
}

async function logout() {
  currentSession = null;
  try {
    const sb = supabase;
    if (sb) await sb.auth.signOut();
  } catch (_) {}
}

async function getUser() {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch (_) {
    return null;
  }
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
      const user = await login(email, password);
      hideLoginOverlay();
      document.dispatchEvent(new CustomEvent('auth:login', { detail: user }));
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
      const user = await register(email, password, name);
      if (user) {
        hideLoginOverlay();
        document.dispatchEvent(new CustomEvent('auth:login', { detail: user }));
      } else {
        registerError.textContent = 'Controlla la tua email per confermare la registrazione.';
      }
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
    await logout();
    showLoginOverlay();
    document.dispatchEvent(new CustomEvent('auth:logout'));
  });
  headerRight.appendChild(btn);
}

async function init() {
  initAuthUI();
  addLogoutButton();

  try {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      currentSession = session;
      hideLoginOverlay();
      return;
    }
  } catch (_) {}

  showLoginOverlay();
}

export { init, getAccessToken, getUser, logout, showLoginOverlay, hideLoginOverlay };
