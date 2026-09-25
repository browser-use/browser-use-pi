import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from '../dist/browser.js';
import { BrowserRuntime } from '../dist/runtime.js';

test('domLinks returns absolute hrefs for every anchor; readLines widens the printed window', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>k</title><main>${Array.from({ length: 60 }, (_, i) => `<p>Line ${i}</p>`).join('')}
      <div role="presentation"><a href="/notice/abc?p=1"><span>Asset Decarbonisation DPS</span></a></div></main>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const workspace = await mkdtemp(join(tmpdir(), 'pi-ax-knobs-'));
  const browser = await openBrowser({ headless: true, channel: 'chrome' });
  const runtime = new BrowserRuntime({
    semantic: true,
    ax: { domLinks: true, readLines: 80, stamp: true },
    endpoint: browser.endpoint,
    workspace,
    operationTimeoutMs: 5000,
    maxOutputChars: 20000,
  });
  try {
    await runtime.initialize();
    await runtime.execute(`await bu.goto(${JSON.stringify(url)})`, 20000);
    const links = await runtime.execute(`JSON.stringify(await bu.links('notice'))`, 20000);
    assert.match(links.text, /\/notice\/abc\?p=1/);
    assert.match(links.text, /Asset Decarbonisation DPS/);
    const read = await runtime.execute(`(await bu.read()).length`, 20000);
    assert.match(
      read.text,
      /\[read at 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ\]/,
      'stamped observation line',
    );
    assert.match(read.text, /Line 59/, 'wide window prints all 60 lines');
  } finally {
    await runtime.close();
    await browser.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
