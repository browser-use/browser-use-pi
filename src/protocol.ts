import type { DomainOptions as importPolicy } from './policy.js';
export interface BrowserAction {
  kind: string;
  targetId: string;
  x?: number;
  y?: number;
}
export interface Image {
  type: 'image';
  data: string;
  mimeType: string;
}
export interface CellResult {
  text: string;
  images: Image[];
  /** Primary page binding after this cell, retained for worker recovery. */
  targetId?: string;
  /** Most recently used protocol target, independent of the primary page binding. */
  observationTargetId?: string;
  /** The tab this cell's own code last sent a command to, e.g. a `const page = await tabs.open()`. */
  activeTargetId?: string;
  /** JSON delivery channel; never clipped to the observation budget. */
  valueJson?: string;
  /** Full output is written to the workspace when the model-facing output is truncated. */
  outputFile?: string;
}
/** Ultrafast experiments. Each switch is off by default, and off is today's behavior. */
export interface AxOptions {
  /**
   * 'v2': bu.state() prints what is on screen, with the scroll position on line 2, and bu.click and bu.type
   * refuse an id of a previous page. 'v1' is today.
   */
  state?: 'v1' | 'v2';
  /** A javascript call that sent raw Input.* commands ends like one with a bu action: page wait, verdict line, state. */
  rawInput?: boolean;
  /** Adds bu.scroll, to compare against a raw wheel event. */
  scroll?: boolean;
  /** false: no state is printed after an acting call; the model calls bu.state() when it wants it. */
  autoState?: boolean;
  /**
   * With state 'v2': a later look at the same page prints only what changed ([state diff]) when that is at
   * most half the full print, and [state same] when nothing did. No * marks.
   */
  diff?: boolean;
  /** With state 'v2': a page or scroll area whose content is at most this many screens high is printed whole. */
  small?: number;
}
export interface WorkerConfig extends importPolicy {
  mode?: 'default' | 'ultrafast';
  ax?: AxOptions;
  webSearch?: { url: string; token: string };
  sensitiveData?: import('./policy.js').SensitiveData;
  redact?: string[];
  endpoint: string;
  /** Pending browser only: how long a cell waits for it, apart from the cell's own deadline. */
  browserWaitMs?: number;
  recording?: boolean;
  highlightActions?: boolean;
  approveConnection?: boolean;
  workspace: string;
  targetId?: string;
  focusTab?: boolean;
  browserSwitching?: boolean;
  dedicatedBrowser?: boolean;
  operationTimeoutMs: number;
  maxOutputChars: number;
}
export type WorkerRequest =
  | {
      type: 'execute';
      code: string;
      captureJson?: boolean;
      outputFile?: string;
      runId?: string;
      /** ax.diff: the next state prints in full. Set on the first cell after the history was compacted. */
      fullState?: boolean;
    }
  | { type: 'close' };
export type WorkerResponse =
  | { type: 'action'; action: BrowserAction }
  | { type: 'owned'; targetId: string }
  | { type: 'endpoint'; endpoint: string }
  | { type: 'partial'; runId?: string; path: string; valueJson: string }
  | { type: 'ready'; targetId: string }
  | { type: 'result'; result: CellResult }
  | { type: 'error'; message: string; result?: CellResult }
  | { type: 'closed' };

export function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer below 2147483648.`);
  }
  return value;
}
