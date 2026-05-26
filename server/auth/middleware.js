const { verifyAccessToken } = require('./auth');
const { getDb } = require('../db/init');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' });
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    req.userPlan = payload.plan;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token scaduto', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token non valido' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    req.userPlan = payload.plan;
  } catch (_) {}
  next();
}

function requirePlan(plan) {
  return (req, res, next) => {
    if (req.userPlan !== plan && req.userPlan !== 'admin') {
      return res.status(403).json({ error: `Piano ${plan} richiesto` });
    }
    next();
  };
}

function quotaCheck(req, res, next) {
  const db = getDb();
  const user = db.prepare('SELECT plan, daily_quota FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(401).json({ error: 'Utente non trovato' });

  const turnsToday = db.prepare(
    "SELECT COUNT(*) as count FROM turns WHERE user_id = ? AND date(created_at) = date('now')"
  ).get(req.userId).count;

  if (turnsToday >= user.daily_quota) {
    return res.status(429).json({ error: 'Quota giornaliera esaurita', quota: user.daily_quota, used: turnsToday });
  }

  req.dailyQuota = user.daily_quota;
  req.turnsUsedToday = turnsToday;
  next();
}

module.exports = { authenticate, optionalAuth, requirePlan, quotaCheck };
