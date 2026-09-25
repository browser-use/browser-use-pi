import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../dist/browser.js';
import { BrowserRuntime } from '../dist/runtime.js';

test('bu.fetch and map remote mode go through the host fetch service; disabled without it', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { url } = JSON.parse(body);
      seen.push(url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(url.includes('blocked')
        ? { status_code: 429, body: 'slow', headers: {} }
        : { status_code: 200, body: `<title>${url}</title>ok`, headers: { 'Content-Type': ['text/html'] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proxy = `http://127.0.0.1:${server.address().port}/fetchuse`;
  const workspace = await mkdtemp(join(tmpdir(), 'pi-ax-fetch-'));
  const browser = await openBrowser({ headless: true, channel: 'chrome' });
  const runtime = new BrowserRuntime({ semantic: true, ax: { fetchProxy: proxy }, endpoint: browser.endpoint, workspace, operationTimeoutMs: 5000, maxOutputChars: 12000 });
  try {
    await runtime.initialize();
    const one = await runtime.execute(`(await bu.fetch('https://a.example/x')).status`, 20000);
    assert.match(one.text, /\[fetch\] https:\/\/a.example\/x -> 200 text\/html/);
    const many = await runtime.execute(`const r = await bu.map(['https://a.example/1','https://b.example/blocked'], (t,{status}) => ({status, ok: t.includes('ok')}), {mode:'remote', retries: 0}); JSON.stringify(r.map(x=>[x.ok,x.status]))`, 20000);
    assert.match(many.text, /\[\[true,200\],\[false,429\]\]/);
    assert.deepEqual(seen.slice(0, 1), ['https://a.example/x']);
  } finally {
    await runtime.close();
    await browser.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
  const workspace2 = await mkdtemp(join(tmpdir(), 'pi-ax-fetch-'));
  const browser2 = await openBrowser({ headless: true, channel: 'chrome' });
  const off = new BrowserRuntime({ semantic: true, endpoint: browser2.endpoint, workspace: workspace2, operationTimeoutMs: 5000, maxOutputChars: 12000 });
  try {
    await off.initialize();
    await assert.rejects(off.execute(`await bu.fetch('https://a.example')`, 10000), /not enabled/);
  } finally {
    await off.close();
    await browser2.close();
    await rm(workspace2, { recursive: true, force: true });
  }
});
