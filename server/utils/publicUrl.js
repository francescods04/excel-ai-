'use strict';

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  if (!value) return '';
  return String(value).split(',')[0].trim();
}

function trimBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function explicitPublicUrlFromEnv(env = process.env) {
  return trimBaseUrl(env.PUBLIC_URL || env.ADDIN_BASE_URL);
}

function vercelPublicUrlFromEnv(env = process.env) {
  const vercelUrl = trimBaseUrl(env.VERCEL_URL);
  if (!vercelUrl) return '';
  return /^https?:\/\//i.test(vercelUrl) ? vercelUrl : `https://${vercelUrl}`;
}

function publicUrlFromEnv(env = process.env) {
  const configured = explicitPublicUrlFromEnv(env);
  const vercelUrl = vercelPublicUrlFromEnv(env);
  if (configured && !(isLocalBaseUrl(configured) && vercelUrl)) return configured;
  return vercelUrl || configured;
}

function isLocalBaseUrl(value) {
  try {
    return isLocalHost(new URL(value).host);
  } catch (_) {
    return false;
  }
}

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(host || ''));
}

function inferPublicBaseUrl(req, env = process.env) {
  const headers = req?.headers || {};
  const host = firstHeaderValue(headers['x-forwarded-host']) || firstHeaderValue(headers.host);
  const configured = explicitPublicUrlFromEnv(env);
  const hasPublicHost = host && !isLocalHost(host);
  const configuredIsStaleLocal = isLocalBaseUrl(configured) && hasPublicHost;
  if (configured && !configuredIsStaleLocal) return configured;

  if (!host) return `http://localhost:${env.PORT || 3000}`;

  const proto = firstHeaderValue(headers['x-forwarded-proto'])
    || req?.protocol
    || (isLocalHost(host) ? 'http' : 'https');

  if (hasPublicHost) return trimBaseUrl(`${proto}://${host}`);

  const vercelUrl = vercelPublicUrlFromEnv(env);
  return vercelUrl || trimBaseUrl(`${proto}://${host}`);
}

module.exports = {
  inferPublicBaseUrl,
  publicUrlFromEnv,
  firstHeaderValue
};
