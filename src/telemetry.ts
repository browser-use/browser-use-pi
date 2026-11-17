import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { BrowserOptions } from './browser.js';
import type { Judgement } from './judge.js';
import { modelId, scrub, type ScrubContext } from './scrub.js';
import type { RunResult } from './types.js';

// Public, write-only PostHog project token. EU ingestion; no SDK or persistent identifier.
const token = 'phc_tcNY9BmpauyrDHDVhrhkFCaQEpH3vMnx3TDUZ49TWCek';
/** The browser-use library project (Python browser_use/telemetry/service.py): library_judgement and library_feedback. */
const LIBRARY_TOKEN = 'phc_F8JMNjW1i2KbGUTaW1unnDdLSPCoyc52SGRU0JecaUh';
const ENDPOINT = 'https://eu.i.posthog.com/i/v0/e/';
const processId = randomUUID();
export const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return '0.1.0';
  }
})();

/** Python config.py: a flag is on when its value starts with t, y or 1 (true, yes, 1, True). */
const on = (name: string) =>
  ['t', 'y', '1'].includes((process.env[name] ?? '').trim().toLowerCase().slice(0, 1));
/** BROWSER_USE_OFFLINE=1: nothing at all is sent, also feedback a developer sends. Node tests send nothing either. */
const offline = () => on('BROWSER_USE_OFFLINE') || !!process.env.NODE_TEST_CONTEXT;
/** Usage stats off: telemetry: false, DO_NOT_TRACK=1 or ANONYMIZED_TELEMETRY=false (and offline). */
export function telemetryOff(enabled: boolean | undefined) {
  return (
    enabled === false ||
    on('DO_NOT_TRACK') ||
    // Python config.py: set, telemetry stays on only for a value starting with t, y or 1 (false, no, off, 0 turn it off).
    (process.env.ANONYMIZED_TELEMETRY !== undefined && !on('ANONYMIZED_TELEMETRY')) ||
    offline()
  );
}

function post(api_key: string, event: string, properties: Record<string, unknown>) {
  // Bounded and best-effort. Telemetry cannot change the run result or trigger retries.
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key,
      event,
      properties: {
        distinct_id: processId,
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
        ...properties,
      },
    }),
    signal: AbortSignal.timeout(1000),
    redirect: 'error',
  }).catch(() => {});
}

export function telemetry(enabled: boolean | undefined, browser: BrowserOptions | undefined) {
  const disabled = telemetryOff(enabled);
  const kind =
    browser?.kind ?? (browser && 'cdpUrl' in browser && browser.cdpUrl ? 'cdp' : 'chromium');
  return (result: RunResult<unknown>): void => {
    if (disabled) return;
    // Explicit allowlist. Never spread config/results: they contain tasks, paths and credentials.
    post(token, 'bu_pi_run', {
      sdk_version: VERSION,
      os: process.platform,
      node_major: process.versions.node.split('.')[0],
      browser: kind,
      status: result.status,
      steps: result.steps,
      duration_ms: result.durationMs,
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      estimated_cost_usd: result.usage.cost.total,
    });
  };
}

const MAX_TEXT = 300;
const MAX_GOTCHAS = 5;
const MAX_MESSAGE = 2000;
export const MAX_REPORTS = 3;
export const CATEGORIES = ['bug', 'docs', 'missing', 'other'] as const;
const isInternal = () => on('BROWSER_USE_TELEMETRY_INTERNAL');

