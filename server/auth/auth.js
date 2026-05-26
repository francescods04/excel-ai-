const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { getDb } = require('../db/init');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const secret = crypto.randomBytes(64).toString('hex');
  logger.warn('[Auth] JWT_SECRET non configurato, generato temporaneo. Impostalo come variabile d\'ambiente.');
  return secret;
})();
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateAccessToken(user) {
  return jwt.sign({ userId: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function register(req, res) {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatorie' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minima 6 caratteri' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida' });

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email già registrata' });

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, ?, ?, ?)').run(
      id, email.toLowerCase(), hashPassword(password), name || email.split('@')[0], 'free'
    );

    const user = { id, email: email.toLowerCase(), plan: 'free' };
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000).toISOString();

    db.prepare('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(), id, refreshHash, expiresAt
    );

    logger.info(`[Auth] Nuovo utente: ${email.toLowerCase()}`);
    res.status(201).json({ accessToken, refreshToken, user: { id, email: email.toLowerCase(), plan: 'free' } });
  } catch (err) {
    logger.error(`[Auth] Register error: ${err.message}`);
    res.status(500).json({ error: 'Errore interno' });
  }
}

function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatorie' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Credenziali non valide' });

    if (!comparePassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000).toISOString();

    db.prepare('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(), user.id, refreshHash, expiresAt
    );

    logger.info(`[Auth] Login: ${email.toLowerCase()}`);
    res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    logger.error(`[Auth] Login error: ${err.message}`);
    res.status(500).json({ error: 'Errore interno' });
  }
}

function refresh(req, res) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token richiesto' });

    const db = getDb();
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const session = db.prepare('SELECT * FROM sessions WHERE refresh_token_hash = ?').get(refreshHash);
    if (!session) return res.status(401).json({ error: 'Refresh token non valido' });

    if (new Date(session.expires_at) < new Date()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      return res.status(401).json({ error: 'Refresh token scaduto' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) return res.status(401).json({ error: 'Utente non trovato' });

    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

    const accessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken();
    const newRefreshHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000).toISOString();

    db.prepare('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(), user.id, newRefreshHash, expiresAt
    );

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    logger.error(`[Auth] Refresh error: ${err.message}`);
    res.status(500).json({ error: 'Errore interno' });
  }
}

function logout(req, res) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const db = getDb();
      const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      db.prepare('DELETE FROM sessions WHERE refresh_token_hash = ?').run(refreshHash);
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[Auth] Logout error: ${err.message}`);
    res.status(500).json({ error: 'Errore interno' });
  }
}

function me(req, res) {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, plan, daily_quota, created_at FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });

  const turnsUsed = db.prepare(
    "SELECT COUNT(*) as count FROM turns WHERE user_id = ? AND date(created_at) = date('now')"
  ).get(req.userId).count;

  res.json({ ...user, turns_today: turnsUsed });
}

module.exports = { register, login, refresh, logout, me, verifyAccessToken };
