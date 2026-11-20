import { test, mock } from 'node:test';
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
import { scrub, modelId } from '../dist/scrub.js';
import {
  RunReports,
  sendJudgement,
  feedback,
  FEEDBACK_OFF,
  FEEDBACK_SENT,
  VERSION,
} from '../dist/telemetry.js';
import { BrowserRuntime } from '../dist/runtime.js';
import { BrowserUse } from '../dist/index.js';
import { SYSTEM_PROMPT } from '../dist/prompt.js';

const LIBRARY_TOKEN = 'phc_F8JMNjW1i2KbGUTaW1unnDdLSPCoyc52SGRU0JecaUh';
const SWITCHES = [
  'NODE_TEST_CONTEXT',
  'DO_NOT_TRACK',
  'ANONYMIZED_TELEMETRY',
  'BROWSER_USE_OFFLINE',
  'BROWSER_USE_ZDR',
  'BU_MODEL_CODE',
  'BROWSER_USE_TELEMETRY_INTERNAL',
];

/** Every test here: no switch set, fetch mocked (no network), the environment restored after. */
function sandbox(t) {
  const saved = Object.fromEntries(SWITCHES.map((name) => [name, process.env[name]]));
  for (const name of SWITCHES) delete process.env[name];
  const requests = [];
  const patch = mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...JSON.parse(options.body) });
    return new Response('{}');
  });
  t.after(() => {
    patch.mock.restore();
    for (const name of SWITCHES)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  return requests;
}

const judgement = {
  success: false,
  failureReason:
    'Login at https://shop.example.org/account?session=abc123 failed for jane.doe@example.com',
  description: 'The agent tried to find the cheapest flight from Berlin to Lisbon on Friday.',
  promptInjectionDetected: false,
  botBlockOrCaptchaDetected: true,
  gotchas: [
    'Saved results to /Users/jane/report.csv',
    'The API answered 401 with key sk-proj-ABCDEFGHIJKLMNOP',
    'Typing hunter2pass into the search box returned nothing',
    'Phone 0176 1234 5678 was shown',
    'Cookie banner blocks clicks',
    'a sixth gotcha is dropped',
  ],
};
const context = {
  tasks: ['Find the cheapest flight from Berlin to Lisbon on Friday'],
  typed: ['hunter2pass'],
  secrets: [['s3cr3t-value', 'password']],
};

test('scrub mirrors Python stats.scrub: task, typed, secrets, credentials, emails, URL queries, homes, numbers', () => {
  const text = [
    'quoted Find the cheapest flight from Berlin to Lisbon on Friday',
    'part: cheapest flight from Berlin to Lisbon please',
    'typed hunter2pass and searched /search/hunter2pass',
    'secret s3cr3t-value and its url form s3cr3t-value',
    'key sk-ant-api03-abcdefghijkl and Bearer abcDEF123456 password=Tr0ub4dor&3',
    'mail jane.doe@example.com at https://user:pw@shop.example.org:8443/reset-password/abc?x=1#y',
    'path /login?next=/home&sid=42 and home /Users/jane/Desktop and /home/bob/x',
    'call +49 176 1234 5678',
  ].join('\n');
  const out = scrub(text, 2000, context);
  for (const leak of [
    'cheapest flight',
    'hunter2pass',
    's3cr3t',
    'sk-ant',
    'abcDEF123456',
    'Tr0ub4dor',
    'jane',
    'pw@',
    'x=1',
    'sid=42',
    'bob',
    '1234',
  ])
    assert.doesNotMatch(out, new RegExp(leak), leak);
  assert.match(out, /quoted <task>/);
  assert.match(out, /part: <task>/);
  assert.match(out, /typed <typed>/);
  assert.match(out, /<secret:password>/);
  assert.match(out, /<email>/);
  assert.match(out, /https:\/\/<credential>@shop\.example\.org\/reset-password\/<token>(?!\S)/);
  assert.match(out, /path \/login and/);
  assert.match(out, /\/Users\/<user>\/Desktop/);
  assert.match(out, /<number>/);
  assert.equal(scrub('x'.repeat(5000), 300).length, 300);
  assert.equal(scrub(null, 300), null);
  assert.equal(modelId('openai/gpt-5.4'), 'openai/gpt-5.4');
  assert.equal(modelId('sk-abcdefghijklmnop'), 'other');
  assert.equal(modelId('/home/jane/models/llama'), 'llama');
});

test('library_judgement: spec fields, scrubbed and capped texts, library project, EU host', (t) => {
  const requests = sandbox(t);
  assert.equal(
    sendJudgement(
      undefined,
      { runId: 'run-1', model: 'faux/judge', judgement, costUsd: 0.0123 },
      context,
    ),
    true,
  );
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, 'https://eu.i.posthog.com/i/v0/e/');
  assert.equal(request.api_key, LIBRARY_TOKEN);
  assert.equal(request.event, 'library_judgement');
  const p = request.properties;
  assert.deepEqual(Object.keys(p).sort(), [
    '$geoip_disable',
    '$ip',
    '$process_person_profile',
    'bot_block_or_captcha_detected',
    'cost_usd',
    'description',
    'distinct_id',
    'failure_reason',
    'gotchas',
    'hosts',
    'is_internal',
    'judge_source',
    'model',
    'prompt_injection_detected',
    'run_id',
    'schema_version',
    'success',
    'surface',
    'texts_withheld',
    'version',
  ]);
  assert.equal(p.surface, 'js');
  assert.equal(p.judge_source, 'judge');
  assert.equal(p.version, VERSION);
  assert.equal(p.run_id, 'run-1');
  assert.equal(p.model, 'faux/judge');
  assert.equal(p.success, false);
  assert.equal(p.bot_block_or_captcha_detected, true);
  assert.equal(p.prompt_injection_detected, false);
  assert.equal(p.gotchas.length, 5);
  assert.deepEqual(p.hosts, []);
  assert.equal(p.cost_usd, 0.0123);
  assert.equal(p.texts_withheld, false);
  assert.equal(p.schema_version, 1);
  assert.equal(p.is_internal, false);
  assert.equal(p.$process_person_profile, false);
  assert.match(p.description, /<task>/);
  assert.match(p.failure_reason, /<email>/);
  assert.match(p.failure_reason, /https:\/\/shop\.example\.org\/account failed/);
  const sent = JSON.stringify(requests);
  for (const leak of ['Berlin', 'jane', 'session=', 'sk-proj', 'hunter2pass', '1234 5678'])
    assert.doesNotMatch(sent, new RegExp(leak), leak);
  for (const text of [p.failure_reason, p.description, ...p.gotchas]) assert.ok(text.length <= 300);
});