/** library_judgement (judgement-event-spec.md), one per judged run. false when nothing was sent. */
export function sendJudgement(
  enabled: boolean | undefined,
  run: { runId: string; model: string; judgement: Judgement; costUsd: number | null },
  context: ScrubContext,
): boolean {
  if (telemetryOff(enabled)) return false;
  const withheld = on('BROWSER_USE_ZDR');
  const clean = (text: unknown) => (withheld ? null : scrub(text, MAX_TEXT, context));
  const { judgement } = run;
  return guarded(() =>
    post(LIBRARY_TOKEN, 'library_judgement', {
      surface: 'js',
      judge_source: 'judge',
      version: VERSION,
      run_id: run.runId || null,
      model: run.model ? modelId(run.model) : null,
      success: judgement.success,
      failure_reason: judgement.failureReason ? clean(judgement.failureReason) : null,
      description: clean(judgement.description) ?? '',
      prompt_injection_detected: judgement.promptInjectionDetected,
      bot_block_or_captcha_detected: judgement.botBlockOrCaptchaDetected,
      gotchas: withheld
        ? []
        : judgement.gotchas
            .slice(0, MAX_GOTCHAS)
            .map(clean)
            .filter((g): g is string => !!g),
      hosts: [],
      cost_usd: run.costUsd,
      texts_withheld: withheld,
      // Not in the spec's table, but Python (LibraryJudgementEvent) and browser-harness send it: our evals filter on it.
      is_internal: isInternal(),
      schema_version: 1,
    }),
  );
}

/** Telemetry never breaks a run (Python: telemetry failed, logged at debug): a scrub that throws sends nothing. */
function guarded(send: () => void): boolean {
  try {
    send();
    return true;
  } catch {
    return false;
  }
}

function sendFeedback(
  source: 'js' | 'js-agent',
  message: string,
  category: unknown,
  context: ScrubContext,
  run: { model?: string; runId?: string; step?: number; lastErrorType?: string | null } = {},
) {
  post(LIBRARY_TOKEN, 'library_feedback', {
    version: VERSION,
    source,
    message: scrub(message, MAX_MESSAGE, context) ?? '',
    category: (CATEGORIES as readonly unknown[]).includes(category) ? category : 'other',
    is_internal: isInternal(),
    // Python FeedbackEvent sends these as null outside the agent: the same keys from every source.
    model: run.model ? modelId(run.model) : null,
    run_id: run.runId || null,
    step: run.step ?? null,
    last_error_type: run.lastErrorType ?? null,
  });
}

/**
 * Tell the Browser Use team what went wrong with Browser Use JS: a bug, wrong docs, a missing feature. category: 'bug',
 * 'docs', 'missing' or 'other'. Sent in the background, also with telemetry off (you asked to send it), never with
 * BROWSER_USE_OFFLINE=1; secrets, API keys, emails, URL queries and home folders in the text are replaced first.
 * True if it was sent; false without text, offline, or from the agent's own code (it has reportIssue()).
 */
export function feedback(message: string, category: string = 'bug'): boolean {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text || offline() || process.env.BU_MODEL_CODE) return false;
  return guarded(() => sendFeedback('js', text, category, {}));
}

export const FEEDBACK_SENT = 'Reported to the Browser Use team. Thanks; carry on.';
export const FEEDBACK_OFF =
  'Feedback is off (telemetry: false, DO_NOT_TRACK=1, ANONYMIZED_TELEMETRY=false or BROWSER_USE_OFFLINE=1): nothing was sent.';

/** reportIssue() for one BrowserUse: the model's reports, at most MAX_REPORTS per run, nothing with telemetry off. */
export class RunReports {
  private sent = 0;
  private run: { runId: string; model: string } = { runId: '', model: '' };
  constructor(private readonly enabled: boolean | undefined) {}
  start(runId: string, model: string) {
    this.run = { runId, model };
    this.sent = 0;
  }
  report(
    message: unknown,
    category: unknown,
    context: ScrubContext,
    progress: { step: number; lastErrorType?: string | null },
  ): string {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return 'reportIssue(message) needs text: nothing was sent.';
    if (telemetryOff(this.enabled)) return FEEDBACK_OFF;
    if (this.sent >= MAX_REPORTS)
      return `Already reported ${MAX_REPORTS} issues this run: nothing more was sent.`;
    if (
      !guarded(() =>
        sendFeedback('js-agent', text, category, context, { ...this.run, ...progress }),
      )
    )
      return 'The report could not be prepared: nothing was sent.';
    this.sent++;
    return FEEDBACK_SENT;
  }
}
