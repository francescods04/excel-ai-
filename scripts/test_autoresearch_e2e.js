const http = require('http');
const fs = require('fs');

const raw = JSON.parse(fs.readFileSync('/tmp/autoresearch_input.json', 'utf-8'));
const input = {
  message: raw.objective,
  context: raw.context,
  modelOverride: null,
  data: raw.data
};

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/codefirst/autoresearch/start',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    fs.writeFileSync('/tmp/autoresearch_result_v2.json', data);
    console.log('Saved to /tmp/autoresearch_result_v2.json');
    try {
      const j = JSON.parse(data);
      console.log('Result:', JSON.stringify({
        status: j.status,
        cellCount: j.cellCount,
        iterations: j.iterations,
        converged: j.converged,
        lastScore: j.lastScore,
        totalMs: j.totalMs,
      }, null, 2));
    } catch (e) {
      console.log('Raw first 500 chars:', data.slice(0, 500));
    }
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.write(JSON.stringify(input));
req.end();
