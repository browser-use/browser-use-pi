import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import { BrowserUse } from '../dist/index.js';
import { auditedStream } from '../eval/audit.mjs';
import { parseOptions } from '../eval/run.mjs';
test('mode and service tier are explicit validated eval options', () => {
  assert.equal(
    parseOptions({ mode: 'ultrafast', service_tier: 'priority', cell_timeout_ms: 180000 }).mode,
    'ultrafast',
  );
  assert.throws(() => parseOptions({ mode: 'unknown' }), /Invalid mode/);
  assert.throws(() => parseOptions({ service_tier: 'unknown' }), /Invalid service_tier/);
});
test('audit preserves streams and records auxiliary calls plus every HTTP attempt', async () => {
  const records = [],
    pending = [];
  const request = async () => new Response('ok');
  const original = (_m, _c, opts) => {
    const done = (async () => {
      await opts.onPayload({
        model: 'fixture',
        reasoning: { effort: 'low' },
        tools: [],
        input: [],
      });
      await opts.fetch('https://fixture.invalid');
      await opts.fetch('https://fixture.invalid');
      return {
        stopReason: 'stop',
        usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 19 },
      };
    })();
    return { result: () => done };
  };
  const wrapped = auditedStream(original, records, pending, 'priority');
  const streams = [
    wrapped({ id: 'fixture' }, { messages: [] }, { fetch: request }),
    wrapped({ id: 'fixture' }, { messages: [] }, { fetch: request }),
  ];
  await Promise.all(streams.map((s) => s.result()));
  await Promise.all(pending);
  assert.equal(records.length, 2);
  assert.equal(
    records.reduce((n, r) => n + r.http.length, 0),
    4,
  );
  assert.ok(records.every((r) => r.request.service_tier === 'priority' && r.usage.input === 12));
});
test('high-cap ultrafast run passes 75 turns and preserves the helper prompt', async () => {
  const faux = fauxProvider({ tokensPerSecond: 1000000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let calls = 0;
  const reply = (context) => {
    calls++;
    assert.match(
      getCurrentSystemPrompt(context.messages),
      /(?:Fast browser helpers|Browser action helpers)/,
    );
    assert.doesNotMatch(JSON.stringify(context.messages), /Budget nearly exhausted/);
    return fauxAssistantMessage(
      fauxToolCall(
        calls <= 78 ? 'javascript' : 'finish',
        calls <= 78
          ? { code: "if(typeof bu!=='object')throw Error('missing bu');void 0" }
          : { result: 'done' },
      ),
    );
  };
  faux.setResponses(Array.from({ length: 79 }, () => reply));
  const agent = await BrowserUse.create({
    model: faux.getModel().provider + '/' + faux.getModel().id,
    models,
    mode: 'ultrafast',
    telemetry: false,
    browser: {
      executablePath: process.env.BROWSER_EXECUTABLE_PATH,
      profileDir: process.env.PILOT_PROFILE,
    },
  });
  try {
    const run = await agent.run('Exercise high budget', { maxSteps: 10000, timeoutMs: 60000 });
    assert.equal(run.status, 'completed');
    assert.equal(run.steps, 79);
    assert.equal(calls, 79);
  } finally {
    await agent.close();
  }
});
