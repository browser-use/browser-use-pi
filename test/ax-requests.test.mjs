import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../dist/browser.js';
import { BrowserRuntime } from '../dist/runtime.js';

test('bu.requests lists the JSON API a page loaded, so it can be fetched directly', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/series')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ weeks: [1, 2, 3] }));
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><title>chart</title><div id=c></div><script>fetch('/api/series?q=snail').then(r=>r.json()).then(d=>document.getElementById('c').textContent=d.weeks.join(','))</script>`,
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const workspace = await mkdtemp(join(tmpdir(), 'pi-ax-req-'));
  const browser = await openBrowser({ headless: true, channel: 'chrome' });
  const runtime = new BrowserRuntime({
    semantic: true,
    ax: { trackEarly: true },
    endpoint: browser.endpoint,
    workspace,
    operationTimeoutMs: 5000,
    maxOutputChars: 20000,
  });
  try {
    await runtime.initialize();
    await runtime.execute(`await bu.goto(${JSON.stringify(url)})`, 20000);
    const r = await runtime.execute(
      `const reqs = await bu.requests('api'); JSON.stringify(reqs)`,
      20000,
    );
    assert.match(r.text, /\/api\/series\?q=snail/);
    assert.match(r.text, /"status":200/);
    assert.match(r.text, /application\/json/);
  } finally {
    await runtime.close();
    await browser.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
