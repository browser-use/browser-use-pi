import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUse } from '../dist/index.js';

// One server under two hosts: a frame from localhost inside a 127.0.0.1 page runs in its own process.
const FRAME =
  '<input aria-label="Code"><button onclick="document.body.append(\'Got \' + document.querySelector(\'input\').value)">Send code</button>';
const PAGES = {
  '/frame': FRAME,
  '/': `<title>Shop</title><h1>Shop</h1><ul>${Array.from({ length: 60 }, (_, i) => `<li>Item number ${i}</li>`).join('')}</ul>
    <button onclick="this.textContent = 'Saved'">Save</button>
    <button onclick="alert('Are you sure?'); this.textContent = 'Confirmed'">Confirm</button>
    <div style="position:relative"><button onclick="this.textContent = 'Clicked through'">Hidden behind</button>
      <div style="position:absolute;inset:0;background:white">Cookie banner</div></div>
    <a href="/next">Next page</a>
    <iframe title="Local" src="/frame"></iframe><iframe title="Remote" src="http://localhost:PORT/frame"></iframe>`,
  '/next': '<h1>Next</h1><button>Back</button>',
};
let agent, server, url, workspace;
before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end((PAGES[req.url] ?? '').replace('PORT', String(server.address().port)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  workspace = await mkdtemp(join(tmpdir(), 'bu-axtree-'));
  agent = await BrowserUse.create({
    model: 'openai/gpt-5.4',
    mode: 'ultrafast',
    ax: { state: 'axtree' },
    browser: process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
    workspace,
  });
});
after(async () => {
  await agent?.close();
  server?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const run = async (code) => (await agent.execute(code)).text;
/** The error message of code that must throw. */
const refused = (code) => run(`try { ${code}; 'not refused' } catch (e) { e.message }`);
const look = () => run(`await page.goto(${JSON.stringify(url)}); await bu.state()`);
const id = (state, line) => {
  const n = state.match(new RegExp(`^\\t*(\\d+) ${line}`, 'm'))?.[1];
  assert.ok(n, `no line ${line} in\n${state}`);
  return n;
};

test('every frame prints inside its iframe, and numbers act in same- and out-of-process frames', async () => {
  const state = await look();
  assert.match(state, /^0 AXWebArea Shop/m);
  assert.match(state, /^\t\d+ heading Shop, Value: 1$/m);
  // Both frames hang under their iframe element, one level deeper.
  for (const title of ['Local', 'Remote'])
    assert.match(
      state,
      new RegExp(
        `^\\t(\\d+) container ${title}\\n\\t\\t\\d+ AXWebArea .*URL: (127\\.0\\.0\\.1|localhost):\\d+/frame\\n\\t\\t\\t\\d+ container\\n\\t\\t\\t\\t\\d+ text field \\(settable\\) Code$`,
        'm',
      ),
    );
  const fields = [...state.matchAll(/^\t{4}(\d+) text field \(settable\) Code$/gm)].map(
    (m) => m[1],
  );
  const buttons = [...state.matchAll(/^\t{4}(\d+) button Send code$/gm)].map((m) => m[1]);
  assert.equal(fields.length, 2);
  for (const [i, code] of ['111', '222'].entries()) {
    assert.match(await run(`await bu.type(${fields[i]}, '${code}')`), /\[ok\] type/);
    const after = await run(`await bu.click(${buttons[i]})`);
    assert.match(after, new RegExp(`text Got ${code}`));
  }
});

test('a later look prints only the change, and a number of an earlier page is refused', async () => {
  const state = await look();
  const save = id(state, 'button Save$');
  const after = await run(`await bu.click(${save})`);
  assert.match(after, new RegExp(`^~\\t\\t?${save} button Saved$`, 'm'));
  assert.doesNotMatch(after, /Item number 5/);
  assert.match(await run('await bu.state()'), /No change since the last look\./);
  // The second click in the same call comes after a navigation, before any new look.
  const next = id(state, 'link Next page');
  const stale = await run(
    `await bu.click(${next}); try { await bu.click(${save}) } catch (e) { console.log(e.message) }`,
  );
  assert.match(stale, /navigated to .*\/next/);
  assert.match(stale, new RegExp(`${save} belongs to a previous page; look again`));
  assert.match(await refused('await bu.click(9999)'), /9999 is not a number of the last look/);
});

test('a covered element is refused, and a dialog opened by a click does not stop it', async () => {
  const state = await look();
  assert.match(
    await refused(`await bu.click(${id(state, 'button Hidden behind')})`),
    /covered by .*nothing was clicked/,
  );
  assert.match(await run('await bu.state({full: true})'), /button Hidden behind$/m);
  const confirmed = await run(`await bu.click(${id(state, 'button Confirm$')})`);
  assert.match(confirmed, /\[dialog alert\] "Are you sure\?" \(accepted\)/);
  assert.match(confirmed, /button Confirmed$/m);
});
