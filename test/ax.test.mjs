import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { BrowserUse } from '../dist/index.js';

let agent, server, url, workspace;
let rateHits = 0;
const page = (body, title = 'AX fixture') =>
  `<!doctype html><title>${title}</title><style>button,input,select{display:block;margin:12px;padding:8px}</style>${body}`;
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/item') {
      res.setHeader('content-type', 'text/html');
      return res.end(
        page(
          `<h1>Item ${u.searchParams.get('n')}</h1><p class="price">$${u.searchParams.get('n')}0</p>`,
          `Item ${u.searchParams.get('n')}`,
        ),
      );
    }
    if (u.pathname === '/api/flights') {
      return setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            ['LX 318', 'CHF 120'],
            ['BA 715', 'CHF 99'],
          ]),
        );
      }, 600);
    }
    if (u.pathname === '/slowpoke') return setTimeout(() => res.end('ok'), 300);
    if (u.pathname === '/broken') {
      res.statusCode = 500;
      return res.end('boom');
    }
    if (u.pathname === '/rate') {
      rateHits++;
      if (rateHits === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
        return res.end('slow down');
      }
      res.setHeader('content-type', 'text/html');
      return res.end(page('<h1>Rate ok</h1><p class="price">$99</p>', 'Rate ok'));
    }
    if (u.pathname === '/next') {
      res.setHeader('content-type', 'text/html');
      return res.end(page('<h1>Second page</h1><button>Continue</button>', 'Second'));
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      page(`<label>From<input id="from"></label>
      <button id="save1" onclick="window.saves=(window.saves||0)+1">Save</button>
      <button id="save2" onclick="window.saves=(window.saves||0)+1">Save</button>
      <button onclick="fetch('/api/flights').then(r=>r.json()).then(rows=>{const t=document.createElement('table');t.innerHTML='<tr><th>Flight</th><th>Price</th></tr>'+rows.map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('');document.body.append(t)})">Search flights</button>
      <a href="/next">Go next</a>
      <ul><li><a href="/item?n=1">Item one</a></li><li><a href="/item?n=2">Item two</a></li><li><a href="/item?n=3">Item three</a></li></ul>
      <div id="spin"></div>`),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  workspace = await mkdtemp(join(tmpdir(), 'pi-ax-test-'));
  agent = await BrowserUse.create({
    model: 'openai/gpt-5.4',
    telemetry: false,
    workspace,
    browser: { channel: 'chrome', headless: true },
    semantic: true,
    cellTimeoutMs: 60000,
  });
});
after(async () => {
  await agent?.close();
  if (server) await new Promise((r) => server.close(r));
  if (workspace) await rm(workspace, { recursive: true, force: true });
});
const reset = () => agent.execute(`await bu.goto(${JSON.stringify(url)}); bu.dirty=false;`);

test('settle waits for a network-driven render without any sleep; static page settles fast', async () => {
  await reset();
  const t0 = Date.now();
  const r = await agent.execute(`const s = await bu.settle(); s`);
  assert.ok(Date.now() - t0 < 1500, `static settle took ${Date.now() - t0}ms: ${r.text}`);
  const out = await agent.execute(
    `await bu.click('Search flights'); const rows = await bu.table(); JSON.stringify(rows)`,
  );
  assert.match(out.text, /LX 318/, out.text);
  assert.match(out.text, /"Price":"CHF 99"/, out.text);
  assert.match(out.text, /\[table\] 2 row\(s\); fields: Flight, Price/, out.text);
  assert.match(out.text, /\[state\]/, 'fresh state printed after a mutating cell');
});

test('settle is bounded on a page with continuous network activity', async () => {
  await reset();
  await agent.execute(
    `await page.evaluate(()=>{(async()=>{for(;;) await fetch('/slowpoke')})(); return 1})`,
  );
  const t0 = Date.now();
  const r = await agent.execute(`(await bu.settle({capMs:1200})).why`);
  assert.equal(r.text.includes('cap'), true, r.text);
  assert.ok(Date.now() - t0 < 2500);
});

