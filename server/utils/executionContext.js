const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithExecutionContext(context, fn) {
  const parent = storage.getStore() || {};
  return storage.run({ ...parent, ...(context || {}) }, fn);
}

function getExecutionContext() {
  return storage.getStore() || {};
}

module.exports = {
  runWithExecutionContext,
  getExecutionContext,
};
