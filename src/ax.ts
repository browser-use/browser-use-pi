import { setTimeout as delay } from 'node:timers/promises';
import { axNodes, type AXNode, type Page } from './page.js';
import type { CDP } from './cdp.js';

type Target = number | string | { name: string; role?: string };
type Op = 'click' | 'fill' | 'select' | 'check';
const ROLES: Record<Op, Set<string>> = {
  fill: new Set([
    'textbox',
    'searchbox',
    'combobox',
    'spinbutton',
    'Date',
    'DateTime',
    'InputTime',
  ]),
  click: new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'combobox',
    'treeitem',
    'gridcell',
    'row',
    'listitem',
    'img',
    'StaticText',
    'cell',
    'heading',
    'textbox',
    'searchbox',
    'slider',
  ]),
  select: new Set(['combobox', 'listbox']),
  check: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
};
const CONTROLS = new Set([
  ...ROLES.fill,
  ...ROLES.select,
  ...ROLES.check,
  'button',
  'link',
  'tab',
  'menuitem',
  'option',
  'slider',
]);
const KEYS: Record<string, { code: string; key: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  PageDown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
};
// Accents are folded so "Zurich" names "Zürich"; everything else must still match exactly.
const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const brief = (n: AXNode) =>
  `#${n.id} ${n.role} "${clip(n.name, 60)}"${n.value !== undefined ? ` value="${clip(n.value, 40)}"` : ''}${n.checked !== undefined ? ` checked=${n.checked}` : ''}${n.expanded !== undefined ? ` expanded=${n.expanded}` : ''}${n.disabled ? ' disabled' : ''}`;
const isContextLoss = (e: unknown) =>
  /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated|Target closed|No frame/.test(
    String(e instanceof Error ? e.message : e),
  );

/** A value its bu call already printed: the REPL's echo of it becomes a one-line note instead of a second copy. */
const printed = <T extends object>(value: T, note: string): T =>
  Object.defineProperty(value, Symbol.for('nodejs.util.inspect.custom'), { value: () => note });

/** Appended to the helper prompt when a search endpoint is configured. */
export const SEARCH_PROMPT = '';

export const AX_PROMPT = `
Browser action helpers are optional convenience in this same REPL; raw CDP, page evaluation, fetch, files and screenshots remain available.
- Read with bu.state() or bu.find(text). Targets are observed numeric IDs, exact accessible names, or {name,role}. Ambiguity fails without input.
- Chain only actions whose prerequisites you already know: await bu.fill('Name','Ada'); await bu.click('Search'). One compact state follows the cell.
- Actions: bu.goto(url), bu.click(target), bu.fill(target,exactText,{enter:true}), bu.check(target,boolean), bu.select(target,label) for native selects, bu.press(key).
- input_sent means input dispatched, not task completion. verified checks a specific control value. Short settle windows can expire while work continues. Inspect state and test the boolean from await bu.waitForText(text) before dependent steps.
- No hidden retry of uncertain mutations. A failed cell may have partly executed; inspect before taking another action.
- Alerts are acknowledged. Confirm/prompt dialogs are dismissed unless you explicitly set bu.expectDialog(type,exactMessage,{accept:true,promptText}) before the relevant action. Stay within the user's authorization; the exact policy expires after that action.
- Custom dropdowns, uploads, downloads, dragging and other exceptions use the existing raw browser primitives. Read page data with page.evaluate. Take a screenshot for visual evidence when text is insufficient.
`;

/** Fast, strict accessibility-tree helpers for the persistent REPL. Raw page/CDP stays available. */
export class AxHelpers {
  /** Set by an action once its input reached the page, so a failure after that is reported as uncertain. */
  private attempted = false;
  /** Set by mutations; the worker prints a fresh compact state after such a cell. */
  dirty = false;
  private busy = false;
  constructor(
    private page: () => Page,
    private browser: () => CDP,
    _workspace: string,
    private log: (text: string) => void,
    search?: { url: string; token: string },
  ) {
    if (search) throw new Error('Core helpers do not provide web search; use a host search tool.');
  }

