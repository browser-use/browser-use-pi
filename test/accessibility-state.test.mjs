import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CDP, Page } from '../dist/index.js';
import { openBrowser } from '../dist/browser.js';

test('snapshots preserve observed control state and refresh it after real input', async () => {
  const chrome = await openBrowser();
  const cdp = await CDP.connect(chrome.endpoint);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await Page.attach(cdp, targetId);
    await page.goto(
      'data:text/html,' +
        encodeURIComponent(`
      <label><input type="radio" name="sort" checked>Featured</label>
      <label><input type="radio" name="sort">Newest</label>
      <label><input id="mixed" type="checkbox">Partial</label>
      <button id="expand" aria-expanded="false"
        onclick="this.setAttribute('aria-expanded', 'true')">Details</button>
      <button id="toggle" aria-pressed="false"
        onclick="this.setAttribute('aria-pressed', 'true')">Pin</button>
      <button aria-pressed="mixed">Mixed toggle</button>
      <button disabled>Unavailable</button>
      <button>Ordinary</button>
      <div role="listbox" aria-label="Items">
        <div role="option" aria-selected="false">First</div>
        <div role="option" aria-selected="true">Second</div>
      </div>
      <script>document.querySelector('#mixed').indeterminate = true;</script>
    `),
    );
    const first = (await page.snapshot()).nodes;
    const byName = (nodes, name) => {
      const matches = nodes.filter(
        (node) =>
          node.name === name && ['radio', 'checkbox', 'button', 'option'].includes(node.role),
      );
      assert.equal(matches.length, 1, name);
      return matches[0];
    };
    assert.equal(byName(first, 'Featured').checked, true);
    assert.equal(byName(first, 'Newest').checked, false);
    assert.equal(byName(first, 'Partial').checked, 'mixed');
    assert.equal(byName(first, 'Details').expanded, false);
    assert.equal(byName(first, 'Pin').pressed, false);
    assert.equal(byName(first, 'Mixed toggle').pressed, 'mixed');
    assert.equal(byName(first, 'Unavailable').disabled, true);
    assert.equal(byName(first, 'First').selected, false);
    assert.equal(byName(first, 'Second').selected, true);
    for (const key of ['checked', 'selected', 'expanded', 'pressed', 'disabled'])
      assert.equal(Object.hasOwn(byName(first, 'Ordinary'), key), false, key);

    for (const name of ['Newest', 'Details', 'Pin']) {
      const id = (await page.snapshot()).nodes.find(
        (n) => n.name === name && ['radio', 'button'].includes(n.role),
      ).id;
      const q = (await page.cdp('DOM.getBoxModel', { backendNodeId: id })).model.content;
      await page.clickAt((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
    }
    const second = (await page.snapshot()).nodes;
    assert.equal(byName(second, 'Featured').checked, false);
    assert.equal(byName(second, 'Newest').checked, true);
    assert.equal(byName(second, 'Details').expanded, true);
    assert.equal(byName(second, 'Pin').pressed, true);
    assert.equal(byName(first, 'Featured').checked, true, 'earlier observations remain unchanged');

    await page.goto('data:text/html,<button>New document</button>');
    assert.equal(
      (await page.snapshot()).nodes.some((node) => node.name === 'Newest'),
      false,
    );
  } finally {
    cdp.close();
    await chrome.close();
  }
});

test('snapshots include control state inside shadow DOM', async () => {
  const chrome = await openBrowser();
  const cdp = await CDP.connect(chrome.endpoint);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await Page.attach(cdp, targetId);
    await page.goto('data:text/html,<div id="host"></div>');
    await page.evaluate(
      () =>
        (document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML =
          '<input type="checkbox" checked aria-label="Shadow">'),
    );
    assert.equal((await page.snapshot()).nodes.find((n) => n.name === 'Shadow').checked, true);
  } finally {
    cdp.close();
    await chrome.close();
  }
});

test('snapshots leave out text that is not shown', async () => {
  const chrome = await openBrowser();
  const cdp = await CDP.connect(chrome.endpoint);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const page = await Page.attach(cdp, targetId);
    // A success line rendered ahead of time and revealed later, hidden each of the ways pages hide it.
    await page.goto(
      'data:text/html,' +
        encodeURIComponent(`
      <h1>Sign up</h1>
      <p>Fill in the form</p>
      <div id="faded" style="opacity:0">Form submitted successfully</div>
      <div id="unseen" style="visibility:hidden">Challenge completed</div>
      <div style="opacity:0"><span>Thanks for signing up</span></div>
      <div style="display:contents"><span>Shown through its parent</span></div>
      <div id="host"></div>
      <button>Submit</button>
      <script>
        document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML =
          '<p>Inside a shadow root</p><p style="opacity:0">Shadow success</p>';
      </script>
    `),
    );
    const texts = async () =>
      (await page.snapshot()).nodes
        .filter((n) => n.role === 'StaticText')
        .map((n) => n.name)
        .sort();
    const shown = [
      'Fill in the form',
      'Inside a shadow root',
      'Shown through its parent',
      'Sign up',
      'Submit',
    ];
    assert.deepEqual(await texts(), shown);
    // Everything that is not text stays: hidden text is all the filter removes.
    const roles = (await page.snapshot()).nodes.map((n) => n.role);
    for (const role of ['RootWebArea', 'heading', 'button']) assert.ok(roles.includes(role), role);

    await page.evaluate(() => {
      document.querySelector('#faded').style.opacity = '1';
      document.querySelector('#unseen').style.visibility = 'visible';
    });
    assert.deepEqual(
      await texts(),
      [...shown, 'Challenge completed', 'Form submitted successfully'].sort(),
    );
  } finally {
    cdp.close();
    await chrome.close();
  }
});
