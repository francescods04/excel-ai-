/**
 * Admin-only middleware. Must be used AFTER `authenticate`.
 * Returns 403 if the authenticated user does not have plan='admin'.
 */
module.exports = function requireAdmin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Non autenticato' });
  if (req.userPlan !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};
