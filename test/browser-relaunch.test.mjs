import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { BrowserUse } from '../dist/index.js';
import { Browser, openBrowser } from '../dist/browser.js';
import { CDP } from '../dist/cdp.js';

const call = (name, args) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

async function session(responses, options = {}) {
  const faux = fauxProvider({ tokensPerSecond: 1000000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const workspace = await mkdtemp(join(tmpdir(), 'bu-relaunch-'));
  const agent = await BrowserUse.create({
    model: `${faux.getModel().provider}/${faux.getModel().id}`,
    models,
    workspace,
    telemetry: false,
    ...options,
  });
  return {
    agent,
    async close() {
      await agent.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

test('SDK-launched browsers report exit and relaunch; caller-owned browsers do not', async () => {
  const browser = await openBrowser(Browser.chromium({ headless: true }));
  try {
    assert.equal(browser.alive(), true);
    const first = browser.endpoint;
    await browser.close();
    assert.equal(browser.alive(), false);

    const relaunched = await browser.relaunch();
    try {
      assert.equal(relaunched.alive(), true);
      assert.notEqual(relaunched.endpoint, first);
      const cdp = await CDP.connect(relaunched.endpoint, 5000);
      try {
        assert.match((await cdp.send('Browser.getVersion')).product, /Chrome/);
      } finally {
        cdp.close();
      }
    } finally {
      await relaunched.close();
    }
    assert.equal(relaunched.alive(), false);
  } finally {
    await browser.close();
  }

  // A caller's Chrome is not ours to restart, so it exposes no relaunch.
  const attached = await openBrowser({ cdpUrl: 'ws://127.0.0.1:1' });
  assert.equal(attached.alive, undefined);
  assert.equal(attached.relaunch, undefined);
  await attached.close();
});

test('a session relaunches an exited browser instead of failing every later run', async () => {
  const f = await session([
    call('javascript', { code: 'await page.info()' }),
    call('finish', { result: 'first' }),
    call('finish', { result: 'second' }),
  ]);
  try {
    const first = await f.agent.run('first task', { maxSteps: 2 });
    assert.equal(first.status, 'completed');
    const dead = f.agent.browser.endpoint;

    // The Chrome process exits on its own: crash, taskkill, OS cleanup of temp files.
    // `browser` is the handle hosts already read (`session.browser.endpoint`) and there
    // is no public way to kill the process, so it is the honest stand-in here.
    await f.agent.browser.close();
    assert.equal(f.agent.browser.alive(), false);

    const events = f.agent.events();
    const warnings = [];
    const read = (async () => {
      for await (const event of events) if (event.type === 'warning') warnings.push(event.message);
    })();

    const second = await f.agent.run('second task', { maxSteps: 1 });
    assert.equal(second.status, 'completed');
    assert.equal(second.output, 'second');
    assert.notEqual(f.agent.browser.endpoint, dead);
    assert.equal(f.agent.browser.alive(), true);
    assert.ok(
      warnings.some((message) => /was relaunched/.test(message)),
      `expected a relaunch warning, saw ${JSON.stringify(warnings)}`,
    );
    await events.return();
    await read;
  } finally {
    // Closing a session whose browser was replaced, or is already gone, must not throw.
    await f.close();
  }
});

test('caller-owned browsers still fail loudly: nothing is relaunched for them', async () => {
  const f = await session([call('finish', { result: 'unused' })], {
    browser: Browser.chrome({ cdpUrl: 'ws://127.0.0.1:1' }),
  });
  try {
    await assert.rejects(f.agent.execute('await page.info()'), /Could not connect/);
  } finally {
    await f.close();
  }
});