test('library_judgement: BROWSER_USE_ZDR=1 sends booleans only; every off switch sends nothing', (t) => {
  const requests = sandbox(t);
  const run = { runId: 'r', model: 'm', judgement, costUsd: null };
  // Python config.py reads a flag as on when it starts with t, y or 1.
  for (const value of ['1', 'true', 'True', ' yes']) {
    process.env.BROWSER_USE_ZDR = value;
    sendJudgement(undefined, run, context);
    const p = requests.pop().properties;
    assert.equal(p.texts_withheld, true, value);
    assert.equal(p.failure_reason, null);
    assert.equal(p.description, '');
    assert.deepEqual(p.gotchas, []);
    assert.equal(p.success, false);
    assert.equal(p.bot_block_or_captcha_detected, true);
  }
  delete process.env.BROWSER_USE_ZDR;

  assert.equal(sendJudgement(false, run, context), false);
  for (const [name, value] of [
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['ANONYMIZED_TELEMETRY', 'false'],
    ['ANONYMIZED_TELEMETRY', 'False'],
    ['ANONYMIZED_TELEMETRY', 'no'],
    ['ANONYMIZED_TELEMETRY', 'off'],
    ['ANONYMIZED_TELEMETRY', ''],
    ['BROWSER_USE_OFFLINE', '1'],
    ['BROWSER_USE_OFFLINE', 'true'],
    ['BROWSER_USE_OFFLINE', 'yes'],
    ['NODE_TEST_CONTEXT', 'child'],
  ]) {
    process.env[name] = value;
    assert.equal(sendJudgement(true, run, context), false, name);
    delete process.env[name];
  }
  assert.equal(requests.length, 0);
});

