import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUse } from '../dist/index.js';
import { startFixture } from './fixture.mjs';

let agent, fixture, workspace;
before(async () => {
  fixture = await startFixture();
  workspace = await mkdtemp(join(tmpdir(), 'bu-upload-'));
  agent = await BrowserUse.create({
    model: 'openai/gpt-5.4',
    mode: 'ultrafast',
    browser: process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
    workspace,
  });
});
after(async () => {
  await agent?.close();
  await fixture?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test('the state prints up to 10,000 chars before it cuts lines', async () => {
  const page = (n) =>
    `await page.goto('data:text/html,<body>'); await page.evaluate((n) => { document.body.innerHTML = Array.from({length: n}, (_, i) => '<p><button>Button number ' + i + '</button></p>').join('') }, ${n}); await bu.state()`;
  const whole = (await agent.execute(page(200))).text;
  assert.doesNotMatch(whole, /lines cut here/);
  assert.match(whole, /Button number 199/);
  const cut = (await agent.execute(page(600))).text;
  assert.match(cut, /lines cut here/);
  assert.ok(cut.length < 12_000);
  assert.match(cut, /Button number 599/);
});

test('the upload recipe prints only with a file line, and running it sets the bytes', async () => {
  const plain = (
    await agent.execute("await page.goto('data:text/html,<button>Go</button>'); await bu.state()")
  ).text;
  assert.match(plain, /\[\/state\]/);
  assert.doesNotMatch(plain, /\[upload\]/);

  const state = (
    await agent.execute(`await page.goto(${JSON.stringify(fixture.url)}); await bu.state()`)
  ).text;
  const id = state.match(/\[(\d+)\] file "Attach notes"/)?.[1];
  const recipe = state.match(/^\[upload\] set a file line's files with (.*)$/m)?.[1];
  assert.ok(id && recipe, state);
  await agent.execute(`const id = ${id}; ${recipe}`);
  assert.equal(
    (
      await agent.execute(
        "await page.evaluate(async () => { const f = document.querySelector('#upload').files[0]; return f.name + ':' + await f.text() })",
      )
    ).text,
    "'cv.txt:text'",
  );
});

test('a date input with no label prints as one field that takes an ISO date, also in shadow DOM', async () => {
  const html = `<input type="date" id="light"><div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input type="date" id="shadow">'</script>`;
  const state = (
    await agent.execute(
      `await page.goto('data:text/html,' + encodeURIComponent(${JSON.stringify(html)})); await bu.state()`,
    )
  ).text;
  assert.doesNotMatch(state, /spinbutton/);
  const ids = [...state.matchAll(/^\[(\d+)\] Date/gm)].map((m) => m[1]);
  assert.equal(ids.length, 2, state);
  await agent.execute(ids.map((id) => `await bu.type(${id}, '2025-06-14')`).join('; '));
  assert.equal(
    (
      await agent.execute(
        "await page.evaluate(() => [document.querySelector('#light').value, document.querySelector('#host').shadowRoot.querySelector('#shadow').value])",
      )
    ).text.trim(),
    "[ '2025-06-14', '2025-06-14' ]",
  );
});
