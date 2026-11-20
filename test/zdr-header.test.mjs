// Its own file: the cloud ZDR answer is process-wide and never resets, so it must not leak into other tests.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayPreflight } from '../dist/gateway.js';
import { sendJudgement } from '../dist/telemetry.js';

const SWITCHES = [
  'NODE_TEST_CONTEXT',
  'DO_NOT_TRACK',
  'ANONYMIZED_TELEMETRY',
  'BROWSER_USE_OFFLINE',
  'BROWSER_USE_ZDR',
];
const judgement = {
  success: false,
  failureReason: 'Zq9 reason',
  description: 'Zq9 did things',
  promptInjectionDetected: false,
  botBlockOrCaptchaDetected: true,
  gotchas: ['Zq9 gotcha'],
};

test('a gateway reply that says the project is ZDR withholds judgement texts like BROWSER_USE_ZDR=1', async (t) => {
  const saved = Object.fromEntries(SWITCHES.map((name) => [name, process.env[name]]));
  for (const name of SWITCHES) delete process.env[name];
  let reply = () => new Response('{}');
  const sent = [];
  const patch = mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://eu.i.posthog.com/')) {
      sent.push(JSON.parse(options.body).properties);
      return new Response('{}');
    }
    return reply();
  });
  t.after(() => {
    patch.mock.restore();
    for (const name of SWITCHES)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  const judge = () => {
    assert.equal(
      sendJudgement(undefined, { runId: 'r', model: 'm', judgement, costUsd: null }, {}),
      true,
    );
    return sent.pop();
  };
  const gateway = (status, zdr) => {
    reply = () =>
      new Response(
        JSON.stringify(status === 200 ? { data: [] } : { error: { code: 'project_policy' } }),
        {
          status,
          headers: zdr === undefined ? {} : { 'X-Browser-Use-Zero-Data-Retention': zdr },
        },
      );
    return gatewayPreflight('bu-fast', 'bu_key');
  };

  // Missing or false is unknown: texts go out as before.
  for (const [status, zdr] of [
    [200, undefined],
    [200, 'false'],
    [403, undefined],
  ]) {
    await gateway(status, zdr);
    const p = judge();
    assert.equal(p.texts_withheld, false, `${status} ${zdr}`);
    assert.match(p.description, /Zq9/);
  }

  // A ZDR project is refused with 403 project_policy; the header still says why, and stays for the process.
  assert.match(await gateway(403, 'true'), /403/);
  await gateway(200, 'false');
  const p = judge();
  assert.equal(p.texts_withheld, true);
  assert.equal(p.failure_reason, null);
  assert.equal(p.description, '');
  assert.deepEqual(p.gotchas, []);
  assert.equal(p.bot_block_or_captcha_detected, true);
  assert.doesNotMatch(JSON.stringify(p), /Zq9/);
});
