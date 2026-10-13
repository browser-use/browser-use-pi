import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUse } from '../dist/index.js';

const CAP = 12_000; // the default maxOutputChars
let agent, workspace;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'bu-budget-'));
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
/** n buttons, then what a long form ends with: a file input and the submit button. */
const page = (n) =>
  `await page.goto('data:text/html,<body>'); await page.evaluate((n) => { document.body.innerHTML = Array.from({length: n}, (_, i) => '<p><button onclick="this.textContent += 1">Button number ' + i + '</button></p>').join('') + '<label>Late file <input type="file"></label><button>Submit order</button>' }, ${n});`;
const whole = (text) => {
  assert.ok(text.length <= CAP, `${text.length} chars`);
  assert.doesNotMatch(text, /\[Truncated/);
  for (const part of [/^\*?\[\d+\] button "Submit order"$/m, /^\[upload\] /m, /^\[\/state\]$/m])
    assert.match(text, part);
};

test('a look alone prints the page up to the output cap, then cuts lines in the middle', async () => {
  const short = await run(`${page(250)} await bu.state()`);
  assert.doesNotMatch(short, /lines cut here/);
  assert.match(short, /Button number 249/);
  whole(short);

  // A look from the cell's code leaves a fifth of the room for a look after it.
  const long = await run(`${page(600)} await bu.state()`);
  assert.match(long, /lines cut here/);
  assert.ok(long.length > 9_000 && long.length < 10_500, `${long.length} chars`);
  whole(long);
});

test('what the cell printed before comes off the state, so its end is never pushed past the cap', async () => {
  const first = (await run(`${page(600)} await bu.state()`)).match(
    /^\*?\[(\d+)\] button "Button number 0"$/m,
  )[1];
  // The normal shape of a cell: read something, print it, act. The state after the action takes the rest.
  for (const printed of [0, 1_400, 2_500, 6_000, 10_000]) {
    const out = await run(`console.log('x'.repeat(${printed})); await bu.click(${first})`);
    assert.match(out, /^\[ok\] click /m);
    assert.match(out, /lines cut here/);
    whole(out);
  }
  // The print after a cell is the last thing in it, so it takes all that is left.
  const acted = await run(`await bu.click(${first})`);
  assert.ok(acted.length > 11_500, `${acted.length} chars: the cap is used`);
  // A look and then an action in one cell: both states are whole, the second one shorter.
  const twice = await run(`await bu.state(); await bu.click(${first})`);
  assert.equal(twice.match(/^\[\/state\]$/gm).length, 2);
  assert.equal(twice.match(/button "Submit order"$/gm).length, 2);
  whole(twice);
});

test('an explicit max still decides, and a cell that used the cap itself gets the shortest state', async () => {
  const small = await run(`${page(600)} await bu.state({max: 3000})`);
  assert.match(small, /lines cut here/);
  assert.ok(small.length < 4_500, `${small.length} chars`);
  whole(small);

  // Nothing is left for the state: it keeps 500 chars of lines, and the cap cuts the cell where it must.
  const full = await run(`console.log('x'.repeat(${CAP})); await bu.state()`);
  assert.match(full, /\[Truncated\. Full captured output: /);
});
