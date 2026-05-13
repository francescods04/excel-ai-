'use strict';

const fs = require('fs');
const path = require('path');

const DEV_BASE_URL = 'http://localhost:3000';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function normalizeBaseUrl(rawBaseUrl, options = {}) {
  if (!rawBaseUrl || typeof rawBaseUrl !== 'string') {
    throw new Error('Missing production base URL. Set ADDIN_BASE_URL or pass --base-url.');
  }

  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`Invalid ADDIN_BASE_URL: ${rawBaseUrl}`);
  }

  if (parsed.protocol !== 'https:' && !options.allowHttp) {
    throw new Error('Production manifest requires an HTTPS ADDIN_BASE_URL.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function buildProductionManifest(xml, rawBaseUrl, options = {}) {
  const baseUrl = normalizeBaseUrl(rawBaseUrl, options);
  const origin = new URL(baseUrl).origin;
  let output = xml.replaceAll(DEV_BASE_URL, baseUrl);

  // Office AppDomain entries must be origins, not taskpane subpaths.
  output = output.replace(
    new RegExp(`<AppDomain>${escapeRegExp(baseUrl)}</AppDomain>`, 'g'),
    `<AppDomain>${origin}</AppDomain>`
  );

  if (output.includes(DEV_BASE_URL) || output.includes('localhost')) {
    throw new Error('Production manifest still contains localhost references.');
  }
  return output;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const inputPath = path.resolve(rootDir, args.input || 'manifest.xml');
  const outputPath = path.resolve(rootDir, args.out || path.join('dist', 'manifest.xml'));
  const baseUrl = args['base-url'] || process.env.ADDIN_BASE_URL;

  const xml = fs.readFileSync(inputPath, 'utf8');
  const manifest = buildProductionManifest(xml, baseUrl, {
    allowHttp: args['allow-http'] === true || process.env.ALLOW_HTTP_MANIFEST === 'true'
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, manifest);
  console.log(`Production manifest written to ${path.relative(rootDir, outputPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  buildProductionManifest,
  normalizeBaseUrl,
  parseArgs
};
