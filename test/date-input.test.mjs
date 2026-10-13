import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUse } from '../dist/index.js';

// A form in a shadow root whose date input has no label and no value, as on the shadow-DOM stress form,
// then one of every other native date/time input in the page itself.
const PAGE = `<title>Dates</title>
  <shadow-form></shadow-form>
  <label>Return <input id="return" type="date" value="2025-06-14"></label>
  <input id="at" type="time" aria-label="At">
  <input id="start" type="datetime-local" aria-label="Start">
  <input id="month" type="month" aria-label="Month">
  <input id="week" type="week" aria-label="Week">
  <p id="log"></p>
  <script>
    const log = (e) => (document.querySelector('#log').textContent += e.type + ':' + e.composedPath()[0].value + ' ');
    customElements.define('shadow-form', class extends HTMLElement {
      connectedCallback() {
        this.attachShadow({ mode: 'open' }).innerHTML = '<form><div>Date</div><input id="date" type="date" required><button>Submit</button></form>';
        this.shadowRoot.addEventListener('change', (e) => (this.dataset.changed = e.target.value));
      }
    });
    for (const type of ['input', 'change']) document.addEventListener(type, log);
  </script>`;
const value = (id) =>
  `(document.querySelector('#${id}') ?? document.querySelector('shadow-form').shadowRoot.querySelector('#${id}')).value`;

let agent, workspace;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'bu-date-'));
  agent = await BrowserUse.create({
    model: 'openai/gpt-5.4',
    mode: 'ultrafast',
    browser: process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
    workspace,
  });
});
after(async () => {
  await agent?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});
const run = async (code) => (await agent.execute(code)).text;
const look = () =>
  run(
    `await page.goto(${JSON.stringify(`data:text/html,${encodeURIComponent(PAGE)}`)}); await bu.state()`,
  );

test('every native date/time input prints as one field, never as its day/month/year parts', async () => {
  const state = await look();
  // Unlabelled and empty inside a shadow root: still one line, with the value to type.
  assert.match(state, /^\[\d+\] date {2}type as YYYY-MM-DD$/m);
  assert.match(state, /^\[\d+\] date "Return" = "2025-06-14" {2}type as YYYY-MM-DD$/m);
  assert.match(state, /^\[\d+\] time "At" {2}type as HH:MM$/m);
  assert.match(state, /^\[\d+\] datetime "Start" {2}type as YYYY-MM-DDTHH:MM$/m);
  assert.match(state, /^\[\d+\] datetime "Month" {2}type as YYYY-MM-DDTHH:MM$/m);
  assert.doesNotMatch(state, /spinbutton|Show \w+ picker/);
  assert.match(state, /^\[\d+\] button "Submit"$/m);
});

test('typing an ISO value sets the field and fires input and change', async () => {
  const state = await look();
  const id = (line) => state.match(new RegExp(`^\\*?\\[(\\d+)\\] ${line}`, 'm'))[1];
  const typed = await run(
    `await bu.type(${id('date {2}type')}, '2025-06-14'); await bu.type(${id('time "At"')}, '09:05'); await bu.type(${id('datetime "Start"')}, '2025-06-14T09:05'); await bu.type(${id('datetime "Month"')}, '2025-06'); await bu.type(${id('datetime "Week"')}, '2025-W24');`,
  );
  assert.match(typed, /^\[ok\] type \[\d+\] date = "2025-06-14" -> page changed$/m);
  assert.equal(
    await run(
      `await page.evaluate(() => [${['date', 'at', 'start', 'month', 'week'].map(value).join(', ')}].join(' '))`,
    ),
    "'2025-06-14 09:05 2025-06-14T09:05 2025-06 2025-W24'",
  );
  // As a user's edit does: input leaves the shadow root, change stays inside it.
  assert.match(
    await run("await page.evaluate(() => document.querySelector('#log').textContent)"),
    /^'input:2025-06-14 input:09:05 change:09:05 /,
  );
  assert.equal(
    await run("await page.evaluate(() => document.querySelector('shadow-form').dataset.changed)"),
    "'2025-06-14'",
  );
  assert.match(
    await run('await bu.state()'),
    /^\*?\[\d+\] date = "2025-06-14" {2}type as YYYY-MM-DD$/m,
  );
});

test('a value the input refuses fails with the format that input takes and changes nothing', async () => {
  const state = await look();
  const id = (line) => state.match(new RegExp(`^\\*?\\[(\\d+)\\] ${line}`, 'm'))[1];
  for (const [line, text, format, field, kept] of [
    ['date "Return"', 'June 14', 'YYYY-MM-DD', 'return', '2025-06-14'],
    ['date "Return"', '2025-02-30', 'YYYY-MM-DD', 'return', '2025-06-14'],
    ['time "At"', '9am', 'HH:MM', 'at', ''],
    ['datetime "Month"', '2025-06-14T09:05', 'YYYY-MM', 'month', ''],
    ['datetime "Week"', '2025-06', 'YYYY-Www', 'week', ''],
  ]) {
    const failed = await agent.execute(`await bu.type(${id(line)}, ${JSON.stringify(text)})`).then(
      (r) => r.text,
      (e) => `${e.message}\n${e.result?.text ?? ''}`,
    );
    assert.match(
      failed,
      new RegExp(`type \\[\\d+\\] .*failed: .*not a value for <input type=[a-z-]+>; use ${format}`),
      failed,
    );
    assert.equal(await run(`await page.evaluate(() => ${value(field)})`), `'${kept}'`);
  }
});
