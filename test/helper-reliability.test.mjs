import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { BrowserUse } = await import(process.env.REVIEW_SDK_PATH || '../dist/index.js');
let agent, server, url, profile;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('Ready now'), 1300);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') {
      res.end(
        '<button onclick="top.frameClicks++">Frame action</button><input aria-label="Frame input">',
      );
      return;
    }
    res.end(
      '<!doctype html><style>body{margin:25px;font:16px sans-serif}button,input,select{padding:10px;margin:8px}</style>' +
        '<label><input id="ok" type="checkbox" onclick="window.okClicks++">Normal check</label>' +
        '<label><input id="no" type="checkbox" onclick="event.preventDefault()">Rejected check</label>' +
        '<select aria-label="Disabled country" id="disabled" disabled><option>France</option><option>Canada</option></select>' +
        '<select aria-label="Country" id="country"><option>France</option><option>Canada</option></select>' +
        '<select aria-label="Reverted country" id="reverted" onchange="this.value=\'France\'"><option>France</option><option>Canada</option></select>' +
        '<input aria-label="Readonly field" readonly value="original">' +
        '<button onclick="if(confirm(\'Really delete?\'))window.deleted++">Delete item</button>' +
        '<button onclick="window.afterClicks++">After action</button>' +
        '<button onclick="fetch(\'/slow\').then(r=>r.text()).then(t=>document.querySelector(\'#status\').textContent=t)">Load results</button><p id="status">Not ready</p>' +
        '<script>window.okClicks=0;window.afterClicks=0;window.deleted=0;window.frameClicks=0;window.overlayClicks=0;</script>',
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = 'http://127.0.0.1:' + server.address().port;
  profile = await mkdtemp(join(tmpdir(), 'helper-reliability-'));
  agent = await BrowserUse.create({
    model: 'openai/gpt-6-astra',
    mode: 'ultrafast',
    telemetry: false,
    browser: { executablePath: '/dev/shm/pi-pr15-review-20260926/chromium', profileDir: profile },
    workspace: profile + '/work',
    operationTimeoutMs: 3000,
    cellTimeoutMs: 10000,
  });
});
after(async () => {
  await agent?.close();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const open = () => agent.execute('await bu.goto(' + JSON.stringify(url) + ');void 0');
const value = async (code) => (await agent.execute(code)).text;
test('checkbox true then true is idempotent; false restores state', async () => {
  await open();
  await agent.execute("await bu.check('Normal check',true);await bu.check('Normal check',true);");
  assert.equal(await value('await page.evaluate(()=>window.okClicks)'), '1');
  await agent.execute("await bu.check('Normal check',false)");
  assert.equal(
    await value("await page.evaluate(()=>document.querySelector('#ok').checked)"),
    'false',
  );
});
test('rejected checkbox stops the chain rather than report success', async () => {
  await open();
  await assert.rejects(
    agent.execute("await bu.check('Rejected check',true);await bu.click('After action');"),
    /OUTCOME_NOT_VERIFIED/,
  );
  assert.equal(await value('await page.evaluate(()=>window.afterClicks)'), '0');
});
test('disabled native select cannot change', async () => {
  await open();
  await assert.rejects(agent.execute("await bu.select('Disabled country','Canada')"), /disabled/);
  assert.equal(
    await value("await page.evaluate(()=>document.querySelector('#disabled').value)"),
    "'France'",
  );
});
test('native select verifies application retained selected value', async () => {
  await open();
  await agent.execute("await bu.select('Country','Canada')");
  assert.equal(
    await value("await page.evaluate(()=>document.querySelector('#country').value)"),
    "'Canada'",
  );
  await assert.rejects(
    agent.execute("await bu.select('Reverted country','Canada');await bu.click('After action');"),
    /OUTCOME_NOT_VERIFIED/,
  );
  assert.equal(await value('await page.evaluate(()=>window.afterClicks)'), '0');
});
test('readonly input cannot pass a dependent action', async () => {
  await open();
  await assert.rejects(
    agent.execute("await bu.fill('Readonly field','changed');await bu.click('After action');"),
    /OUTCOME_NOT_VERIFIED/,
  );
  assert.equal(await value('await page.evaluate(()=>window.afterClicks)'), '0');
});
async function frame(covered) {
  await open();
  await agent.execute(
    'await page.evaluate(covered=>{document.body.innerHTML=\'<div style="position:relative"><iframe style="width:500px;height:150px;border:0" src="/frame"></iframe>\'+(covered?\'<button id="overlay" style="position:absolute;left:0;top:0;width:500px;height:150px;z-index:100" onclick="window.overlayClicks++">Overlay</button>\':\'\')+\'</div>\'},' +
      covered +
      ');await page.waitFor(()=>document.querySelector("iframe").contentDocument.querySelector("button"));',
  );
}
test('covered iframe target cannot click overlay', async () => {
  await frame(true);
  await assert.rejects(agent.execute("await bu.click('Frame action')"), /Frame covered/);
  assert.equal(
    await value('await page.evaluate(()=>window.overlayClicks+window.frameClicks)'),
    '0',
  );
});
test('uncovered iframe target remains usable', async () => {
  await frame(false);
  await agent.execute("await bu.click('Frame action')");
  assert.equal(await value('await page.evaluate(()=>window.frameClicks)'), '1');
});
test('unexpected confirmation is dismissed and reported', async () => {
  await open();
  const r = await agent.execute("await bu.click('Delete item')");
  assert.match(r.text, /dismissed/);
  assert.equal(await value('await page.evaluate(()=>window.deleted)'), '0');
});
test('exact explicit dialog policy accepts once and then expires', async () => {
  await open();
  await agent.execute(
    "bu.expectDialog('confirm','Really delete?',{accept:true});await bu.click('Delete item');await bu.click('Delete item');",
  );
  assert.equal(await value('await page.evaluate(()=>window.deleted)'), '1');
});
test('mismatched dialog policy does not authorize different confirmation', async () => {
  await open();
  await agent.execute(
    "bu.expectDialog('confirm','Different text',{accept:true});await bu.click('Delete item');",
  );
  assert.equal(await value('await page.evaluate(()=>window.deleted)'), '0');
});
test('network cap reports input sent, then explicit condition observes completion', async () => {
  await open();
  const r = await agent.execute("await bu.click('Load results')");
  assert.match(r.text, /input_sent/);
  assert.match(r.text, /settled cap/);
  assert.doesNotMatch(r.text, /\[verified\]/);
  assert.equal(await value("await bu.waitForText('Ready now')"), 'true');
});
