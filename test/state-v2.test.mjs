import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { BrowserUse } from '../dist/index.js';
import { AX_PROMPT, axPrompt } from '../dist/ax.js';
import { startFixture } from './fixture.mjs';

// Five workers, each with its own headless Chrome: today's ultrafast, the v2 print with raw input counted as an
// action, the same plus bu.scroll, the same without the automatic state, and the same with the diff. No paid
// model is called: every test runs cells directly, and one runs the agent on a scripted local model.
let fixture, workspace, today, v2, scroll, ask, diff;
const create = (ax) =>
  BrowserUse.create({
    model: 'openai/gpt-5.4',
    mode: 'ultrafast',
    ...(ax ? { ax } : {}),
    browser: process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
    workspace,
  });
before(async () => {
  fixture = await startFixture();
  workspace = await mkdtemp(join(tmpdir(), 'bu-state-v2-'));
  today = await create();
  v2 = await create({ state: 'v2', rawInput: true });
  scroll = await create({ state: 'v2', rawInput: true, scroll: true });
  ask = await create({ state: 'v2', rawInput: true, autoState: false });
  diff = await create({ state: 'v2', rawInput: true, diff: true });
});
after(async () => {
  for (const agent of [today, v2, scroll, ask, diff]) await agent?.close();
  await fixture?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const run = async (agent, code) => (await agent.execute(code)).text;
/** The error of a cell that fails, with what the cell printed after it. */
const fails = async (agent, code) => {
  const error = await agent.execute(code).then(
    () => assert.fail(`did not fail: ${code}`),
    (e) => e,
  );
  return `${error.message}\n${error.result?.text ?? ''}`;
};
const open = (agent, route, base = fixture.url) =>
  run(agent, `await page.goto(${JSON.stringify(base + route)}); await bu.state()`);
const WHEEL = (x, y, deltaY) =>
  `await page.cdp('Input.dispatchMouseEvent', {type: 'mouseWheel', x: ${x}, y: ${y}, deltaX: 0, deltaY: ${deltaY}})`;
/** Names of the id lines of a state print, in order. A scroll area line is not one of them. */
const printed = (state, role = 'button|link') =>
  [...state.matchAll(new RegExp(`^\\*?\\[\\d+\\] (?:${role}) "([^"]*)"`, 'gm'))].map((m) => m[1]);
const ANY = '\\w+';
const idOf = (state, name) => Number(state.match(new RegExp(`\\[(\\d+)\\] [a-z ]+ "${name}"`))[1]);
const line2 = (state) => state.split('\n').find((line) => line.startsWith('view '));
const areas = (state) => state.split('\n').filter((line) => /^\[\d+\] scroll area/.test(line));
const numbered = (name, n) => Array.from({ length: n }, (_, i) => `${name} ${i}`);
/** Ground truth from the page: buttons and links whose box meets the screen and every scroll box around them. */
const onScreen = async (agent) =>
  JSON.parse(
    await run(
      agent,
      `console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button, a[href]')].filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight) return false;
        for (let p = e.parentElement; p; p = p.parentElement) {
          const c = p.getBoundingClientRect();
          if (/auto|scroll/.test(getComputedStyle(p).overflowY) && (r.bottom <= c.top || r.top >= c.bottom)) return false;
        }
        return true;
      }).map((e) => e.textContent))))`,
    ),
  );

test('with no switch the prompt, the print, the raw path and bu itself are today’s', async () => {
  assert.equal(axPrompt(), AX_PROMPT);
  assert.equal(axPrompt({}), AX_PROMPT);
  assert.equal(axPrompt({ state: 'v1' }), AX_PROMPT);
  const state = await open(today, '/long');
  assert.equal(line2(state), undefined);
  assert.match(
    state,
    /^\.\.\. \d+ lines cut here \(bu\.state\(\{max: 30000\}\) or page\.evaluate\)$/m,
  );
  // 300 buttons in document order: the capped print holds far more than the screen and still not all.
  assert.ok(printed(state).length > (await onScreen(today)).length);
  assert.equal((await run(today, WHEEL(400, 400, 800))).trim(), '{}');
  // The model's code can list what bu has: no name is added while no switch is on.
  assert.equal(
    await run(
      today,
      `[typeof bu.scroll, 'scroll' in bu, 'raw' in bu, Object.getOwnPropertyNames(Object.getPrototypeOf(bu)), Object.keys(bu)].join(' ')`,
    ),
    "'undefined false false constructor,trackNetwork,probe,settle,flushDialogs,visibleText,capture,state,fileInputs,onNode,describe,point,act,change,click,type,key page,browser,log,inflight,lastNet,tracked,dialogs,last,acted,actedAt'",
  );
});

test("ax.state takes 'v1' (today) and 'v2', nothing else", async () => {
  await assert.rejects(create({ state: 'v3' }), /^Error: ax\.state must be 'v1' or 'v2'\.$/);
  const v1 = await create({ state: 'v1' });
  try {
    assert.equal(line2(await open(v1, '/long')), undefined);
  } finally {
    await v1.close();
  }
});

test('long page: every on-screen control is printed and the rest is counted on line 2', async () => {
  const state = await open(v2, '/long');
  const lines = state.trim().split('\n');
  assert.equal(lines[0], `[state] fixture | ${fixture.url}/long`); // line 1 is the one the Cloud parser reads
  assert.match(lines[1], /^view 0-\d+ of \d+ px \| 0 controls above \| \d+ below$/);
  assert.equal(lines[2], '## Long list');
  assert.equal(lines.at(-1), '[/state]');
  const shown = printed(state);
  assert.deepEqual(shown, await onScreen(v2));
  assert.equal(shown.length + Number(lines[1].match(/(\d+) below/)[1]), 301);
});

test('a raw wheel event through page.cdp is followed by the state of the new screen', async () => {
  const first = await open(v2, '/long');
  // The recipe as the prompt gives it, copied verbatim. Its point is the middle of the screen, where bu.scroll wheels too.
  const recipe = axPrompt({ state: 'v2' }).match(/scroll with (await page\.cdp\(.*?\}\))/)[1];
  assert.equal(recipe, WHEEL(700, 400, 800));
  const out = await run(v2, recipe);
  // The command's own result, then the state. A scroll gets no verdict line: line 2 is its verdict.
  assert.match(out, /^\{\}\n\[state\] fixture \| /);
  const [, top, above, below] = line2(out).match(
    /^view (\d+)-\d+ of \d+ px \| (\d+) controls above \| (\d+) below$/,
  );
  assert.equal(top, '800');
  const shown = printed(out);
  assert.deepEqual(shown, await onScreen(v2));
  assert.notDeepEqual(shown, printed(first));
  assert.ok(Number(above) > 0);
  assert.equal(Number(above) + shown.length + Number(below), 301);
  assert.doesNotMatch(out, /^\*/m); // * is for ids new on the page, not for ids that scrolled into view
  // A look inside the cell replaces the automatic print, as after a bu action.
  const once = await run(v2, `${WHEEL(700, 400, -800)}; await bu.state()`);
  assert.equal(once.match(/\[state\]/g).length, 1);
  assert.match(line2(once), /^view 0-/);
});

test('raw input gets the verdict line of a helper; the helper’s own input does not', async () => {
  await open(v2, '/clickdiv');
  const centre = `const r = await page.evaluate(() => document.getElementById('cd').getBoundingClientRect().toJSON())`;
  const hit = await run(v2, `${centre}; await page.clickAt(r.x + r.width / 2, r.y + r.height / 2)`);
  assert.match(hit, /^\[ok\] raw input -> page changed\n\[state\] fixture \| /);
  assert.match(hit, /^div clicked$/m);
  const miss = await run(v2, `await page.clickAt(900, 700)`);
  assert.match(miss, /^\[ok\] raw input -> no change\n\[state\] fixture \| /);
  const state = await open(v2, '/long');
  const helper = await run(v2, `await bu.click(${idOf(state, 'Item 3')})`);
  assert.match(helper, /^\[ok\] click \[\d+\] button "Item 3" -> no change\n/);
  assert.doesNotMatch(helper, /raw input/);
});

test('a look waits for a scroll that is still moving', async () => {
  await open(v2, '/long');
  // A smooth scroll takes about 900 ms here; the page is quiet for the mutation observer the whole time.
  const state = await run(
    v2,
    `await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'smooth'; scrollTo(0, 3000); }); await bu.state()`,
  );
  assert.match(line2(state), /^view 3000-/);
});

test('a ticker that scrolls forever does not hold up every look', async () => {
  await open(v2, '/ticker'); // the first 1.5 s of its scrolling still count
  await run(v2, 'await bu.state()');
  const start = Date.now();
  const state = await run(v2, 'await bu.state()');
  assert.ok(Date.now() - start < 1500, `look took ${Date.now() - start} ms`); // 3,000 ms before, the cap
  assert.deepEqual(printed(state), ['Read more']);
});

test('an id from the print works in raw CDP DOM commands', async () => {
  const state = await open(v2, '/');
  const id = idOf(state, 'Search products');
  const out = await run(
    v2,
    `await page.cdp('DOM.focus', {backendNodeId: ${id}}); console.log(await page.evaluate(() => document.activeElement.name))`,
  );
  assert.equal(out.trim(), 'query');
  // Raw input into the focused field: the print that follows shows the value.
  const typed = await run(v2, `await page.cdp('Input.insertText', {text: 'atlas'})`);
  assert.match(typed, new RegExp(`\\[${id}\\] searchbox "Search products" = "atlas"`));
});

test('an id of a previous page fails before anything is sent, with the state of this page below', async () => {
  const siteB = fixture.url.replace('127.0.0.1', 'localhost'); // another site: Chrome restarts its ids there
  const first = await open(v2, '/pay');
  const [pay, cancel] = [idOf(first, 'Pay now'), idOf(first, 'Cancel')];
  // Before the first look on the new page.
  const early = await fails(
    v2,
    `await page.goto(${JSON.stringify(siteB + '/other')}); await bu.click(${pay})`,
  );
  assert.equal(
    early.split('\n')[0],
    `Error: click [${pay}] button "Pay now" failed: stale: ${pay} belongs to a previous page; use ids from the state below`,
  );
  assert.ok(early.includes(`\n[state] fixture | ${siteB}/other\n`)); // "fixture": no button of this page was clicked
  // After it: the old id is still refused and still named. Ids of this page work.
  assert.match(
    await fails(v2, `await bu.type(${cancel}, 'x')`),
    new RegExp(
      `^Error: type \\[${cancel}\\] button "Cancel" failed: stale: ${cancel} belongs to a previous page; use ids from the state below\\n`,
    ),
  );
  assert.match(
    await run(v2, `await bu.click(${idOf(early, 'Keep')})`),
    /^\[ok\] click \[\d+\] button "Keep" -> page changed\n/,
  );
  // A new document of the same site is a new page too. Chrome's own text for it was "does not belong to the document".
  const again = await open(v2, '/pay');
  assert.match(
    await fails(
      v2,
      `await page.goto(${JSON.stringify(fixture.url + '/other')}); await bu.click(${idOf(again, 'Pay now')})`,
    ),
    /failed: stale: \d+ belongs to a previous page/,
  );
  // pushState keeps the document, so ids stay good.
  const spa = await open(v2, '/spa');
  assert.match(
    await run(v2, `await bu.click(${idOf(spa, 'Go next')}); await bu.click(${idOf(spa, 'Kept')})`),
    /^\[ok\] click \[\d+\] button "Go next" -> navigated to \S+\/spa\/next\n\[ok\] click \[\d+\] button "Kept" -> page changed\n/,
  );
});

test('an element that is gone fails as stale too, not with Chrome’s -32000', async () => {
  const gone = (op, id, name) =>
    `Error: ${op} [${id}]${name ? ` button "${name}"` : ''} failed: stale: ${id} is gone from this page; use ids from the state below`;
  const first = (text) => text.split('\n')[0];
  const pay = idOf(await open(v2, '/pay'), 'Pay now');
  // Removed but still alive in Chrome: the action's first page call finds it detached.
  const removed = await fails(
    v2,
    `await page.evaluate(() => document.querySelector('button').remove()); await bu.click(${pay})`,
  );
  assert.equal(first(removed), gone('click', pay, 'Pay now'));
  assert.doesNotMatch(removed.split('[state]')[1], /Pay now/);
  // Collected: Chrome answers "No node with given id found". The state above no longer has it, the name is kept.
  assert.equal(
    first(
      await fails(v2, `await page.cdp('HeapProfiler.collectGarbage'); await bu.type(${pay}, 'x')`),
    ),
    gone('type', pay, 'Pay now'),
  );
  // A number that never was an id reads the same.
  assert.equal(first(await fails(v2, 'await bu.click(999999)')), gone('click', 999999));
  // A frame that loaded another document: "Node with given id does not belong to the document".
  const framed = idOf(await open(v2, '/scrollframe'), 'Framed 0');
  assert.equal(
    first(
      await fails(
        v2,
        `await page.evaluate(() => new Promise((done) => { const f = document.querySelector('iframe'); f.onload = done; f.src = '/framed-short'; })); await bu.click(${framed})`,
      ),
    ),
    gone('click', framed, 'Framed 0'),
  );
  // With no switch it is Chrome's text, as today.
  assert.match(
    await fails(today, 'await bu.click(999999)'),
    /^Error: click \[999999\] failed: CDP -32000: No node with given id found\n/,
  );
});

test('an id that no look printed is not refused: a backend id from a raw DOM query works in bu.click', async () => {
  // A worker that has printed nothing yet: Chrome reuses numbers across sites, and a printed one would be judged.
  const fresh = await create({ state: 'v2' });
  const click = (selector) =>
    `const {root} = await page.cdp('DOM.getDocument', {depth: 0}); const {nodeId} = await page.cdp('DOM.querySelector', {nodeId: root.nodeId, selector: '${selector}'}); await bu.click((await page.cdp('DOM.describeNode', {nodeId})).node.backendNodeId)`;
  try {
    await open(fresh, '/clickdiv'); // its clickable div prints as text, without an id
    assert.match(
      await run(fresh, click('#cd')),
      /^\[ok\] click \[\d+\] -> page changed\n[^]*^div clicked$/m,
    );
    // A button far below the screen: counted on line 2, never printed.
    await open(fresh, '/long');
    assert.match(
      await run(fresh, click('#submit')),
      /^\[ok\] click \[\d+\] button "Submit order" -> no change\n/,
    );
  } finally {
    await fresh.close();
  }
});

test('autoState false: no state after an action, and the model looks when it wants', async () => {
  const prompt = axPrompt({ state: 'v2', rawInput: true, autoState: false });
  assert.match(
    prompt,
    /new since the last look\. The state is not printed after an action: look when you need it\.\n/,
  );
  assert.doesNotMatch(prompt, /printed automatically/);
  const state = await open(ask, '/long');
  const id = idOf(state, 'Item 3');
  assert.equal(
    (await run(ask, `await bu.click(${id})`)).trim(),
    `[ok] click [${id}] button "Item 3" -> no change`,
  );
  assert.equal((await run(ask, WHEEL(700, 400, 800))).trim(), '{}');
  assert.match(line2(await run(ask, 'await bu.state()')), /^view 800-/);
  // Raw input still gets its page wait and its verdict line, as a helper does. Only the state is left out.
  assert.equal(
    (await run(ask, 'await page.clickAt(900, 700)')).trim(),
    '[ok] raw input -> no change',
  );
  // No state follows, so the stale message says where the ids are.
  const stale = await fails(
    ask,
    `await page.goto(${JSON.stringify(fixture.url + '/pay')}); await bu.click(${id})`,
  );
  assert.match(stale, /stale: \d+ belongs to a previous page; use ids from a new bu\.state\(\)\n/);
  assert.doesNotMatch(stale, /\[state\]/);
});

test('divsoup: rows of plain divs print one line each', async () => {
  const state = await open(v2, '/divsoup');
  const rows = state.split('\n').filter((line) => line.startsWith('Row '));
  assert.ok(rows.length > 10);
  rows.forEach((row, i) => assert.match(row, new RegExp(`^Row ${i} lorem ipsum .* ut labore et$`)));
  assert.match(line2(state), /\| 0 controls above \| 1 below$/); // the button after the soup
  // Today the 80 rows are one line, and the cap cuts that line whole.
  const old = await open(today, '/divsoup');
  assert.match(old, /\.\.\. 1 lines cut here/);
  assert.doesNotMatch(old, /Row 0/);
});

test('a paragraph or list item that wraps stays one line', async () => {
  assert.deepEqual((await open(v2, '/para')).trim().split('\n').slice(2, -1), [
    'Total price: 1234567890123 incl. tax',
    'Ships to Switzerland only',
    'Free returns within thirty days of delivery',
  ]);
});

test('the cap is 6,000 chars of on-screen lines, head and tail kept, with a cut marker', async () => {
  // Zoomed out, all 80 rows and the button are on screen: about 8,500 chars.
  await run(
    v2,
    `await page.goto(${JSON.stringify(fixture.url + '/divsoup')}); await page.evaluate(() => (document.body.style.zoom = 0.3))`,
  );
  const state = await run(v2, 'await bu.state()');
  assert.match(line2(state), /\| whole page$/);
  // Nothing scrolls here, so the marker does not say to scroll.
  const [marker, cut] = state.match(
    /^\.\.\. (\d+) on-screen lines cut at 6000 chars: read with page\.evaluate$/m,
  );
  const body = state.trim().split('\n').slice(2, -1);
  assert.ok(body.join('\n').length <= 6000 + marker.length);
  assert.equal(body.length - 1 + Number(cut), 81);
  assert.match(body[0], /^Row 0 /);
  assert.match(body.at(-1), /button "After soup"$/);
  await open(v2, '/long');
  assert.match(
    await run(v2, 'await bu.state({max: 200})'),
    /^\.\.\. \d+ on-screen lines cut at 200 chars: scroll half a screen or read with page\.evaluate$/m,
  );
});

test('one text line longer than half the cap is clipped, not cut whole', async () => {
  const lines = (await open(v2, '/bigtext')).trim().split('\n');
  assert.match(lines[1], /\| 0 controls above \| 1 below$/);
  assert.match(lines[2], /^line 0 of the log: status ok, value 0 line 1 of .*…$/);
  assert.equal(lines[2].length, 3001);
  assert.equal(lines[3], '[/state]');
});

test('clickdiv: a page that fits says so', async () => {
  const lines = (await open(v2, '/clickdiv')).trim().split('\n');
  assert.match(lines[1], /^view 0-(\d+) of \1 px \| whole page$/);
  // Divs and spans with a click handler are still text without an id (clickable lines are not built).
  assert.deepEqual(lines.slice(2, -1), ['Open settings', 'Delete row Anchor without href']);
});

test('modal open is on line 2 for a dialog on screen, not for a closed drawer that keeps aria-modal', async () => {
  await open(v2, '/clickdiv');
  const state = await run(
    v2,
    `await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<dialog aria-label="Cookies"><button>Accept</button></dialog>'); document.querySelector('dialog').showModal(); }); await bu.state()`,
  );
  assert.match(line2(state), /\| whole page \| modal open$/);
  assert.deepEqual(printed(state), ['Accept']);
  assert.match(line2(await open(v2, '/drawer')), /\| 0 controls above \| \d+ below$/);
});

test('innerscroll: a list that scrolls inside a 100vh shell has its own line and counts', async () => {
  const state = await open(v2, '/innerscroll');
  // The page fits, but something scrolls: "whole page" would say there is nothing more.
  assert.match(line2(state), /^view 0-(\d+) of \1 px \| 0 controls above \| 0 below$/);
  const area =
    /^\[(\d+)\] scroll area "Results" (\d+)-\d+ of 20000 px \| (\d+) above \| (\d+) below$/m;
  const [, id, top, above, below] = state.match(area);
  assert.deepEqual([top, above], ['0', '0']);
  const shown = printed(state);
  assert.deepEqual(shown, await onScreen(v2));
  assert.equal(shown.length - 1 + Number(below), 500); // the top bar button is not in the list
  // The id is the list's backend id: its box is where a raw wheel event scrolls the list, not the page.
  const out = await run(
    v2,
    `const q = (await page.cdp('DOM.getBoxModel', {backendNodeId: ${id}})).model.content; ${WHEEL('q[0] + 50', 'q[1] + 50', 400)}`,
  );
  const [, , top2, above2, below2] = out.match(area);
  assert.deepEqual([top2, above2], ['400', '10']);
  assert.deepEqual(printed(out), await onScreen(v2));
  assert.equal(10 + printed(out).length - 1 + Number(below2), 500);
  // Page text cannot stand in for the line: it is filled in where the list starts, once.
  const forged = await run(
    v2,
    `await page.evaluate(() => document.getElementById('list').insertAdjacentHTML('afterbegin', '<div>\\u00000</div><div>0</div>')); await bu.state()`,
  );
  assert.equal(areas(forged).length, 1);
});

test('a scroll area with only text has a line too, and its hidden text is not printed', async () => {
  const state = await open(v2, '/shelltext');
  assert.match(line2(state), /\| 0 controls above \| 0 below$/);
  const [area] = areas(state);
  assert.match(area, /^\[\d+\] scroll area "Terms" 0-\d+ of 12050 px \| 0 above \| 0 below$/);
  assert.doesNotMatch(state, /SECRET/);
  assert.deepEqual(printed(state), ['Home', 'Accept']);
  const end = await run(
    v2,
    `const q = (await page.cdp('DOM.getBoxModel', {backendNodeId: ${idOf(state, 'Terms')}})).model.content; ${WHEEL('q[0] + 50', 'q[1] + 50', 20000)}`,
  );
  assert.match(end, /^THE SECRET CODE IS 4711\.$/m);
});

test('a body with overflow:auto is the page, unless html clips it: then the body is the scroll area', async () => {
  // html visible: the body's overflow goes to the viewport, so the page scrolls.
  assert.doesNotMatch(await open(v2, '/bodyscroll'), /scroll area/);
  const page = await run(v2, WHEEL(400, 400, 1000));
  assert.match(line2(page), /^view 1000-\d+ of 8000 px \| 25 controls above \| \d+ below$/);
  assert.equal(printed(page)[0], 'Row 25');
  // html clipped: window.scrollY stays 0 and the body scrolls inside the screen.
  const shell = /^\[\d+\] scroll area (\d+)-\d+ of 8000 px \| (\d+) above \| \d+ below$/m;
  assert.deepEqual((await open(v2, '/shellscroll')).match(shell).slice(1), ['0', '0']);
  const inner = await run(v2, WHEEL(400, 400, 1000));
  assert.match(line2(inner), /^view 0-(\d+) of \1 px \| 0 controls above \| 0 below$/);
  assert.deepEqual(inner.match(shell).slice(1), ['1000', '25']);
  assert.equal(printed(inner)[0], 'Row 25');
});

test('nested scroll areas: each counts what it hides, and an area that is off screen counts for the one around it', async () => {
  const state = await open(v2, '/nested');
  const [outer, cities, nameless, ...more] = areas(state);
  // 30 tail rows and the 10 rows of the area "Deep", which is itself scrolled out of "Outer" and gets no line.
  assert.match(outer, /^\[\d+\] scroll area "Outer" 0-300 of \d+ px \| 0 above \| 40 below$/);
  // A scroller that is a control has both lines, with one id.
  const [, id] = cities.match(
    /^\[(\d+)\] scroll area "Cities" 0-100 of 600 px \| 0 above \| 16 below$/,
  );
  assert.match(state.split(cities)[1], new RegExp(`^\\n\\*?\\[${id}\\] listbox "Cities"\\n`));
  assert.match(nameless, /^\[\d+\] scroll area 0-100 of 600 px \| 0 above \| 16 below$/);
  assert.deepEqual(more, []);
  assert.deepEqual(printed(state, ANY), [
    ...numbered('Outer', 5),
    'Cities',
    ...numbered('City', 4),
    ...numbered('Link', 4),
  ]);
  // A raw wheel over the outer list moves it, not the lists inside it.
  const out = await run(v2, WHEEL(700, 60, 120));
  assert.match(areas(out)[0], /"Outer" 120-420 of \d+ px \| 3 above \| \d+ below$/);
});

test('what is positioned out of its list is not clipped by it: fixed, absolute, a modal dialog', async () => {
  const fixed = await open(v2, '/fixedin');
  assert.deepEqual(printed(fixed), [...numbered('P', 5), 'Floating close']);
  assert.match(areas(fixed)[0], /"Panel" 0-200 of 1200 px \| 0 above \| 25 below$/);
  const menu = await open(v2, '/menu');
  assert.deepEqual(printed(menu), [...numbered('Row', 3), 'Rename', 'Delete', 'Footer']);
  assert.match(areas(menu)[0], /"Rows" 0-120 of 1200 px \| 0 above \| 27 below$/);
  const dialog = await open(v2, '/dialoginlist');
  assert.deepEqual(printed(dialog), ['Delete', 'Keep']);
  assert.match(line2(dialog), /\| modal open$/);
});

test('zoom and scale: the visible rows of a zoomed list are the printed ones', async () => {
  const state = await open(v2, '/zoom');
  assert.deepEqual(printed(state), [...numbered('Z', 10), ...numbered('S', 10)]);
  assert.deepEqual(
    areas(state).map((line) => line.replace(/^\[\d+\] /, '')),
    ['Zoomed', 'Small'].map(
      (name) => `scroll area "${name}" 0-300 of 1200 px | 0 above | 30 below`,
    ),
  );
});

test('controls beside the screen print as today: a carousel loses nothing', async () => {
  const state = await open(v2, '/carousel');
  assert.deepEqual(printed(state), [...numbered('Deal', 30), 'Far right']);
  assert.deepEqual(printed(state), printed(await open(today, '/carousel')));
});

test('parked inputs and skip links go with their parent, and are not "above" at the top of the page', async () => {
  const state = await open(v2, '/parked');
  assert.match(line2(state), /^view 0-\d+ of \d+ px \| 0 controls above \| 1 below$/); // the radio far below
  assert.deepEqual(printed(state, ANY), [
    'Skip to content',
    'Skip to search',
    'Radio A',
    'Radio B',
    'Newsletter',
    'avatar',
  ]);
  assert.match(state, /^\*?\[\d+\] file "avatar" = "No file chosen"$/m); // the id for DOM.setFileInputFiles
});

test('off-screen headings are not controls, even when they take focus', async () => {
  assert.match(line2(await open(v2, '/tabhead')), /\| 0 controls above \| 1 below$/);
  const end = await run(v2, WHEEL(700, 400, 5000));
  assert.match(line2(end), /\| 1 controls above \| 0 below$/);
  assert.equal(end.match(/^## Section$/gm).length, 5);
});

test('a page that moves by a transform: "whole page" only when no control is hidden', async () => {
  const state = await open(v2, '/transformscroll');
  const [, below] = line2(state).match(
    /^view 0-(?:\d+) of \d+ px \| 0 controls above \| (\d+) below$/,
  );
  assert.equal(printed(state).length + Number(below), 200);
  const out = await run(v2, WHEEL(700, 400, 800));
  assert.match(line2(out), /\| 20 controls above \| \d+ below$/);
  assert.equal(printed(out)[0], 'T 20');
});

test('a frame that scrolls by itself has a scroll area line under its frame line', async () => {
  const state = await open(v2, '/scrollframe');
  const lines = state.trim().split('\n');
  const at = lines.indexOf(`--- frame ${fixture.url}/framed ---`);
  assert.ok(at > 0);
  const [, below] = lines[at + 1].match(
    /^\[\d+\] scroll area 0-200 of \d+ px \| 0 above \| (\d+) below$/,
  );
  const shown = printed(state);
  assert.ok(shown.length > 0 && shown.length < 10);
  assert.equal(shown.length + Number(below), 60);
});

test('nodes without a box, a frame that does not scroll, a frame and a select below the fold', async () => {
  const lines = (await open(v2, '/odd')).trim().split('\n');
  // Below: the select (once, not per option), the file input and the 60 buttons of the frame.
  assert.match(lines[1], /\| 0 controls above \| 62 below$/);
  assert.deepEqual(
    lines.slice(2, -1).map((line) => line.replace(/^\*?\[\d+\] /, '')),
    [
      'file "resume" (hidden)',
      '## Odd',
      'button "Contents button"', // display: contents
      'link "Zero height link"',
      `--- frame ${fixture.url}/framed-short ---`, // it fits its frame: no scroll area line
      'button "Short frame button"',
    ],
  );
  const end = await run(v2, WHEEL(700, 400, 5000));
  assert.match(line2(end), /\| 3 controls above \| 0 below$/);
  assert.match(
    end,
    /^\[\d+\] select "Speed" = "Standard" collapsed {2}options: Standard \| Express$/m,
  );
  assert.match(end, /^\[\d+\] scroll area 0-100 of \d+ px \| 0 above \| 57 below$/m);
  // An off-screen control keeps the role it prints with.
  await run(v2, WHEEL(700, 400, -5000));
  assert.match(
    await run(v2, `await bu.type(${idOf(end, 'Speed')}, 'Express')`),
    /^\[ok\] type \[\d+\] select "Speed" = "Express" -> page changed\n/,
  );
  assert.match(
    await fails(v2, `await bu.click(${idOf(end, 'Low upload')})`),
    /^Error: click \[\d+\] file "Low upload" failed: Error: File input: /,
  );
});

test('sticky header: it stays in the print after a scroll and is not counted as above', async () => {
  await open(v2, '/sticky');
  const out = await run(v2, WHEEL(400, 400, 1500));
  const shown = printed(out);
  assert.equal(shown[0], 'Brand home');
  assert.deepEqual(shown, await onScreen(v2));
  const [, above, below] = line2(out).match(/\| (\d+) controls above \| (\d+) below$/);
  assert.ok(Number(above) > 0);
  assert.equal(Number(above) + shown.length - 1 + Number(below), 100);
});

test('device pixel ratio 2: line 2 and the boxes stay CSS px', async () => {
  const state = await run(
    v2,
    `await page.cdp('Emulation.setDeviceMetricsOverride', {width: 800, height: 600, deviceScaleFactor: 2, mobile: false}); await page.goto(${JSON.stringify(fixture.url + '/long')}); await bu.state()`,
  );
  try {
    assert.match(line2(state), /^view 0-600 of \d+ px \| 0 controls above \| \d+ below$/);
    assert.deepEqual(printed(state), await onScreen(v2));
  } finally {
    await run(v2, `await page.cdp('Emulation.clearDeviceMetricsOverride'); void 0`);
  }
});

test('the prompt explains line 2 and keeps the raw recipes; bu.scroll replaces the wheel recipe', () => {
  const raw = axPrompt({ state: 'v2', rawInput: true });
  assert.match(
    raw,
    /line 2 is the scroll position \(view 0-813 of 9480 px \| 0 controls above \| 141 below\)/,
  );
  assert.match(
    raw,
    /Ids are Chrome backendNodeIds: they work in bu\.\* and in every CDP DOM command\./,
  );
  assert.match(raw, /- Raw: upload to a file line with await page\.cdp\('DOM\.setFileInputFiles'/);
  assert.match(raw, /\{type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: 800\}/);
  assert.match(
    raw,
    /whose bu actions or raw Input commands reached the page, the state is printed automatically/,
  );
  assert.doesNotMatch(raw, /bu\.scroll/);
  const helper = axPrompt({ state: 'v2', rawInput: true, scroll: true });
  assert.match(
    helper,
    /await bu\.scroll\('down'\) or 'up' moves one screen; \{pages: 0\.5\} less, \{at: id\} inside a "scroll area" line\.\n/,
  );
  assert.doesNotMatch(helper, /mouseWheel/);
  assert.match(helper, /- Raw: upload to a file line/);
  // Without the v2 print there is no "scroll area" line to point at.
  assert.doesNotMatch(axPrompt({ scroll: true }), /scroll area/);
});

test('bu.scroll exists only with its own switch and prints the new view', async () => {
  assert.equal(await run(v2, 'typeof bu.scroll'), "'undefined'");
  await open(scroll, '/long');
  const out = await run(scroll, `await bu.scroll('down')`);
  const [, top, bottom] = out.match(/^\[ok\] scroll down 1 page -> view (\d+)-(\d+) of \d+ px\n/);
  assert.equal(Number(bottom), 2 * Number(top)); // one page is one screen
  assert.equal(
    line2(out).split(' |')[0],
    `view ${top}-${bottom} of ${out.match(/of (\d+) px/)[1]} px`,
  );
  assert.deepEqual(printed(out), await onScreen(scroll));
  assert.match(
    await run(scroll, `await bu.scroll('up', {pages: 2}); await bu.scroll('up'); void 0`),
    /^\[ok\] scroll up 2 pages -> view 0-\d+ of \d+ px\n\[ok\] scroll up 1 page -> no change: view 0-/,
  );
  // at: the scroll area's id. One page is the area's own height, so no row is skipped.
  const state = await open(scroll, '/innerscroll');
  const [, id, bottomRow] = state.match(/^\[(\d+)\] scroll area "Results" 0-(\d+) of 20000 px/m);
  const inner = await run(scroll, `await bu.scroll('down', {at: ${id}})`);
  const moved = (from) =>
    new RegExp(
      `^\\[ok\\] scroll down 1 page in \\[${id}\\] scroll area "Results" -> ${from}-${from + Number(bottomRow)} of 20000 px\\n`,
    );
  assert.match(inner, moved(Number(bottomRow)));
  assert.equal(
    areas(inner)[0].split(' |')[0],
    `[${id}] scroll area "Results" ${bottomRow}-${2 * bottomRow} of 20000 px`,
  );
  assert.deepEqual(printed(inner), await onScreen(scroll));
  // Without at, on a shell: the wheel at the middle of the screen moves the list, and the line says so.
  assert.match(await run(scroll, `await bu.scroll('down')`), moved(2 * bottomRow));
  // An id that is not a scroll area is refused.
  assert.match(
    await fails(scroll, `await bu.scroll('down', {at: ${idOf(state, 'Top bar')}})`),
    /^Error: scroll down in \[\d+\] button "Top bar" failed: not a scroll area on screen\n/,
  );
  await assert.rejects(scroll.execute(`await bu.scroll(12)`), /scroll needs 'down' or 'up'\./);
});

const SAME = '[state same]\nnothing changed on screen since the last state';
const lines = (text) => text.trim().split('\n');

test('diff: the first look is full, a look with no change is the two-line form', async () => {
  await assert.rejects(create({ diff: true }), /^Error: ax\.diff needs ax\.state 'v2'\.$/);
  const first = await open(diff, '/combo');
  assert.match(
    first,
    /^\[state\] fixture \| \S+\/combo\nview 0-\d+ of \d+ px \| whole page\n## Trip\n/,
  );
  assert.equal((await run(diff, 'await bu.state()')).trim(), SAME);
  // Raw input that changes nothing: its verdict line, then the two lines.
  assert.equal(
    (await run(diff, 'await page.clickAt(900, 700)')).trim(),
    `[ok] raw input -> no change\n${SAME}`,
  );
  // The call still returns the full text: code that reads ids from it keeps working.
  assert.equal(
    await run(diff, `console.log(String(await bu.state()).split('\\n')[0])`),
    `${SAME}\n[state] fixture | ${fixture.url}/combo\n`,
  );
  // On request the whole state, with no * mark on it.
  const full = await run(diff, 'await bu.state({full: true})');
  assert.equal(full, first);
  assert.doesNotMatch(full, /^\*/m);
});

test('diff: an in-place change prints the changed line, the new lines and where they sit; closing it lists the ids that left', async () => {
  const first = await open(diff, '/combo');
  const id = idOf(first, 'Round trip');
  // The new lines push "Fares shown per person" down. It is not printed again: it still sits under the same id line.
  const opened = lines(await run(diff, `await bu.click(${id})`));
  const [list, ...options] = opened
    .slice(5, 9)
    .map((line) => Number(line.match(/^\+\[(\d+)\]/)[1]));
  assert.deepEqual(opened, [
    `[ok] click [${id}] button "Round trip" -> page changed`,
    '',
    '[state diff]',
    `~[${id}] button "Round trip" expanded focused`,
    `@ after [${id}]`,
    `+[${list}] listbox "Ticket type"`,
    `+[${options[0]}] option "Round trip" selected`,
    `+[${options[1]}] option "One way"`,
    `+[${options[2]}] option "Multi-city"`,
    '+Prices include taxes',
    '[/state]',
  ]);
  // An id from a diff line is a backend id like any other.
  assert.match(
    await run(diff, `await bu.click(${options[1]})`),
    new RegExp(`^\\[ok\\] click \\[${options[1]}\\] option "One way" -> no change\\n`),
  );
  // Closed: the four ids as one range, since no id that is still shown lies between them. Text that left is not listed.
  assert.deepEqual(lines(await run(diff, `await bu.click(${id})`)).slice(2), [
    '[state diff]',
    `gone: ${list}-${options[2]}`,
    `~[${id}] button "Round trip" collapsed focused`,
    '[/state]',
  ]);
  // Only text left: a diff has no line for that, and "same" would be false. So the full state.
  const less = await run(
    diff,
    `await page.evaluate(() => document.querySelector('h1').remove()); await bu.state()`,
  );
  assert.match(less, /^\[state\] fixture \| /);
  assert.doesNotMatch(less, /## Trip/);
  // A changed text line is a new line under the id line above it.
  assert.deepEqual(
    lines(
      await run(
        diff,
        `await page.evaluate(() => (document.querySelector('p').textContent = 'Fares shown per group')); await bu.state()`,
      ),
    ),
    ['[state diff]', `@ after [${id}]`, '+Fares shown per group', '[/state]'],
  );
  // A text that reads the same in another place is a new line there: a new row may repeat an old row's text.
  assert.deepEqual(
    lines(
      await run(
        diff,
        `await page.evaluate(() => document.body.append(document.querySelector('p'))); await bu.state()`,
      ),
    ),
    ['[state diff]', `@ after [${idOf(first, 'Fare 11')}]`, '+Fares shown per group', '[/state]'],
  );
});

test('diff: a screen that moved a little is a diff with its line 2; a screen that moved a page is printed in full', async () => {
  const first = await open(diff, '/long');
  const small = lines(await run(diff, WHEEL(700, 400, 200)));
  assert.deepEqual(small.slice(0, 2), ['{}', '[state diff]']);
  assert.match(small[2], /^view 200-\d+ of \d+ px \| (\d+) controls above \| \d+ below$/);
  // What the model now knows is on screen: the last print without the ids that left, and the new lines.
  const [, from, to] = small[3].match(/^gone: (\d+)-(\d+)$/);
  const stayed = [...first.matchAll(/^\[(\d+)\] button "([^"]*)"$/gm)]
    .filter(([, id]) => Number(id) < Number(from) || Number(id) > Number(to))
    .map(([, , name]) => name);
  assert.match(small[4], /^@ after \[\d+\]$/);
  assert.equal(small[4], `@ after [${idOf(first, stayed.at(-1))}]`);
  const added = small.slice(5, -1).map((line) => line.match(/^\+\[\d+\] button "([^"]*)"$/)[1]);
  assert.deepEqual([...stayed, ...added], await onScreen(diff));
  assert.equal(small.at(-1), '[/state]');
  const big = await run(diff, WHEEL(700, 400, 800));
  assert.match(big, /^\{\}\n\[state\] fixture \| \S+\nview 1000-/);
  assert.deepEqual(printed(big), await onScreen(diff));
});

test('diff: a route change in the same document is a diff that names the new url and keeps ids; a new document is full', async () => {
  const spa = await open(diff, '/spa');
  const [go, kept] = [idOf(spa, 'Go next'), idOf(spa, 'Kept')];
  assert.deepEqual(lines(await run(diff, `await bu.click(${go})`)), [
    `[ok] click [${go}] button "Go next" -> navigated to ${fixture.url}/spa/next`,
    '',
    `[state diff] fixture | ${fixture.url}/spa/next`,
    `~[${go}] button "Go next" focused`,
    `@ after [${go}]`,
    '+## Next',
    '[/state]',
  ]);
  assert.deepEqual(lines(await run(diff, `await bu.click(${kept})`)), [
    `[ok] click [${kept}] button "Kept" -> page changed`,
    '',
    `[state diff] kept | ${fixture.url}/spa/next`,
    `~[${go}] button "Go next"`,
    `~[${kept}] button "Kept" focused`,
    '[/state]',
  ]);
  // The same url loaded again is a new document: full, though every line but the title reads the same.
  const again = await run(
    diff,
    `await page.goto(${JSON.stringify(fixture.url + '/spa/next')}); await bu.state()`,
  );
  assert.match(again, /^\[state\] fixture \| \S+\/spa\/next\n/);
  // A stale id: "the state below" is then the full one, though nothing changed since the last look.
  const stale = await fails(diff, `await bu.click(${kept})`);
  assert.equal(
    stale.split('\n')[0],
    `Error: click [${kept}] button "Kept" failed: stale: ${kept} belongs to a previous page; use ids from the state below`,
  );
  assert.equal(stale.slice(stale.indexOf('[state')).trim(), again.trim());
});

test('diff: more than 40 changed lines print in full', async () => {
  await open(diff, '/dense');
  const rename = (n, to) =>
    `await page.evaluate(() => [...document.querySelectorAll('button')].slice(0, ${n}).forEach((b, i) => (b.textContent = '${to}' + i))); await bu.state()`;
  assert.match(await run(diff, rename(41, 'X')), /^\[state\] fixture \| /);
  const forty = lines(await run(diff, rename(40, 'Y')));
  assert.equal(forty.length, 42);
  forty
    .slice(1, -1)
    .forEach((line, i) => assert.match(line, new RegExp(`^~\\[\\d+\\] button "Y${i}"$`)));
});

test('diff: after the agent compacted its history the next state is printed in full', async () => {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  // A scripted local model: it opens the page, then looks at it again and again while the history fills up.
  const call = (name, args) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  const cells = []; // per cell: was the history compacted right before it, and what it printed
  let summaries = 0;
  let seen = 0;
  const response = (context) => {
    if (!getCurrentTools(context.messages).length) {
      summaries++;
      return fauxAssistantMessage('Checkpoint: the page is open. Keep looking at it.');
    }
    const result = context.messages.findLast((m) => m.role === 'toolResult');
    if (result) cells.at(-1).text = result.content[0].text;
    if (cells.length > 8) return call('finish', { result: 'done' });
    cells.push({ compacted: summaries > seen });
    seen = summaries;
    return call('javascript', {
      code:
        cells.length === 1
          ? `await page.goto(${JSON.stringify(fixture.url + '/combo')}); await bu.state()`
          : `console.log('evidence '.repeat(800)); await bu.state()`,
    });
  };
  faux.setResponses(Array.from({ length: 30 }, () => response));
  const agent = await BrowserUse.create({
    model: `${faux.getModel().provider}/${faux.getModel().id}`,
    models,
    mode: 'ultrafast',
    ax: { state: 'v2', diff: true },
    browser: process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
    workspace,
    maxOutputChars: 8000,
  });
  try {
    const result = await agent.run('Look at the page.', { maxSteps: 20, maxContextChars: 35000 });
    assert.equal(result.status, 'completed');
    assert.ok(result.compactions > 0);
    assert.ok(cells.slice(1).some((cell) => cell.compacted));
    assert.match(cells[0].text, /^\[state\] fixture \| /);
    for (const cell of cells.slice(1))
      assert.ok(
        cell.compacted
          ? /\n\[state\] fixture \| \S+\/combo\nview /.test(cell.text)
          : cell.text.trimEnd().endsWith(`\n${SAME}`),
        `compacted ${cell.compacted}: ${cell.text.slice(-120)}`,
      );
  } finally {
    await agent.close();
  }
});

test('the prompt explains the diff lines and the stale error', () => {
  const stale =
    'in every CDP DOM command. Ids of an earlier page are stale: bu.click and bu.type refuse them; use the ids of the newest state.\n';
  assert.ok(axPrompt({ state: 'v2' }).includes(stale));
  assert.match(axPrompt({ state: 'v2' }), /; \* marks ids new since the last look\. After a /);
  const prompt = axPrompt({ state: 'v2', rawInput: true, diff: true });
  assert.ok(prompt.includes(stale));
  assert.ok(
    prompt.includes(
      'visible text. A later look at the same page may print only [state diff]: ~ a changed line, + a new line (@ after [id]: where it sits), gone: ids that left the screen; or [state same]. bu.state({full: true}) reprints all. After a javascript call whose bu actions or raw Input commands reached the page, the state is printed automatically.\n',
    ),
  );
  assert.doesNotMatch(prompt, /\* marks/);
  // Without the automatic print the diff sentence stays and the promise goes.
  assert.ok(
    axPrompt({ state: 'v2', rawInput: true, diff: true, autoState: false }).includes(
      'reprints all. The state is not printed after an action: look when you need it.\n',
    ),
  );
});

test('diff: line 1 after the tag keeps the loading count, and an accepted dialog is a line of the diff', async () => {
  // Last on this worker: the page keeps requests open, which holds each look for its 3 s cap.
  const save = idOf(await open(diff, '/alert'), 'Save');
  const out = lines(
    await run(
      diff,
      `const r = await page.evaluate(() => document.querySelector('button').getBoundingClientRect().toJSON()); await page.clickAt(r.x + 5, r.y + 5)`,
    ),
  );
  assert.match(
    out[1],
    new RegExp(`^\\[state diff\\] fixture \\| ${fixture.url}/alert \\| loading: \\d+$`),
  );
  assert.deepEqual(
    [out[0], ...out.slice(2)],
    [
      '[ok] raw input -> no change',
      '[dialog alert] "Saved it" (accepted)',
      `~[${save}] button "Save" focused`,
      '[/state]',
    ],
  );
});

test('small: a frame or page of at most that many screens prints whole, a longer one by screen', async () => {
  const small = await create({ state: 'v2', rawInput: true, small: 3 });
  try {
    // The frame shows 200 px of 60 buttons: without the switch a few print and the rest is counted.
    const framed = await open(small, '/scrollframe');
    assert.deepEqual(printed(framed), numbered('Framed', 60));
    assert.match(framed, /^\[\d+\] scroll area 0-200 of \d+ px \| 0 above \| 0 below$/m);
    // 40 rows of 50 px are under 3 screens: all print, and line 2 says nothing is hidden.
    const rows = numbered('Row', 40).map(
      (r) => `<button style="display:block;height:50px">${r}</button>`,
    );
    const page = await open(small, '', `data:text/html,${encodeURIComponent(rows.join(''))}`);
    assert.deepEqual(printed(page), numbered('Row', 40));
    assert.match(line2(page), /^view 0-(\d+) of 2\d\d\d px \| 0 controls above \| 0 below$/);
    // A long page and a long list are not small.
    const long = await open(small, '/long');
    assert.deepEqual(printed(long), await onScreen(small));
    assert.match(line2(long), /\| 0 controls above \| [1-9]\d* below$/);
    assert.match(
      await open(small, '/innerscroll'),
      /scroll area "Results" .* \| 0 above \| [1-9]\d* below$/m,
    );
  } finally {
    await small.close();
  }
});

test('cap: the print holds at most that many chars, and a page of any length prints whole with a large small', async () => {
  const whole = await create({ state: 'v2', small: 99, cap: 3000 });
  try {
    const state = await open(whole, '/long');
    assert.match(line2(state), /\| 0 controls above \| 0 below$/);
    const [marker] = state.match(/^\.\.\. \d+ on-screen lines cut at 3000 chars: .*$/m);
    assert.ok(state.trim().split('\n').slice(2, -1).join('\n').length <= 3000 + marker.length);
    assert.equal(printed(state)[0], 'Item 0');
    assert.ok(printed(state).length > (await onScreen(whole)).length);
  } finally {
    await whole.close();
  }
});

test('line 1 keeps the loading count and the dialog line follows line 2', async () => {
  // Last: the page keeps requests open, which holds each look for its 3 s cap.
  const state = await open(v2, '/alert');
  const out = await run(
    v2,
    `const r = await page.evaluate(() => document.querySelector('button').getBoundingClientRect().toJSON()); await page.clickAt(r.x + 5, r.y + 5)`,
  );
  const lines = out.trim().split('\n');
  assert.equal(lines[0], '[ok] raw input -> no change');
  assert.match(
    lines[1],
    new RegExp(`^\\[state\\] fixture \\| ${fixture.url}/alert \\| loading: \\d+$`),
  );
  assert.equal(lines[2], line2(state));
  assert.equal(lines[3], '[dialog alert] "Saved it" (accepted)');
});