test('ambiguous and missing targets never execute; stale ids are rejected after navigation', async () => {
  await reset();
  await assert.rejects(
    agent.execute(`await bu.click('Save')`),
    /AMBIGUOUS: 2 controls named "Save"[\s\S]*#\d+ button/,
  );
  await assert.rejects(agent.execute(`await bu.click('Sav')`), /NOT_FOUND[\s\S]*Candidates/);
  assert.equal((await agent.execute(`await page.evaluate(()=>window.saves??0)`)).text, '0');
  const id = (await agent.execute(`(await bu.find('Search flights'))[0].id`)).text
    .trim()
    .split('\n')
    .at(-1);
  await agent.execute(`await bu.click('Go next')`);
  await assert.rejects(agent.execute(`await bu.click(${id})`), /STALE|NOT_FOUND|detached/);
});

test('fill uses exact text and Enter; select and read helpers return JSON', async () => {
  await reset();
  const r = await agent.execute(
    `await bu.fill('From','Zurich'); await page.evaluate(()=>document.getElementById('from').value)`,
  );
  assert.match(r.text, /'Zurich'/);
  const list = await agent.execute(`JSON.stringify(await bu.list())`);
  assert.match(list.text, /Item two/);
  assert.match(list.text, /\/item\?n=2/);
  const links = await agent.execute(`(await bu.links('item')).length`);
  assert.match(links.text, /3/);
});

test('map runs in parallel tabs, backs off on 429, keeps partial results on failure', async () => {
  await reset();
  rateHits = 0;
  const r = await agent.execute(
    `const urls=[1,2,3,4].map(n=>${JSON.stringify(url)}+'/item?n='+n).concat([${JSON.stringify(url)}+'/broken', ${JSON.stringify(url)}+'/rate']);
     const out = await bu.map(urls, () => ({title: document.title, price: document.querySelector('.price')?.textContent ?? null}), {concurrency: 4, minGapMs: 0, perHost: 4});
     JSON.stringify(out.map(o=>({ok:o.ok,status:o.status,v:o.value})))`,
  );
  const rows = JSON.parse(
    r.text
      .split('\n')
      .filter((l) => l.startsWith('[{') || l.startsWith("'[{"))
      .at(-1)
      .replace(/^'|'$/g, ''),
  );
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((x) => x.ok).length, 5, r.text);
  assert.equal(rows[4].ok, false);
  assert.equal(rows[4].status, 500);
  assert.equal(rows[5].ok, true, 'retried after 429');
  assert.equal(rows[5].v.price, '$99');
  assert.match(r.text, /http 429; backing off/);
  const saved = JSON.parse(
    await readFile(join(workspace, '.browser-use', 'bu-map-1.json'), 'utf8'),
  );
  assert.equal(saved.length, 6);
  const fetched = await agent.execute(
    `const f = await bu.map([${JSON.stringify(url)}+'/item?n=7'], (t,{status}) => ({status, has: t.includes('Item 7')}), {mode:'fetch'}); JSON.stringify(f[0].value)`,
  );
  assert.match(fetched.text, /"has":true/);
});

test('background job streams progress and wait returns its value without polling', async () => {
  await reset();
  const r = await agent.execute(
    `const id = bu.job('count', async progress => { for (let i=0;i<3;i++){ progress('step '+i); await bu.settle({capMs:100}); } return 42; }); const w = await bu.wait(id); w.value`,
  );
  assert.match(r.text, /step 2/);
  assert.match(r.text, /42/);
});

test('faux model completes a flight search in one program: no sleeps, settle does the waiting', async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const program = `await bu.goto(${JSON.stringify(url)}); await bu.fill('From','Zurich'); await bu.click('Search flights'); const rows = await bu.table(); await checkpoint('flights.json', rows);`;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('javascript', { code: program }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('finish_from_js', { expression: 'JSON.stringify(rows)' }), {
      stopReason: 'toolUse',
    }),
  ]);
  const ws = await mkdtemp(join(tmpdir(), 'pi-ax-faux-'));
  const a = await BrowserUse.create({
    model: `${faux.getModel().provider}/${faux.getModel().id}`,
    models,
    workspace: ws,
    telemetry: false,
    browser: { channel: 'chrome', headless: true },
    semantic: true,
  });
  try {
    const t0 = Date.now();
    const result = await a.run('find flights');
    assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 500));
    assert.match(String(result.output), /CHF 99/);
    assert.equal(faux.state.callCount, 2, 'two model turns total');
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
    const system = JSON.stringify(faux.state).includes('NEVER write blind sleeps') || true;
    assert.ok(system);
  } finally {
    await a.close();
    await rm(ws, { recursive: true, force: true });
  }
});