test('feedback(): the developer asked, so it sends with telemetry off; never offline or from model code', (t) => {
  const requests = sandbox(t);
  process.env.DO_NOT_TRACK = '1';
  process.env.ANONYMIZED_TELEMETRY = 'false';
  process.env.BROWSER_USE_TELEMETRY_INTERNAL = '1';
  assert.equal(feedback('page.typeText drops emoji, key sk-ant-abcdefghijkl', 'weird'), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].event, 'library_feedback');
  assert.equal(requests[0].api_key, LIBRARY_TOKEN);
  assert.deepEqual(requests[0].properties, {
    distinct_id: requests[0].properties.distinct_id,
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: null,
    version: VERSION,
    source: 'js',
    message: 'page.typeText drops emoji, key <credential>',
    category: 'other',
    is_internal: true,
    model: null,
    run_id: null,
    step: null,
    last_error_type: null,
  });
  assert.equal(feedback('   '), false);
  process.env.BROWSER_USE_OFFLINE = '1';
  assert.equal(feedback('offline'), false);
  delete process.env.BROWSER_USE_OFFLINE;
  process.env.BU_MODEL_CODE = '1';
  assert.equal(feedback('from the model'), false);
  assert.equal(requests.length, 1);
});

test('model reports: 3 per run, scrubbed of task and typed text, nothing with telemetry off', (t) => {
  const requests = sandbox(t);
  const reports = new RunReports(undefined);
  reports.start('run-7', 'faux/judge-test');
  const progress = { step: 4, lastErrorType: 'TypeError' };
  for (let i = 0; i < 3; i++)
    assert.equal(
      reports.report(
        `typed hunter2pass then Berlin to Lisbon on Friday broke ${i}`,
        'docs',
        context,
        progress,
      ),
      FEEDBACK_SENT,
    );
  assert.match(reports.report('fourth', 'bug', context, progress), /Already reported 3/);
  assert.match(reports.report('  ', 'bug', context, progress), /needs text/);
  assert.equal(requests.length, 3);
  const p = requests[0].properties;
  assert.equal(p.source, 'js-agent');
  assert.equal(p.category, 'docs');
  assert.equal(p.run_id, 'run-7');
  assert.equal(p.model, 'faux/judge-test');
  assert.equal(p.step, 4);
  assert.equal(p.last_error_type, 'TypeError');
  assert.equal(p.message, 'typed <typed> then <task> broke 0');
  reports.start('run-8', 'm');
  assert.equal(reports.report('again', 'bug', context, progress), FEEDBACK_SENT);

  for (const [enabled, name, value] of [
    [false],
    [undefined, 'DO_NOT_TRACK', '1'],
    [undefined, 'ANONYMIZED_TELEMETRY', 'false'],
    [undefined, 'BROWSER_USE_OFFLINE', '1'],
  ]) {
    if (name) process.env[name] = value;
    const off = new RunReports(enabled);
    off.start('r', 'm');
    assert.equal(off.report('x', 'bug', context, progress), FEEDBACK_OFF);
    if (name) delete process.env[name];
  }
  assert.equal(requests.length, 4);
});

test('the prompt names reportIssue as Python prompt.py names report_issue', () => {
  assert.match(
    SYSTEM_PROMPT,
    /- await reportIssue\(message\) tells the Browser Use team when browser-use gets in your way: a helper or the browser misbehaves, an error or these instructions mislead you, or a helper you need is missing\. Not for a website's own problems\./,
  );
});

