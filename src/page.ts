import type { Protocol } from 'devtools-protocol';
import { setTimeout as delay } from 'node:timers/promises';
import { CDP } from './cdp.js';
import { positiveInteger } from './protocol.js';

export type AXNode = {
  id: number;
  role: string;
  name: string;
  value?: string;
  /** Present only when Chrome reports this state; absence does not mean false. */
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
};

type Point = { x: number; y: number };
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
/** A mouse move to a tab hidden mid-path is answered only after ~5 s (headless Chrome): press without waiting. */
const MOVE_ACK_MS = 2000;

/**
 * 10-15 mouseMoved points along a jittered quadratic Bezier from `from` to `to`, eased in and out.
 * The last point is exactly `to`; every point stays inside the `width` x `height` viewport.
 */
export function mousePath(from: Point, to: Point, width: number, height: number): Point[] {
  const cx = (from.x + to.x) / 2 + between(-0.15, 0.15) * width;
  const cy = (from.y + to.y) / 2 + between(-0.15, 0.15) * height;
  const steps = Math.floor(between(10, 16));
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return Array.from({ length: steps }, (_, i) => {
    if (i === steps - 1) return { ...to };
    const s = (i + 1) / steps;
    const t = s * s * (3 - 2 * s);
    const at = (a: number, c: number, b: number) =>
      (1 - t) ** 2 * a + 2 * (1 - t) * t * c + t * t * b + between(-1, 1);
    return {
      x: clamp(at(from.x, cx, to.x), width - 1),
      y: clamp(at(from.y, cy, to.y), height - 1),
    };
  });
}

const contextLost =
  /Execution context was destroyed|Cannot find context|Cannot find default execution context/;

function controlState(node: Protocol.Accessibility.AXNode) {
  const state: Pick<AXNode, 'checked' | 'pressed' | 'selected' | 'expanded' | 'disabled'> = {};
  for (const { name, value } of node.properties ?? []) {
    const observed = value.value;
    if (name === 'checked' || name === 'pressed') {
      if (observed === 'mixed') state[name] = 'mixed';
      else if (observed === true || observed === 'true') state[name] = true;
      else if (observed === false || observed === 'false') state[name] = false;
    } else if (
      (name === 'selected' || name === 'expanded' || name === 'disabled') &&
      typeof observed === 'boolean'
    ) {
      state[name] = observed;
    }
  }
  return state;
}

/** A tab with explicit CDP, page evaluation and observation. No selector/action layer. */
export class Page {
  private constructor(
    readonly connection: CDP,
    public targetId: string,
    public sessionId: string,
  ) {}

  /** Where the last mouse event on this tab put the pointer, raw page.cdp calls included. */
  private pointer: Point | undefined;

