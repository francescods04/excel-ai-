const { getSupabase } = require('../supabase/client');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query?.token || null;

  if (!token) {
    return res.status(401).json({ error: 'Token mancante' });
  }

  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Token non valido o scaduto', code: 'TOKEN_EXPIRED' });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    req.userPlan = user.app_metadata?.plan || 'free';
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Errore di autenticazione' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query?.token || null;

  if (!token) return next();

  getSupabase().auth.getUser(token).then(({ data: { user }, error }) => {
    if (!error && user) {
      req.userId = user.id;
      req.userEmail = user.email;
      req.userPlan = user.app_metadata?.plan || 'free';
    }
    next();
  }).catch(() => next());
}

function requirePlan(plan) {
  return (req, res, next) => {
    if (req.userPlan !== plan && req.userPlan !== 'admin') {
      return res.status(403).json({ error: `Piano ${plan} richiesto` });
    }
    next();
  };
}

async function quotaCheck(req, res, next) {
  // Dev/admin bypass
  if (process.env.DISABLE_QUOTA === 'true') return next();
  if (req.userPlan === 'admin') return next();

  try {
    const supabase = getSupabase();

    const { data: quotaData } = await supabase
      .rpc('get_user_quota', { uid: req.userId })
      .single();

    const dailyQuota = quotaData?.daily_limit || 10;

    const { count: turnsToday } = await supabase
      .from('turns')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .gte('created_at', new Date().toISOString().slice(0, 10));

    if (turnsToday >= dailyQuota) {
      return res.status(429).json({ error: 'Quota giornaliera esaurita', quota: dailyQuota, used: turnsToday });
    }

    req.dailyQuota = dailyQuota;
    req.turnsUsedToday = turnsToday;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Errore verifica quota' });
  }
}

module.exports = { authenticate, optionalAuth, requirePlan, quotaCheck };