  private inflight = new Map<string, Map<string, number>>();
  private lastNet = new Map<string, number>();
  private tracked = new Set<string>();
  private dialogs: string[] = [];
  private actionSession: string | undefined;
  private expectedDialog:
    { type: string; message: string; accept: boolean; promptText?: string } | undefined;
  /** Exact policy for a dialog expected during the next awaited action only. */
  expectDialog(
    type: 'alert' | 'confirm' | 'prompt',
    message: string,
    options: { accept: boolean; promptText?: string },
  ) {
    if (
      !['alert', 'confirm', 'prompt'].includes(type) ||
      typeof message !== 'string' ||
      typeof options.accept !== 'boolean'
    )
      throw new Error('Expected dialog requires exact type/message and an accept boolean.');
    this.expectedDialog = { type, message, ...options };
  }

  /** Track in-flight requests per page session from CDP Network events (no page patching). */
  private async trackNetwork(page: Page) {
    const cdp = this.browser();
    if (!(cdp as { __buTracked?: boolean }).__buTracked) {
      const previous = cdp.observeEvent;
      cdp.observeEvent = (method, raw, session) => {
        previous?.(method, raw, session);
        // Acknowledge alerts; dismiss decisions unless the caller expected this exact dialog.
        if (method === 'Page.javascriptDialogOpening') {
          if (!this.actionSession || session !== this.actionSession) return;
          const d = raw as { type: string; message: string; defaultPrompt?: string };
          const expected = this.expectedDialog;
          this.expectedDialog = undefined;
          const matched = expected?.type === d.type && expected.message === d.message;
          const accept = matched ? expected.accept : d.type === 'alert';
          this.dialogs.push(
            `[dialog ${d.type}] ${JSON.stringify(clip(d.message, 300))} (${accept ? 'accepted' : 'dismissed'}${matched ? '; explicit policy' : '; no matching policy'})`,
          );
          void cdp
            .send(
              'Page.handleJavaScriptDialog',
              { accept, promptText: matched ? (expected.promptText ?? '') : '' },
              session,
            )
            .catch(() => {});
          return;
        }
        if (method === 'Target.detachedFromTarget') {
          const gone = (raw as { sessionId: string }).sessionId;
          this.inflight.delete(gone);
          this.lastNet.delete(gone);
          this.tracked.delete(gone);
          return;
        }
        if (!session || !method.startsWith('Network.')) return;
        const params = raw as { requestId: string; type?: string };
        const map = this.inflight.get(session) ?? new Map<string, number>();
        this.inflight.set(session, map);
        if (method === 'Network.requestWillBeSent') {
          if (
            !['WebSocket', 'EventSource', 'Media', 'Ping', 'Manifest'].includes(params.type ?? '')
          )
            map.set(params.requestId, Date.now());
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed')
          map.delete(params.requestId);
        else return;
        this.lastNet.set(session, Date.now());
      };
      (cdp as { __buTracked?: boolean }).__buTracked = true;
    }
    const session = page.sessionId || (await page.info().then(() => page.sessionId));
    if (session && !this.tracked.has(session)) {
      this.tracked.add(session);
      await page.cdp('Network.enable', {}).catch(() => this.tracked.delete(session));
    }
    return session;
  }

  /**
   * Event-based wait, never a fixed sleep: document parsed, no fresh in-flight requests
   * (older than 1.5 s are treated as long-poll/analytics), and no DOM mutation for quietMs. Bounded by capMs.
   */
  async settle(options: { capMs?: number; quietMs?: number; page?: Page } = {}) {
    const page = options.page ?? this.page();
    const cap = options.capMs ?? 800;
    const quiet = options.quietMs ?? 80;
    const start = Date.now();
    const session = await this.trackNetwork(page).catch(() => undefined);
    let limit = cap;
    while (Date.now() - start < limit) {
      try {
        const probe = await page.evaluate(() => {
          const w = window as unknown as { __buObs?: MutationObserver; __buLast: number };
          if (!w.__buObs) {
            w.__buLast = performance.now();
            w.__buObs = new MutationObserver(() => (w.__buLast = performance.now()));
            w.__buObs.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          }
          return { idle: performance.now() - w.__buLast, ready: document.readyState };
        });
        const now = Date.now();
        if (probe.ready === 'loading') limit = Math.max(cap, 3000); // navigations need longer than in-page updates
        probe.idle = Math.min(probe.idle, now - start); // quiet must be observed after this action began
        const pending = session
          ? [...(this.inflight.get(session)?.values() ?? [])].filter((t) => now - t < 1500).length
          : 0;
        const netIdle = session ? now - (this.lastNet.get(session) ?? 0) : quiet;
        if (probe.ready !== 'loading' && probe.idle >= quiet && pending === 0 && netIdle >= quiet)
          return { why: 'quiet', ready: probe.ready, ms: now - start };
      } catch (error) {
        // Navigation in progress: wait for the new document. Anything else ends the wait, never the action.
        if (!isContextLoss(error))
          return { why: 'error', ready: 'unknown', ms: Date.now() - start };
      }
      await delay(40);
    }
    return { why: 'cap', ready: 'unknown', ms: Date.now() - start };
  }

  private flushDialogs() {
    return this.dialogs.length ? `\n${this.dialogs.splice(0).join('\n')}` : '';
  }

  /** Duration of the last full AX snapshot; the worker skips its automatic state print on slow pages. */
  snapshotMs = 0;
  private async nodes(page = this.page()) {
    for (let i = 0; ; i++) {
      try {
        const started = Date.now();
        const [{ nodes: top }, info, { frameTree }] = await Promise.all([
          page.cdp('Accessibility.getFullAXTree'),
          page.info(),
          page.cdp('Page.getFrameTree'),
        ]);
        // A form that lives in a same-origin iframe is missing from the main frame's AX tree. Only a page without its
        // own fields gets the frames' trees, and only frames that hold fields: ads and embeds would bloat every state.
        const frames: string[] = [];
        const walk = (tree: typeof frameTree) =>
          tree.childFrames?.forEach((child) => {
            if (child.frame.securityOrigin === frameTree.frame.securityOrigin)
              frames.push(child.frame.id);
            walk(child);
          });
        if (!top.some((n) => ROLES.fill.has(String(n.role?.value)))) walk(frameTree);
        const inner = await Promise.all(
          frames.map((frameId) =>
            page.cdp('Accessibility.getFullAXTree', { frameId }).then(
              (r) => r.nodes,
              () => [],
            ),
          ),
        );
        const nodes = [
          ...top,
          ...inner.filter((f) => f.some((n) => ROLES.fill.has(String(n.role?.value)))).flat(),
        ];
        this.snapshotMs = Date.now() - started;
        // A focusable contenteditable element is a text field that Chrome reports as generic.
        const editable = new Set(
          nodes
            .filter(
              (n) =>
                n.role?.value === 'generic' &&
                n.properties?.some((p) => p.name === 'editable') &&
                n.properties.some((p) => p.name === 'focusable' && p.value.value),
            )
            .map((n) => n.backendDOMNodeId),
        );
        return {
          ...info,
          nodes: axNodes(nodes).map((n) => (editable.has(n.id) ? { ...n, role: 'textbox' } : n)),
        };
      } catch (error) {
        if (i >= 20 || !isContextLoss(error)) throw error;
        await delay(50);
      }
    }
  }

  /**
   * Text actually shown, lowercased with whitespace collapsed. The AX tree keeps opacity:0 text (pre-rendered
   * success banners), which agents then report as success; checkVisibility with checkOpacity drops it.
   */
  private visibleText(page = this.page()) {
    return page.evaluate(() => {
      const out: string[] = [];
      const shown = new Map<Element, boolean>();
      const roots: Node[] = [document];
      for (let i = 0; i < roots.length; i++) {
        const walk = document.createTreeWalker(
          roots[i]!,
          NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        );
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const el = n as Element & { contentDocument?: Document | null };
            if (el.shadowRoot) roots.push(el.shadowRoot);
            if (el.contentDocument) roots.push(el.contentDocument); // same-origin iframe
            continue;
          }
          const e = n.parentElement;
          if (!e || !n.textContent?.trim()) continue;
          if (!shown.has(e))
            shown.set(e, e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
          if (shown.get(e)) out.push(n.textContent);
        }
      }
      return out.join(' ').replace(/\s+/g, ' ').toLowerCase();
    });
  }