  private initialize: (() => Promise<Page>) | undefined;
  private initializing: Promise<void> | undefined;
  static deferred(connection: CDP, initialize: () => Promise<Page>, targetId = '') {
    const page = new Page(connection, targetId, '');
    page.initialize = initialize;
    return page;
  }
  private async ready() {
    if (!this.initialize) return;
    this.initializing ??= this.initialize()
      .then((page) => {
        this.targetId = page.targetId;
        this.sessionId = page.sessionId;
        this.initialize = undefined;
      })
      .finally(() => {
        this.initializing = undefined;
      });
    await this.initializing;
  }
  static async attach(connection: CDP, targetId: string) {
    const { sessionId } = await connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(connection, targetId, sessionId);
    try {
      await page.cdp('Page.enable');
      await page.cdp('Runtime.enable');
      return page;
    } catch (error) {
      // The caller never receives this page, so it cannot release the failed attachment.
      await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      throw error;
    }
  }
  async cdp<
    M extends keyof import('devtools-protocol/types/protocol-mapping.js').ProtocolMapping.Commands,
  >(
    method: M,
    params?: import('devtools-protocol/types/protocol-mapping.js').ProtocolMapping.Commands[M]['paramsType'][0],
  ) {
    await this.ready();
    if (method === 'Input.dispatchMouseEvent') {
      const { x, y } = params as Point;
      this.pointer = { x, y };
    }
    return this.connection.send(method, params, this.sessionId);
  }
  async goto(url: string) {
    const result = await this.cdp('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await this.waitFor(() => document.readyState !== 'loading');
    return this.info();
  }
  async info() {
    return this.evaluate(() => ({ url: location.href, title: document.title }));
  }
  async evaluate<T, A = undefined>(
    fn: ((argument: A) => T) | string,
    argument?: A,
  ): Promise<Awaited<T>> {
    const expression =
      typeof fn === 'string'
        ? fn
        : `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`;
    const response = await this.cdp('Runtime.evaluate', {
      expression,
      // Bound synchronous execution in Chrome too; rejecting a CDP promise does not stop it.
      timeout: this.connection.timeoutMs,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    return response.result.value as Awaited<T>;
  }
  async waitFor<A = undefined>(
    fn: (arg: A) => unknown,
    argument?: A,
    options: { timeoutMs?: number } = {},
  ) {
    const timeoutMs = positiveInteger('timeoutMs', options.timeoutMs ?? this.connection.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(fn, argument)) return;
      } catch (error) {
        if (!(error instanceof Error) || !contextLost.test(error.message)) throw error;
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Page condition exceeded ${timeoutMs} ms.`);
  }
  async snapshot(): Promise<{ url: string; title: string; nodes: AXNode[] }> {
    const { nodes } = await this.cdp('Accessibility.getFullAXTree');
    return {
      ...(await this.info()),
      nodes: nodes
        .filter((n) => !n.ignored && n.backendDOMNodeId)
        .map((n) => ({
          id: n.backendDOMNodeId!,
          role: String(n.role?.value ?? ''),
          name: String(n.name?.value ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
          ...(n.value ? { value: String(n.value.value) } : {}),
          ...controlState(n),
        })),
    };
  }
  async clickAt(x: number, y: number) {
    if (![x, y].every(Number.isFinite)) throw new Error('Coordinates must be finite.');
    await this.moveMouse(x, y);
    await delay(between(20, 60));
    const press = { x, y, button: 'left', clickCount: 1 } as const;
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
    await delay(between(20, 50));
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
  }
  /**
   * Moves the pointer to (x, y) along a curved path from where it last was, as a hand does.
   * Akamai validates its _abck session only after real mouse travel; a click that teleports onto its
   * target does not count (cloud A/B: _abck ~0~ in 16/16 sessions with a path vs ~1/46 without).
   */
  private async moveMouse(x: number, y: number) {
    // Raw evaluate: page.evaluate's userGesture would grant the page a user activation.
    const view = await this.cdp('Runtime.evaluate', {
      expression: '[document.visibilityState, innerWidth, innerHeight]',
      returnByValue: true,
    }).then(
      ({ result }) => result.value as [string, number, number] | undefined,
      () => undefined,
    );
    // A hidden tab answers each mouseMoved only after ~5 s (headless): one move, as before.
    if (view?.[0] !== 'visible') {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      return;
    }
    const [, width, height] = view;
    const from = this.pointer ?? { x: between(0.2, 0.8) * width, y: between(0.2, 0.8) * height };
    // Sent without awaiting each answer, so the cloud round trip does not set the pace.
    const moves: Promise<unknown>[] = [];
    for (const [i, p] of mousePath(from, { x, y }, width, height).entries()) {
      if (i) await delay(between(10, 25));
      moves.push(this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }));
    }
    const answered = Promise.all(moves);
    answered.catch(() => {}); // a move still pending after MOVE_ACK_MS must not reject unhandled
    await Promise.race([answered, delay(MOVE_ACK_MS, undefined, { ref: false })]);
  }
  async screenshot(options: { quality?: number } = {}) {
    // The page's own devicePixelRatio (emulation changes it) makes image pixels page.clickAt coordinates.
    // Raw evaluate: page.evaluate's userGesture would grant the page a user activation per capture.
    const clip = await this.cdp('Runtime.evaluate', {
      expression:
        '({ x: visualViewport.pageLeft, y: visualViewport.pageTop, width: visualViewport.width, height: visualViewport.height, scale: 1 / devicePixelRatio })',
      returnByValue: true,
    }).then(
      ({ result }) => result.value,
      (error) => {
        // Mid-navigation there is no context to ask; capture unclipped. Anything else (an open dialog) fails as before.
        if (!(error instanceof Error) || !contextLost.test(error.message)) throw error;
      },
    );
    const { data } = await this.cdp('Page.captureScreenshot', {
      format: 'jpeg',
      quality: options.quality ?? 70,
      ...(clip && { clip }),
    });
    return Buffer.from(data, 'base64');
  }
  async close() {
    await this.ready();
    await this.connection.send('Target.closeTarget', { targetId: this.targetId });
  }
}

/** Tab ownership stays explicit. Attached caller tabs are never included in cleanup. */
export class Tabs {
  constructor(
    readonly cdp: CDP,
    private own: (id: string) => void,
  ) {}
  async list() {
    return (await this.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  }
  async open(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    this.own(targetId);
    const page = await Page.attach(this.cdp, targetId);
    if (url !== 'about:blank') await page.goto(url);
    return page;
  }
  async get(id: string) {
    return Page.attach(this.cdp, id);
  }
}
