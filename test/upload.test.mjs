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
