// test/unit/test_production_manifest.js
// Verifies production manifest URL rewriting for AppSource-style HTTPS deploys.

const assert = require('assert');
const {
  buildProductionManifest,
  normalizeBaseUrl
} = require('../../scripts/build-production-manifest');
const { inferPublicBaseUrl } = require('../../server/utils/publicUrl');

function test(name, fn) {
  try {
    fn();
    console.log(`OK ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const SAMPLE = `
<OfficeApp>
  <IconUrl DefaultValue="http://localhost:3000/assets/icon-32.png" />
  <HighResolutionIconUrl DefaultValue="http://localhost:3000/assets/icon-80.png" />
  <SupportUrl DefaultValue="http://localhost:3000/support.html" />
  <AppDomains>
    <AppDomain>http://localhost:3000</AppDomain>
  </AppDomains>
  <DefaultSettings>
    <SourceLocation DefaultValue="http://localhost:3000/src/taskpane.html" />
  </DefaultSettings>
</OfficeApp>`;

test('normalizeBaseUrl requires HTTPS by default', () => {
  assert.throws(() => normalizeBaseUrl('http://example.com'), /HTTPS/);
  assert.strictEqual(normalizeBaseUrl('https://example.com/'), 'https://example.com');
});

test('buildProductionManifest rewrites localhost URLs', () => {
  const output = buildProductionManifest(SAMPLE, 'https://excel-ai.example.com');
  assert.ok(output.includes('https://excel-ai.example.com/src/taskpane.html'));
  assert.ok(output.includes('https://excel-ai.example.com/assets/icon-32.png'));
  assert.ok(output.includes('<AppDomain>https://excel-ai.example.com</AppDomain>'));
  assert.ok(!output.includes('localhost'));
});

test('AppDomain stays origin when add-in is hosted under a path', () => {
  const output = buildProductionManifest(SAMPLE, 'https://example.com/excel-ai');
  assert.ok(output.includes('https://example.com/excel-ai/src/taskpane.html'));
  assert.ok(output.includes('<AppDomain>https://example.com</AppDomain>'));
});

test('inferPublicBaseUrl uses forwarded production host when env is absent', () => {
  const output = inferPublicBaseUrl({
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'francescodelsesto.com'
    }
  }, {});
  assert.strictEqual(output, 'https://francescodelsesto.com');
});

test('inferPublicBaseUrl ignores stale localhost env on public host', () => {
  const output = inferPublicBaseUrl({
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'francescodelsesto.com'
    }
  }, { PUBLIC_URL: 'http://localhost:3000' });
  assert.strictEqual(output, 'https://francescodelsesto.com');
});

test('inferPublicBaseUrl prefers Vercel URL when present', () => {
  assert.strictEqual(
    inferPublicBaseUrl({ headers: { host: 'localhost:3000' }, protocol: 'http' }, { VERCEL_URL: 'excel-ai.vercel.app' }),
    'https://excel-ai.vercel.app'
  );
});

test('inferPublicBaseUrl keeps local development on http', () => {
  assert.strictEqual(
    inferPublicBaseUrl({ headers: { host: 'localhost:3000' }, protocol: 'http' }, {}),
    'http://localhost:3000'
  );
});

console.log('\nProduction manifest tests completed.');