  /** Compact state: URL, title, interactive controls (ids usable as targets), visible text summary. */
  async state(options: { max?: number; text?: number } = {}) {
    this.dirty = false; // a look after the last action replaces the automatic state print
    const [snap, visible] = await Promise.all([
      this.nodes(),
      this.visibleText().catch(() => undefined),
    ]);
    const all = snap.nodes.filter(
      (n) => CONTROLS.has(n.role) && (n.name || n.value !== undefined || n.role !== 'link'),
    );
    const seen = new Set<string>();
    // Fields and open menus first, the rest in page order: page chrome must not push the form past the cutoff.
    const rank = (n: AXNode) =>
      ROLES.fill.has(n.role) || n.expanded || n.role === 'option' ? 0 : 1;
    const controls = all
      .filter((n) => {
        if (!n.name && ROLES.fill.has(n.role)) return true; // unlabeled fields are distinct fields, not repeats
        const key = `${n.role}|${n.name}|${n.value ?? ''}`;
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .map((n, i) => ({ n, i }))
      .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
      .map(({ n }) => n);
    const max = options.max ?? 60;
    const textParts: string[] = [];
    let size = 0;
    const limit = options.text ?? 1200;
    for (const n of snap.nodes) {
      if (!(n.role === 'heading' || n.role === 'StaticText') || !n.name) continue;
      if (visible !== undefined && !visible.includes(n.name.toLowerCase())) continue;
      const part = n.role === 'heading' ? `## ${n.name}` : n.name;
      if (textParts.at(-1) === part) continue;
      textParts.push(part);
      size += part.length + 1;
      if (size > limit) break;
    }
    const result = {
      url: snap.url,
      title: snap.title,
      controls: controls.slice(0, max),
      more: Math.max(0, controls.length - max),
      text: clip(textParts.join('\n'), limit),
    };
    this.log(
      `[state] ${result.title} | ${result.url}${this.flushDialogs()}\n${result.controls.map(brief).join('\n')}${result.more ? `\n… ${result.more} more controls: bu.find('word')` : ''}\n[text] ${result.text}`,
    );
    return printed(result, '[state printed above]');
  }

  /** Controls whose name/value contains the query (case-insensitive). Read-only. */
  async find(query: string, options: { max?: number } = {}) {
    this.dirty = false;
    const q = norm(query);
    const snap = await this.nodes();
    const hits = snap.nodes
      .filter((n) => CONTROLS.has(n.role) || n.role === 'StaticText' || n.role === 'heading')
      .filter((n) => norm(n.name).includes(q) || norm(n.value).includes(q))
      .slice(0, options.max ?? 25);
    this.log(`[find "${query}"] ${hits.length} hit(s)\n${hits.map(brief).join('\n')}`);
    return hits;
  }

  /** Strict: numeric id, or a unique exact accessible name (optionally with role). Never guesses. */
  private async resolve(op: Op, target: Target) {
    const page = this.page();
    const snap = await this.nodes(page);
    const roles = ROLES[op];
    const usable = snap.nodes.filter((n) => roles.has(n.role));
    let matches: AXNode[];
    let label: string;
    // Models often pass an id as '1743' or '#1743'.
    if (typeof target === 'string' && /^#?\d+$/.test(target.trim()))
      target = Number(target.trim().replace('#', ''));
    if (typeof target === 'number') {
      matches = snap.nodes.filter((n) => n.id === target);
      label = `#${target}`;
      if (!matches.length)
        throw new Error(
          `STALE: no node #${target} on the current page (${snap.url}). Get fresh ids with bu.state() or bu.find().`,
        );
    } else {
      const name = typeof target === 'string' ? target : target.name;
      const role = typeof target === 'string' ? undefined : target.role;
      if (typeof name !== 'string' || !name.trim())
        throw new Error('Target must be an id, an exact accessible name, or {name, role}.');
      label = `"${name}"${role ? ` (${role})` : ''}`;
      const prefer = (found: AXNode[]) => {
        const enabled = found.filter((n) => !n.disabled);
        if (enabled.length) found = enabled;
        // A button's own text node repeats its name; prefer real controls over text/structure nodes.
        const strong = found.filter((n) => CONTROLS.has(n.role));
        return strong.length ? strong : found;
      };
      matches = prefer(
        usable.filter((n) => norm(n.name) === norm(name) && (!role || n.role === role)),
      );
      if (!matches.length) {
        const words = norm(name)
          .split(' ')
          .filter((w) => w.length > 2);
        const near = usable.filter((n) => words.some((w) => norm(n.name).includes(w))).slice(0, 8);
        throw new Error(
          `NOT_FOUND: no ${op}-able control named ${label}. ${near.length ? `Candidates:\n${near.map(brief).join('\n')}` : 'No similar names; inspect with bu.state()/bu.find().'}\nPass an id or the exact name. Nothing was executed.`,
        );
      }
      if (matches.length > 1)
        throw new Error(
          `AMBIGUOUS: ${matches.length} controls named ${label}:\n${matches.slice(0, 10).map(brief).join('\n')}\nPass the id. Nothing was executed.`,
        );
    }
    return { page, node: matches[0]!, url: snap.url };
  }

  private async onNode<T>(page: Page, id: number, fn: string, argument?: unknown): Promise<T> {
    const { object } = await page.cdp('DOM.resolveNode', { backendNodeId: id });
    if (!object.objectId) throw new Error('Node unavailable.');
    try {
      const response = await page.cdp('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: [{ value: argument }],
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description ?? 'Node operation failed.',
        );
      return response.result.value as T;
    } finally {
      await page.cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  /**
   * Scroll into view and return a clickable, unobstructed center point, or throw a precise reason.
   * With editableCover, a text field overlaid by another text field is accepted: comboboxes often swap in their own input.
   */
  private async point(page: Page, id: number, editableCover = false) {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => {});
    return this.onNode<{ x: number; y: number; tag: string; type: string; editable: boolean }>(
      page,
      id,
      `function(editableCover) {
        const e = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!e || !e.isConnected) throw Error('Target detached');
        if (e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]')) throw Error('Target disabled');
        if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) throw Error('Target hidden');
        const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw Error('Target outside viewport');
        const hit = e.getRootNode().elementFromPoint(x, y);
        const textField = (n) => n && (['INPUT','TEXTAREA'].includes(n.tagName) || n.isContentEditable);
        if (!e.contains(hit) && !(hit && hit.contains(e) && getComputedStyle(hit).pointerEvents !== 'none' && hit.tagName === 'LABEL') && !(editableCover && textField(e) && textField(hit)))
          throw Error('Target covered by ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '') : 'nothing'));
        // Inside same-origin iframes, add each frame's content-box offset to get top-level viewport coordinates.
        let px = x, py = y;
        for (let w = e.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
          const f = w.frameElement, fr = f.getBoundingClientRect(), cs = w.parent.getComputedStyle(f);
          if (!f.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) throw Error('Frame hidden');
          // Scaling/rotation needs quad mapping; reject rather than click the wrong point.
          if (cs.transform !== 'none' || Math.abs(fr.width - f.offsetWidth) > 1 || Math.abs(fr.height - f.offsetHeight) > 1)
            throw Error('Transformed frame: inspect its geometry with raw CDP');
          px += fr.x + f.clientLeft + parseFloat(cs.paddingLeft);
          py += fr.y + f.clientTop + parseFloat(cs.paddingTop);
          if (px < 0 || py < 0 || px >= w.parent.innerWidth || py >= w.parent.innerHeight) throw Error('Frame target outside viewport');
          const hit = f.getRootNode().elementFromPoint(px, py);
          if (hit !== f) throw Error('Frame covered by ' + (hit?.tagName?.toLowerCase() ?? 'nothing'));
        }
        return {x: px, y: py, tag: e.tagName, type: e.type || '', editable: textField(e)};
      }`,
      editableCover,
    );
  }

  private async act<T>(
    op: string,
    target: unknown,
    body: () => Promise<{
      id?: number | undefined;
      detail?: string | undefined;
      value?: T | undefined;
      verify?: (() => Promise<void>) | undefined;
    }>,
  ) {
    if (this.busy) throw new Error('Await bu actions sequentially; no concurrent mutations.');
    this.busy = true;
    this.attempted = false;
    try {
      this.actionSession = await this.trackNetwork(this.page()).catch(() => undefined);
      const { id, detail, value, verify } = await body();
      this.dirty = true;
      const settled = await this.settle();
      await verify?.();
      const info = await this.page()
        .info()
        .catch(() => ({ url: '?', title: '?' }));
      this.log(
        `[${verify ? 'verified' : 'input_sent'}] ${op} ${typeof target === 'object' ? JSON.stringify(target) : JSON.stringify(target ?? '')}${id ? ` #${id}` : ''}${detail ? ` ${detail}` : ''} -> settled ${settled.why} ${settled.ms}ms | ${clip(info.title, 60)} | ${info.url}${this.flushDialogs()}`,
      );
      return {
        ok: true,
        op,
        id,
        url: info.url,
        title: info.title,
        settled,
        outcomeVerified: !!verify,
        ...(value !== undefined ? { value } : {}),
      };
    } catch (error) {
      if (this.attempted) this.dirty = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${op} ${JSON.stringify(target)} failed (${this.attempted ? 'uncertain' : 'not_executed'}): ${message}`,
      );
    } finally {
      this.busy = false;
      this.expectedDialog = undefined;
      this.actionSession = undefined;
    }
  }

  async goto(url: string) {
    return this.act('goto', url, async () => {
      const page = this.page();
      this.attempted = true;
      const result = await page.cdp('Page.navigate', { url });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      const status = await this.status(page);
      return { detail: status ? `http ${status}` : undefined, value: status };
    });
  }

  private async status(page: Page) {
    for (let i = 0; i < 100; i++) {
      try {
        return await page
          .evaluate(() => {
            if (document.readyState === 'loading') return -1;
            const nav = performance.getEntriesByType(
              'navigation',
            )[0] as PerformanceNavigationTiming & { responseStatus?: number };
            return nav?.responseStatus ?? 0;
          })
          .then((s) => {
            if (s === -1) throw new Error('Cannot find context');
            return s;
          });
      } catch (error) {
        if (!isContextLoss(error)) throw error;
        await delay(50);
      }
    }
    return 0;
  }

  async click(target: Target, options: { button?: 'left' | 'right'; count?: number } = {}) {
    return this.act('click', target, async () => {
      const { page, node } = await this.resolve('click', target);
      const p = await this.point(page, node.id);
      this.attempted = true;
      const button = options.button ?? 'left';
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      for (let clickCount = 1; clickCount <= (options.count ?? 1); clickCount++)
        for (const type of ['mousePressed', 'mouseReleased'] as const)
          await page.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, clickCount });
      return { id: node.id, detail: `${node.role} "${clip(node.name, 50)}"` };
    });
  }

  async fill(target: Target, text: string, options: { enter?: boolean; pick?: never } = {}) {
    if (options.pick !== undefined)
      throw new Error(
        'Core helpers do not pick autocomplete options; inspect and click the observed option.',
      );
    if (typeof text !== 'string') throw new Error('fill needs an exact string.');
    return this.act('fill', target, async () => {
      const { page, node } = await this.resolve('fill', target);
      const p = await this.point(page, node.id);
      this.attempted = true;
      if (
        p.tag === 'INPUT' &&
        ['date', 'time', 'datetime-local', 'month', 'week'].includes(p.type)
      ) {
        await this.onNode(
          page,
          node.id,
          `function(v){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(this,v);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));if(this.value!==v)throw Error('Invalid native date/time value; use its ISO format');}`,
          text,
        );
      } else {
        await page.clickAt(p.x, p.y);
        await page.cdp('DOM.focus', { backendNodeId: node.id });
        await page.cdp('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
          commands: ['selectAll'],
        });
        await page.cdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
        if (text === '') await this.key(page, 'Backspace');
        else {
          // Datepickers and autocompletes react to key events, which insertText never sends: type the last character as a key.
          const chars = [...text];
          const last = chars.pop()!;
          if (chars.length) await page.cdp('Input.insertText', { text: chars.join('') });
          await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: last, text: last });
          await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: last });
        }
      }
      const actual = await this.onNode<string>(
        page,
        node.id,
        `function(){const e=this.nodeType===1?this:this.parentElement;return e.isContentEditable?e.innerText:(e.value??'');}`,
      ).catch(() => undefined);
      if (actual !== text)
        throw new Error(
          'OUTCOME_NOT_VERIFIED: field did not retain the exact requested text. Inspect before continuing.',
        );
      if (options.enter) await this.key(page, 'Enter');
      return {
        id: node.id,
        detail: `${node.role} "${clip(node.name, 40)}" = ${JSON.stringify(clip(text, 60))}${options.enter ? ' +Enter' : ''}`,
      };
    });
  }

  async select(target: Target, option: string) {
    return this.act('select', target, async () => {
      const { page, node } = await this.resolve('select', target);
      const native = await this.onNode<boolean>(
        page,
        node.id,
        `function(){return this.tagName==='SELECT';}`,
      );
      if (!native)
        throw new Error('Custom dropdown: use bu.click and inspect its observed options.');
      await this.point(page, node.id);
      this.attempted = true;
      const result = await this.onNode<{ label: string; value: string }>(
        page,
        node.id,
        `function(label){
          const norm = s => String(s).trim().replace(/\\s+/g,' ').toLowerCase();
          const opts = [...this.options].filter(o => !o.disabled);
          const hits = opts.filter(o => norm(o.label) === norm(label) || norm(o.value) === norm(label));
          if (hits.length !== 1) throw Error((hits.length ? 'AMBIGUOUS' : 'NOT_FOUND') + ': option ' + JSON.stringify(label) + '. Options: ' + JSON.stringify(opts.slice(0,40).map(o=>o.label)));
          this.value = hits[0].value; this.selectedIndex = hits[0].index;
          this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
          return {label: hits[0].label, value: hits[0].value};
        }`,
        option,
      );
      return {
        id: node.id,
        detail: `"${clip(node.name, 40)}" = ${JSON.stringify(result.label)}`,
        verify: async () => {
          const actual = await this.onNode<string>(page, node.id, 'function(){return this.value;}');
          if (actual !== result.value)
            throw new Error('OUTCOME_NOT_VERIFIED: selection did not retain requested value.');
        },
      };
    });
  }

  async check(target: Target, on = true) {
    if (typeof on !== 'boolean') throw new Error('check expects a boolean.');
    return this.act('check', target, async () => {
      const { page, node } = await this.resolve('check', target);
      if (node.checked === on) return { id: node.id, detail: `already ${on}` };
      const p = await this.point(page, node.id);
      this.attempted = true;
      await page.clickAt(p.x, p.y);
      return {
        id: node.id,
        detail: String(on),
        verify: async () => {
          const current = (await this.nodes(page)).nodes.find((n) => n.id === node.id);
          if (current?.checked !== on)
            throw new Error(
              'OUTCOME_NOT_VERIFIED: expected checked=' +
                on +
                ', observed ' +
                (current?.checked ?? 'unknown') +
                '. Inspect before retrying.',
            );
        },
      };
    });
  }

  private async key(page: Page, name: string) {
    const k = KEYS[name];
    if (!k) throw new Error(`Unsupported key ${name}. Supported: ${Object.keys(KEYS).join(', ')}`);
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    });
    if (k.text)
      await page.cdp('Input.dispatchKeyEvent', {
        type: 'char',
        key: k.key,
        code: k.code,
        text: k.text,
        unmodifiedText: k.text,
        windowsVirtualKeyCode: k.keyCode,
      });
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    });
  }

  async press(name: string) {
    return this.act('press', name, async () => {
      this.attempted = true;
      await this.key(this.page(), name);
      return {};
    });
  }

  /** Wait for visible text (event-free polling of a real condition, not a blind sleep). */
  async waitForText(text: string, options: { timeoutMs?: number } = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? 3000);
    const want = norm(text);
    while (Date.now() < deadline) {
      try {
        // innerText is cheap but includes opacity:0 text, so a hit is confirmed against visible text.
        const hit = await this.page().evaluate(
          (w: string) =>
            (document.body?.innerText ?? '').replace(/\s+/g, ' ').toLowerCase().includes(w),
          want,
        );
        if (hit && (await this.visibleText()).includes(want)) return true;
      } catch (error) {
        if (!isContextLoss(error)) throw error;
      }
      await delay(250);
    }
    this.log(`[waitForText] "${text}" not visible after ${options.timeoutMs ?? 3000}ms`);
    return false;
  }
}