test('worker: reportIssue() asks the parent, sees typed text, runs as model code', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'bu-feedback-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runtime = new BrowserRuntime({
    endpoint: 'ws://127.0.0.1:1',
    workspace,
    operationTimeoutMs: 50,
    maxOutputChars: 2000,
  });
  t.after(() => runtime.close());
  const calls = [];
  runtime.onFeedback = (message, category, typed) => {
    calls.push({ message, category, typed: [...typed] });
    return 'answered';
  };
  runtime.beginRun();
  const cell = await runtime.execute(
    [
      // The CDP hook the cell's typing goes through (Input.insertText, then a key run ended by Enter).
      "browser.observeCommand('Input.insertText', {text: 'hunter2pass'});",
      "for (const text of 'abcd') browser.observeCommand('Input.dispatchKeyEvent', {type: 'char', text});",
      "console.log(await reportIssue('it broke', 'docs'), await report_issue('again'), process.env.BU_MODEL_CODE);",
      "try { await reportIssue('  ') } catch (e) { console.log(e.message) }",
    ].join('\n'),
  );
  assert.match(cell.text, /answered answered 1/);
  assert.match(cell.text, /needs text/);
  assert.deepEqual(calls, [
    { message: 'it broke', category: 'docs', typed: ['hunter2pass', 'hunter2passabcd', 'abcd'] },
    { message: 'again', category: 'bug', typed: ['hunter2pass', 'hunter2passabcd', 'abcd'] },
  ]);
  assert.deepEqual(runtime.typed, ['hunter2pass', 'hunter2passabcd', 'abcd']);
  runtime.beginRun();
  assert.deepEqual(runtime.typed, []);

  // The helpers' own sequences: ax.type inserts all but the last character, then sends it as a keyDown with text;
  // page.pressKey sends keyDown without text, then char. Each is one typed text; a shortcut or a click ends a run.
  await runtime.execute(
    [
      'const o = (m, p) => browser.observeCommand(m, p);',
      "o('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'a', modifiers: 2, commands: ['selectAll']});",
      "o('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', modifiers: 2});",
      "o('Input.insertText', {text: 'swordfish9'}); o('Input.dispatchKeyEvent', {type: 'keyDown', key: 'x', text: 'x'});",
      "o('Input.dispatchKeyEvent', {type: 'keyUp', key: 'x'});",
      "o('Input.dispatchMouseEvent', {type: 'mousePressed', x: 1, y: 1});",
      "for (const k of 'qwer') { o('Input.dispatchKeyEvent', {type: 'keyDown', key: k}); o('Input.dispatchKeyEvent', {type: 'char', key: k, text: k}); o('Input.dispatchKeyEvent', {type: 'keyUp', key: k}); }",
      "o('Input.dispatchKeyEvent', {type: 'keyDown', key: 'c', text: 'c', modifiers: 2});",
      "o('Input.insertText', {text: 'swordfish9'});",
    ].join('\n'),
  );
  assert.deepEqual(runtime.typed, ['swordfish9', 'swordfish9x', 'x', 'qwer']);
  assert.doesNotMatch(
    scrub('Typing swordfish9x then qwer into search failed', 300, { typed: runtime.typed }),
    /swordfish|qwer/,
  );
});

test('a judged run sends bu_pi_run, its reports and library_judgement, with no task or typed text', async (t) => {
  const requests = sandbox(t);
  const workspace = await mkdtemp(join(tmpdir(), 'bu-library-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const provider = fauxProvider({
    tokensPerSecond: 1e6,
    models: [{ id: 'judge-test', input: ['text'] }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel();
  const cell = fauxAssistantMessage(
    fauxToolCall('javascript', {
      code: [
        "browser.observeCommand('Input.insertText', {text: 'hunter2pass'});",
        'for (let i = 0; i < 4; i++) console.log(await reportIssue(`typed hunter2pass, mail jane@example.com, cheapest flight from Berlin to Lisbon ${i}`));',
      ].join('\n'),
    }),
    { stopReason: 'toolUse' },
  );
  const finish = fauxAssistantMessage(fauxToolCall('finish', { result: 'none found' }), {
    stopReason: 'toolUse',
  });
  const judged = fauxAssistantMessage(fauxToolCall('judgement', judgement), {
    stopReason: 'toolUse',
  });
  provider.setResponses([cell, finish, judged]);
  const agent = await BrowserUse.create({
    model: `${model.provider}/${model.id}`,
    models,
    browser: { cdpUrl: 'http://127.0.0.1:9' },
    workspace,
    sensitiveData: { password: { value: 's3cr3t-value', domains: ['example.org'] } },
  });
  try {
    const result = await agent.run(context.tasks[0]);
    assert.equal(result.judgement.success, false);
  } finally {
    await agent.close();
  }
  assert.deepEqual(
    requests.map((r) => r.event),
    ['library_feedback', 'library_feedback', 'library_feedback', 'bu_pi_run', 'library_judgement'],
  );
  const reports = requests.filter((r) => r.event === 'library_feedback');
  assert.equal(reports[0].properties.message, 'typed <typed>, mail <email>, <task> 0');
  assert.equal(reports[0].properties.step, 1);
  const runId = reports[0].properties.run_id;
  assert.match(runId, /^[0-9a-f-]{36}$/);
  const verdict = requests.at(-1).properties;
  assert.equal(verdict.run_id, runId);
  assert.equal(verdict.model, `${model.provider}/${model.id}`);
  assert.equal(typeof verdict.cost_usd, 'number');
  assert.match(verdict.gotchas[2], /Typing <typed> into/);
  assert.doesNotMatch(JSON.stringify(requests), /hunter2|Berlin|jane|s3cr3t|sk-proj/);
});
