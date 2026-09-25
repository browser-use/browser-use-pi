import { writeFile } from 'node:fs/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { openBrowser } from '../dist/browser.js';
import { BrowserRuntime } from '../dist/runtime.js';
import { runAgent, zeroUsage } from '../dist/agent.js';
import { RunControl } from '../dist/control.js';
import { deadlineStream } from '../dist/model-stream.js';
import { SYSTEM_PROMPT } from '../dist/prompt.js';
import { SHORT_PROMPT } from './short-prompt.mjs';

/** Client-observed request time and time to first token for every model call (incl. compaction). */
export function measureInference(base, records, timeoutMs = 300000) {
  const bounded = deadlineStream(base, timeoutMs);
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const start = performance.now();
    const record = { index: records.length, model: `${model.provider}/${model.id}`, status: 'pending', durationMs: 0 };
    records.push(record);
    void (async () => {
      for await (const event of bounded(model, context, options)) {
        if (event.type.endsWith('_delta') && record.firstTokenMs === undefined) record.firstTokenMs = performance.now() - start;
        if (event.type === 'done' || event.type === 'error') {
          record.durationMs = performance.now() - start;
          record.status = event.type === 'done' ? 'completed' : event.reason;
          record.usage = event.type === 'done' ? event.message.usage : event.error.usage;
        }
        output.push(event);
      }
      output.end();
    })();
    return output;
  };
}

/** Pi + strict AX helpers (`bu`) on an existing CDP endpoint. Variant knobs are explicit and recorded. */
export async function createAxSession({ endpoint, workspace, model, models, reasoning = 'low', instructions = '', variant = {} }) {
  const browser = await openBrowser({ cdpUrl: endpoint });
  const ax = { ...(variant.ax ?? {}), ...(variant.fetchUse && process.env.MODEL_PROXY ? { fetchProxy: process.env.MODEL_PROXY + '/fetchuse' } : {}) };
  const runtime = new BrowserRuntime({ semantic: true, ax, endpoint: browser.endpoint, workspace,
    operationTimeoutMs: variant.operationTimeoutMs ?? 15000, maxOutputChars: variant.maxOutputChars ?? 12000 });
  const inference = [];
  await runtime.initialize();
  const config = {
    model: `${model.provider}/${model.id}`, models, reasoning, tools: [], telemetry: false, semantic: {},
    modelTimeoutMs: 300000, hookTimeoutMs: 45000, cellTimeoutMs: variant.cellTimeoutMs ?? 180000,
    instructions: [variant.extraPrompt ?? '', instructions].filter(Boolean).join('\n'),
    streamFn: (() => {
      const measured = measureInference(models.streamSimple.bind(models), inference);
      // Variant shortPrompt swaps only Pi's browser-mechanics prompt; planner, tools, compaction and completion stay.
      return (m, context, options) => measured(m, variant.shortPrompt && context.systemPrompt?.startsWith(SYSTEM_PROMPT)
        ? { ...context, systemPrompt: SHORT_PROMPT + context.systemPrompt.slice(SYSTEM_PROMPT.length) } : context, options);
    })(),
  };
  return {
    runtime, inference,
    async run(task, options = {}) {
      let seeded;
      if (variant.seed !== false) {
        // Real host observation as a synthetic first tool call: no invented model output or usage.
        const code = 'await bu.state()';
        const observed = await runtime.execute(code, 30000, options.signal);
        await writeFile(workspace + '/initial-state.json', JSON.stringify({ text: observed.text }, null, 2));
        const id = 'host-initial-browser-state';
        seeded = { messages: [
          { role: 'assistant', content: [{ type: 'toolCall', id, name: 'javascript', arguments: { code } }],
            api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: 'toolUse', timestamp: Date.now() },
          { role: 'toolResult', toolCallId: id, toolName: 'javascript', content: [{ type: 'text', text: observed.text }], isError: false, timestamp: Date.now() },
        ], control: new RunControl(() => {}), save: () => {} };
      }
      const start = performance.now();
      try {
        const result = await runAgent(runtime, model, config, workspace, task, options.schema ?? Type.String(), options, seeded);
        return { ...result, variant, modelRequestMs: inference.reduce((s, c) => s + c.durationMs, 0), endToEndMs: performance.now() - start, modelCalls: inference };
      } finally {
        seeded?.control.finish();
      }
    },
    async close() {
      try { await runtime.close(); } finally { await browser.close(); }
    },
  };
}
