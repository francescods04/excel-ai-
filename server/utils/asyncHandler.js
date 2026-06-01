/**
 * Async error wrapper for Express handlers.
 * Usage: app.get('/foo', asyncHandler(async (req, res) => { ... }))
 * Catches thrown errors and forwards to next() so the global error handler can deal with them.
 */
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
