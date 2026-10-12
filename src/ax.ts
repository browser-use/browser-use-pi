import { setTimeout as delay } from 'node:timers/promises';
import type { Protocol } from 'devtools-protocol';
import type { Page } from './page.js';
import type { CDP } from './cdp.js';
import type { AxOptions } from './protocol.js';

type AX = Protocol.Accessibility.AXNode;
const CONTROLS = new Set(
  'button link textbox searchbox combobox listbox option checkbox radio switch slider spinbutton tab menuitem menuitemcheckbox menuitemradio treeitem'.split(
    ' ',
  ),
);
/** Text inside these is one line; text across them is not joined. */
const BLOCKS = new Set(['paragraph', 'listitem', 'row', 'LabelText']);
const NATIVE_INPUTS = new Set(['Date', 'DateTime', 'InputTime']);
const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const prop = (n: AX, name: string) => n.properties?.find((p) => p.name === name)?.value.value;
const isContextLoss = (e: unknown) =>
  /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated|Target closed|No frame/.test(
    String(e instanceof Error ? e.message : e),
  );
/** A line the call already printed: the REPL's echo of the returned value stays empty. */
const printed = (line: string) =>
  Object.defineProperty(new String(line), Symbol.for('nodejs.util.inspect.custom'), {
    value: () => '',
  });

type Rect = { x: number; y: number; w: number; h: number };
/**
 * v2. A scroll area: its client box in viewport px, the controls it hides, and its scroll position, visible
 * height and full height in its own px (zoom and scale make the two differ). The page is the outermost one.
 */
type Area = Rect & {
  id: number;
  left: number;
  top: number;
  shown: number;
  height: number;
  above: number;
  below: number;
  name?: string;
  in?: Area;
  off: Off | null;
  /** ax.small: its content is at most that many screens high, so all of it is printed. */
  whole: boolean;
};
/** v2. The scroll area that hides a box, and on which side. */
type Off = { by: Area; above: boolean };
const view = (a: Area) =>
  `${Math.round(a.top)}-${Math.round(a.top + a.shown)} of ${Math.round(a.height)} px`;
/** v2. One call gives every box. overflow-y finds the scroll areas, position what a node hangs on. */
const SNAPSHOT = { computedStyles: ['overflow-y', 'position'], includeDOMRects: true };

/**
 * v2. Null when a box shows through every scroll area around it and the screen; else what hides it.
 * Only up and down: what is left or right of an area prints as today, so a carousel loses nothing.
 */
function offBy(box: Rect, inside: Area): Off | null {
  if (inside.off) return inside.off; // an area that is off screen hides its content the same way
  let { y, h } = box;
  for (let a: Area | undefined = inside; a; a = a.in) {
    const above = y + h <= a.y;
    if (above || y >= a.y + a.h) {
      if (!a.whole) return { by: a, above };
      ({ y, h } = a); // a small area hides nothing: further out, its own box stands for what it holds
      continue;
    }
    // Only the part inside this area can show further out.
    h = Math.min(y + h, a.y + a.h) - Math.max(y, a.y);
    y = Math.max(y, a.y);
  }
  return null;
}

/**
 * v2. The box of every laid-out node in viewport px, with its nearest scroll area, from one DOMSnapshot.
 * Its bounds are document px and already include the scroll of inner areas, fixed and sticky offsets.
 */
function layout(snap: Protocol.DOMSnapshot.CaptureSnapshotResponse, small = 0) {
  const boxes = new Map<number, Rect & { in: Area }>();
  const areas = new Map<number | string, Area>(); // by backendNodeId; a frame's own scroll by its frame id
  type Scroll = (number | undefined)[]; // [scrollLeft, scrollTop, , scrollHeight]
  const area = (id: number, box: Rect, scroll: Scroll, shown: number, within?: Area): Area => ({
    ...box,
    id,
    left: scroll[0] ?? 0,
    top: scroll[1] ?? 0,
    shown,
    height: scroll[3] ?? 0,
    above: 0,
    below: 0,
    ...(within ? { in: within } : {}),
    off: within ? offBy(box, within) : null,
    whole: (scroll[3] ?? 0) <= small * (docs[0]?.area.h ?? box.h),
  });
  // Per document: what to add to its bounds, and the area its nodes are in.
  const docs: { x: number; y: number; area: Area }[] = [];
  snap.documents.forEach((d, di) => {
    const row = new Map(d.layout.nodeIndex.map((n, i) => [n, i]));
    const scroll = (f: typeof d) => [f.scrollOffsetX, f.scrollOffsetY, 0, f.contentHeight];
    if (!di) {
      // The main document node's box is the viewport.
      const [, , w = 0, h = 0] = d.layout.bounds[row.get(0) ?? -1] ?? [];
      const screen = area(0, { x: 0, y: 0, w, h }, scroll(d), h);
      docs[0] = { x: -screen.left, y: -screen.top, area: screen };
    }
    const doc = docs[di];
    if (!doc) return; // its iframe has no box
    const frames = d.nodes.contentDocumentIndex;
    const within: Area[] = []; // per node: its nearest scroll area
    const own: Area[] = []; // per node: the scroll area it is
    const based: Area[] = []; // per node: the scroll area its absolute children are in
    const parked: boolean[] = []; // per node: it or an ancestor is parked, see below
    let root = 'visible';
    d.nodes.parentIndex?.forEach((parent, n) => {
      const i = row.get(n) ?? -1;
      const [overflow = '', position = ''] = (d.layout.styles[i] ?? []).map((s) => snap.strings[s]);
      // A fixed node hangs on the screen and an absolute one on its nearest positioned ancestor: a menu or a
      // dialog declared inside a list is not clipped by that list.
      const inside = (within[n] =
        position === 'fixed'
          ? doc.area
          : position === 'absolute'
            ? (based[parent] ?? doc.area)
            : (own[parent] ?? within[parent] ?? doc.area));
      const positioned = /absolute|fixed|relative|sticky/.test(position);
      based[n] = positioned ? inside : (based[parent] ?? doc.area);
      const id = d.nodes.backendNodeId?.[n];
      const [bx = 0, by = 0, w = 0, h = 0] = d.layout.bounds[i] ?? [];
      const box = { x: bx + doc.x, y: by + doc.y, w, h };
      // Parked: positioned above or left of where its area starts, so no scroll brings it back (skip links,
      // the real input of a styled radio). It and what is in it have no box here: the parent decides.
      parked[n] =
        parked[parent] ||
        (/absolute|fixed/.test(position) &&
          (box.y + h <= inside.y - inside.top || box.x + w <= inside.x - inside.left));
      if (!id || !(w > 0 && h > 0) || parked[n]) return;
      boxes.set(id, { ...box, in: inside });
      const [cx, cy = 0, cw = 0, ch = 0] = d.layout.clientRects?.[i] ?? [];
      if (cx === undefined) return; // text
      // Bounds are screen px. The offset, client and scroll rects are the node's own px: scale them.
      const [, , ow = 0, oh = 0] = d.layout.offsetRects?.[i] ?? [];
      const [sx, sy] = [ow ? w / ow : 1, oh ? h / oh : 1];
      const client = { x: box.x + cx * sx, y: box.y + cy * sy, w: cw * sx, h: ch * sy };
      const scrolls = d.layout.scrollRects?.[i] ?? [];
      const child = frames?.value[frames.index.indexOf(n)];
      const frame = snap.documents[child ?? -1];
      if (child !== undefined && frame) {
        // An iframe: its document starts at the client box and scrolls by itself.
        const framed = area(id, client, scroll(frame), ch, inside);
        areas.set(snap.strings[frame.frameId] ?? '', framed);
        docs[child] = { x: client.x - framed.left, y: client.y - framed.top, area: framed };
      } else if (parent === 0) {
        root = overflow; // <html> scrolls the viewport, and so does <body> while <html> is visible
      } else if (
        /auto|scroll|overlay/.test(overflow) &&
        (scrolls[3] ?? 0) > ch + 1 &&
        !(root === 'visible' && /^body$/i.test(snap.strings[d.nodes.nodeName?.[n] ?? -1] ?? ''))
      ) {
        own[n] = area(id, client, scrolls, ch, inside);
        areas.set(id, own[n]);
        if (positioned) based[n] = own[n];
      }
    });
  });
  return { page: docs[0]!.area, boxes, areas };
}

/** ax.diff. What the last look showed: its page key, line 1 after the tag, line 2 and the lines after the cap. */
type Shown = { key: string; page: string; view: string; lines: string[] };
/** ax.diff. A diff is printed when it is at most this share of the full print and has at most this many ~ and + lines. */
const DIFF_RATIO = 0.5;
const DIFF_LINES = 40;
const SAME = '[state same]\nnothing changed on screen since the last state';

/**
 * ax.diff. What tells `now` from `was`: the ids that left, and in page order ~ for an id line that changed and
 * + for a new line, with "@ after [id]" before each run of + lines. Text that left is not listed.
 */
function changes(was: string[], now: string[]) {
  // An id line is known by "[12]", a scroll area line by "[12] scroll area": a scroller that is a control prints both.
  const key = (line: string) => /^\[(\d+)\]( scroll area)?/.exec(line);
  const old = new Map<string, string>(); // the id lines of the last print
  const left = new Set<number>(); // its ids that this print does not have
  for (const line of was) {
    const m = key(line);
    if (!m) continue;
    old.set(m[0], line);
    left.add(Number(m[1]));
  }
  // A text line has no id. It is the same line when it reads the same under the same id line, the nearest one
  // above it that both prints have. So a text that a new row repeats is new, and one pushed down by new rows is not.
  const kept = new Set(now.map((line) => key(line)?.[0]).filter((k) => k && old.has(k)));
  const placed = (all: string[]) => {
    let above = '';
    return all.map((line) => {
      const k = key(line)?.[0];
      if (kept.has(k)) above = k!;
      return k ? '' : `${above}\n${line}`;
    });
  };
  const texts = new Map<string, number>(); // the text lines of the last print by place, counted
  for (const text of placed(was)) if (text) texts.set(text, (texts.get(text) ?? 0) + 1);
  const places = placed(now);
  const lines: string[] = [];
  const shown: number[] = [];
  let anchor = ''; // the id line above
  let added = false; // inside a run of new lines
  now.forEach((line, i) => {
    const m = key(line);
    const text = places[i]!;
    const known = m ? old.get(m[0]) : texts.get(text) ? line : undefined;
    if (!m && known) texts.set(text, texts.get(text)! - 1);
    if (known === undefined && !added && anchor) lines.push(`@ after ${anchor}`);
    if (known !== line) lines.push(`${known === undefined ? '+' : '~'}${line}`);
    // A run of new lines ends at an id line that was there before, not at a text line that stayed.
    if (m || known === undefined) added = known === undefined;
    if (!m) return;
    anchor = `[${m[1]}]`;
    left.delete(Number(m[1]));
    shown.push(Number(m[1]));
  });
  // "a-b" stands for every id shown before from a to b, so a range ends at an id that is still shown.
  const ranges: number[][] = [];
  let open = false;
  for (const n of [...left, ...shown].sort((a, b) => a - b)) {
    if (open && left.has(n)) ranges.at(-1)![1] = n;
    else if (left.has(n)) ranges.push([n, n]);
    open = left.has(n);
  }
  return { gone: ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', '), lines };
}

/** Appended to the system prompt in ultrafast mode. */
export const AX_PROMPT = `

Ultrafast: the global \`bu\` in the javascript REPL. Each model call costs ~1 s, so chain everything you already know into one javascript call.
- Look: await page.goto(url); await bu.state() prints the page in order and returns that text: [id] role "name" = value plus states, ## headings and visible text; * marks ids new since the last look. After a javascript call whose bu actions reached the page, the state is printed automatically.
  Ids are Chrome backendNodeIds: they work in bu.* and in every CDP DOM command.
- Act: await bu.click(1400); await bu.type(812, 'Zurich'); await bu.type(830, 'Oct 14', {enter: true}). type replaces the field's text. bu.type(id, 'Canada') also picks a native select option; don't click it first.
  Each action prints one line: navigated to <url> / page changed / no change. Autocomplete: type, look, then click the suggestion.
- Raw: upload to a file line with await page.cdp('DOM.setFileInputFiles', {backendNodeId: id, files: [await artifact('cv.txt', 'text')]}); keys await page.cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}) then the same with type 'keyUp'; drag with Input.dispatchMouseEvent mousePressed, mouseMoved, mouseReleased.
- If a helper fails once, do it raw. Read data with page.evaluate(() => ...), but confirm an outcome with bu.state() (visible text only), not innerText. Never add blind sleeps (setTimeout): actions and bu.state() wait for the page; for a specific condition use await page.waitFor(() => ...).
- alert/confirm/prompt/beforeunload dialogs are accepted automatically; their text is printed as [dialog ...].
`;

/** AX_PROMPT with the sentences that the ax switches change. With no switch it is AX_PROMPT. */
export function axPrompt(ax: AxOptions = {}) {
  let prompt = AX_PROMPT;
  const edit = (from: string, to: string) => (prompt = prompt.replace(from, to));
  if (ax.state === 'v2')
    edit(
      'prints the page in order and returns that text:',
      'prints what is on screen in order and returns that text: line 2 is the scroll position (view 0-813 of 9480 px | 0 controls above | 141 below), then',
    );
  if (ax.state === 'v2')
    edit(
      'in every CDP DOM command.',
      'in every CDP DOM command. Ids of an earlier page are stale: bu.click and bu.type refuse them; use the ids of the newest state.',
    );
  if (ax.diff)
    edit(
      '; * marks ids new since the last look.',
      '. A later look at the same page may print only [state diff]: ~ a changed line, + a new line (@ after [id]: where it sits), gone: ids that left the screen; or [state same]. bu.state({full: true}) reprints all.',
    );
  if (ax.autoState === false)
    edit(
      ' After a javascript call whose bu actions reached the page, the state is printed automatically.',
      ' The state is not printed after an action: look when you need it.',
    );
  else if (ax.rawInput)
    edit('whose bu actions reached', 'whose bu actions or raw Input commands reached');
  if (ax.scroll)
    edit(
      "; don't click it first.",
      `; don't click it first. await bu.scroll('down') or 'up' moves one screen; {pages: 0.5} less${ax.state === 'v2' ? ', {at: id} inside a "scroll area" line' : ''}.`,
    );
  else if (ax.state === 'v2')
    edit(
      'mouseMoved, mouseReleased.',
      `mouseMoved, mouseReleased; scroll with await page.cdp('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: 800}): deltaY is px down, negative up; x, y on screen, or inside a "scroll area" line's box (DOM.getBoxModel) to scroll that list.`,
    );
  return prompt;
}

/** State print and id-based actions on Chrome's accessibility tree. Raw page/CDP stays available. */
export class AxHelpers {
  constructor(
    private page: () => Page,
    private browser: () => CDP,
    private log: (text: string) => void,
    ax: AxOptions = {},
  ) {
    this.#ax = ax;
    if (ax.scroll) this.scroll = (to, options) => this.#scroll(to, options);
  }

  /** The ax switches. #private, as all v2 state: the model's code sees `bu`, and with no switch it is today's object. */
  #ax: AxOptions;
  /** Only with ax.scroll. */
  declare scroll?: (
    to: 'down' | 'up',
    options?: { pages?: number; at?: number },
  ) => Promise<String>;
  /** ax.rawInput: set by the worker on a raw Input command. The next look prints its verdict line. */
  declare raw?: boolean;
  /** ax.diff: set by the worker when the agent compacted its history. The next look prints in full. */
  declare full?: boolean;
  /** ax.rawInput: the probe of the last look. */
  #seen: Awaited<ReturnType<AxHelpers['probe']>> | undefined;
  /**
   * v2: every id a look has printed, with the page it was last printed on (main frame id:loaderId) and its role
   * and name there, so that a stale message can name the element. Nothing else is kept of an earlier page.
   */
  #ids = new Map<number, { role: string; name: string; key: string }>();
  #shown: Shown | undefined;
  private inflight = new Map<string, Map<string, number>>();
  private lastNet = new Map<string, number>();
  private tracked = new Set<string>();
  private dialogs: string[] = [];
  /** Role and name of every id in the last print: marks new ids and names targets in action lines. */
  private last = new Map<number, { role: string; name: string }>();
  /** Set by every action; the worker prints the state after that cell. */
  acted = false;
  /** When the last action's settle began, 0 after a failed action. With ax.rawInput the worker sets both on raw input. */
  actedAt = 0;

  /** Track in-flight requests per page session from CDP Network events (no page patching). */
  private async trackNetwork(page: Page) {
    const cdp = this.browser();
    if (!(cdp as { __buTracked?: boolean }).__buTracked) {
      const previous = cdp.observeEvent;
      cdp.observeEvent = (method, raw, session) => {
        previous?.(method, raw, session);
        // An open alert/confirm blocks the page and every CDP call on it: accept it and report its text.
        if (method === 'Page.javascriptDialogOpening') {
          const d = raw as { type: string; message: string; defaultPrompt?: string };
          this.dialogs.push(
            `[dialog ${d.type}] ${JSON.stringify(clip(d.message, 300))} (accepted)`,
          );
          void cdp
            .send(
              'Page.handleJavaScriptDialog',
              { accept: true, promptText: d.defaultPrompt ?? '' },
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

  /** URL, title, document identity, a counter of DOM mutations (style aside) and form input/change events. */
  private probe(page: Page) {
    const scroll = this.#ax.state === 'v2' || !!this.#ax.scroll;
    return page.evaluate((scroll) => {
      const w = window as unknown as {
        __buObs?: MutationObserver;
        __buLast: number;
        __buN: number;
        __buDoc: number;
      };
      if (!w.__buObs) {
        w.__buLast = performance.now();
        w.__buN = 0;
        w.__buDoc = Math.random();
        // The action highlight's own overlay is not the page reacting. A style change counts only as the first
        // on its element in 200 ms: a menu shown via style.display is a change, an animation loop goes quiet.
        const own = (n: Node) =>
          (n as Element).hasAttribute?.('data-browser-use-interaction-highlight');
        const styled = new WeakMap<Node, number>();
        w.__buObs = new MutationObserver((records) => {
          const now = performance.now();
          let real = false;
          for (const r of records) {
            if (
              own(r.target) ||
              Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(own)
            )
              continue;
            // Writing an attribute's current value changes nothing (Google Flights rewrites a class every frame).
            if (
              r.attributeName &&
              r.oldValue ===
                (r.target as Element).getAttributeNS(r.attributeNamespace, r.attributeName)
            )
              continue;
            if (r.attributeName !== 'style') real = true;
            else if (now - (styled.get(r.target) ?? -1e9) > 200) real = true;
            if (r.attributeName === 'style') styled.set(r.target, now);
          }
          if (real) {
            w.__buLast = now;
            w.__buN++;
          }
        });
        w.__buObs.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
        });
        for (const type of ['input', 'change']) addEventListener(type, () => w.__buN++, true);
        // v2: a wheel event scrolls after its command returns, so the page is not quiet while something scrolls.
        // Per scroller a run of scroll events counts for 1.5 s: a ticker that never stops is not the page reacting.
        const runs = new WeakMap<object, { start: number; last: number }>();
        const scrolled = ({ target }: Event) => {
          const now = performance.now();
          const run = runs.get(target!) ?? { start: now, last: now };
          if (now - run.last > 200) run.start = now;
          run.last = now;
          runs.set(target!, run);
          if (now - run.start < 1500) w.__buLast = now;
        };
        if (scroll) addEventListener('scroll', scrolled, true);
      }
      return {
        idle: performance.now() - w.__buLast,
        ready: document.readyState,
        url: location.href,
        title: document.title,
        n: w.__buN,
        doc: w.__buDoc,
        files: !!document.querySelector('input[type=file]'),
      };
    }, scroll);
  }

  /**
   * Event-based wait, never a fixed sleep: document parsed, no fresh in-flight requests
   * (older than 1.5 s are treated as long-poll/analytics), and no DOM mutation for quietMs. Bounded by capMs.
   */
  async settle(options: { capMs?: number; quietMs?: number; page?: Page; since?: number } = {}) {
    const page = options.page ?? this.page();
    const cap = options.capMs ?? 800;
    const quiet = options.quietMs ?? 80;
    const start = Date.now();
    const session = await this.trackNetwork(page).catch(() => undefined);
    let limit = cap;
    let pending = 0;
    let probe: Awaited<ReturnType<AxHelpers['probe']>> | undefined;
    const inflight = () =>
      session
        ? [...(this.inflight.get(session)?.values() ?? [])].filter((t) => Date.now() - t < 1500)
            .length
        : 0;
    const netBusy = () =>
      (pending = inflight()) > 0 ||
      (session ? Date.now() - (this.lastNet.get(session) ?? 0) : quiet) < quiet;
    while (Date.now() - start < limit) {
      try {
        probe = await this.probe(page);
        if (probe.ready === 'loading') limit = Math.max(cap, 3000); // navigations need longer than in-page updates
        probe.idle = Math.min(probe.idle, Date.now() - (options.since || start)); // quiet must be observed after this action began
        if (probe.ready !== 'loading' && probe.idle >= quiet && !netBusy())
          return { why: 'quiet', pending, ms: Date.now() - start, probe };
      } catch (error) {
        // Navigation in progress: wait for the new document. Anything else ends the wait, never the action.
        if (!isContextLoss(error)) return { why: 'error', pending, ms: Date.now() - start };
        probe = undefined;
      }
      // Probe again once the DOM can have been quiet for quietMs; wait out in-flight requests here, not in the page.
      await delay(probe && probe.ready !== 'loading' ? Math.max(20, quiet - probe.idle) : 40);
      while (probe && probe.idle >= quiet && netBusy() && Date.now() - start < limit)
        await delay(20);
    }
    return { why: 'cap', pending: inflight(), ms: Date.now() - start };
  }

  private flushDialogs() {
    return this.dialogs.length ? `\n${this.dialogs.splice(0).join('\n')}` : '';
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
          let e = n.parentElement;
          if (!e || !n.textContent?.trim()) continue;
          // display:contents has no box, so checkVisibility is false; its text shows through the nearest boxed ancestor.
          while (e.parentElement && getComputedStyle(e).display === 'contents') e = e.parentElement;
          if (!shown.has(e))
            shown.set(e, e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
          if (shown.get(e)) out.push(n.textContent);
        }
      }
      return out.join(' ').replace(/\s+/g, ' ').toLowerCase();
    });
  }

  /** AX trees of the main frame and of every same-process child frame (other frames fail and are skipped). */
  private async capture(page: Page) {
    for (let i = 0; ; i++) {
      try {
        const [{ nodes }, { frameTree }, snap] = await Promise.all([
          page.cdp('Accessibility.getFullAXTree'),
          page.cdp('Page.getFrameTree'),
          this.#ax.state === 'v2' ? page.cdp('DOMSnapshot.captureSnapshot', SNAPSHOT) : undefined,
        ]);
        const children: { url: string; id: string }[] = [];
        const walk = (tree: typeof frameTree) =>
          tree.childFrames?.forEach((child) => {
            children.push({ url: child.frame.url, id: child.frame.id });
            walk(child);
          });
        walk(frameTree);
        const frames = await Promise.all(
          children.map(({ url, id }) =>
            page.cdp('Accessibility.getFullAXTree', { frameId: id }).then(
              (r) => ({ url, id, nodes: r.nodes }),
              () => ({ url, id, nodes: [] as AX[] }),
            ),
          ),
        );
        const key = `${frameTree.frame.id}:${frameTree.frame.loaderId}`;
        return { frames: [{ url: '', id: '', nodes }, ...frames], snap, key };
      } catch (error) {
        if (i >= 20 || !isContextLoss(error)) throw error;
        await delay(50);
      }
    }
  }

  /** The page as one list in page order. ax.diff: {full: true} prints all of it. {verdict: true} is the worker's. */
  async state(options: { max?: number; full?: boolean; verdict?: boolean } = {}) {
    const page = this.page();
    // A look right after an action continues that action's quiet window instead of starting a new one.
    const since = this.acted ? this.actedAt : 0;
    this.acted = false; // a look after the last action replaces the automatic print
    const settled = await this.settle({ capMs: 3000, since });
    // ax.rawInput: raw input gets the verdict line of a helper, against the page as the last look left it.
    if (this.#ax.rawInput) {
      const now = settled.probe ?? (await this.probe(page).catch(() => undefined));
      if (this.raw) this.log(`[ok] raw input -> ${await this.change(this.#seen, now)}`);
      this.raw = false;
      this.#seen = now;
    }
    if (options.verdict) return; // ax.autoState false: raw input still gets the wait and its verdict line
    // The settle probe already has URL and title, and says whether a file input needs looking up.
    const [{ frames, snap, key }, info, visible, files] = await Promise.all([
      this.capture(page),
      settled.probe ?? page.info(),
      this.visibleText(page).catch(() => undefined),
      settled.probe?.files === false ? [] : this.fileInputs(page).catch(() => []),
    ]);
    const previous = this.last;
    this.last = new Map();
    let lines: string[] = [];
    const text: string[] = [];
    const flush = () => text.length && lines.push(text.splice(0).join(' '));
    // v2 prints only what is on screen: geo has every box, and what is off screen is counted per scroll area.
    const geo = snap && layout(snap, this.#ax.small);
    const announced = new Map<string, Area>();
    const announce = (area: Area, name: string) => {
      // Stands in for the area's line until the walk has counted what it hides. No line starts with a space.
      const mark = ` ${announced.size}`;
      announced.set(mark, Object.assign(area, { name }));
      if (!this.last.has(area.id)) this.last.set(area.id, { role: 'scroll area', name });
      return mark;
    };
    let textEnd = 0;
    let block = 0; // v2: how deep the walk is inside BLOCKS, where text stays one line
    let modal = false;
    for (const frame of frames) {
      const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
      const start = lines.length;
      // v2: null when n or something inside it is on screen, undefined when nothing in it has a box.
      const seen = new Map<AX, Off | null | undefined>();
      const offOf = (n: AX): Off | null | undefined => {
        if (seen.has(n)) return seen.get(n);
        const box = geo!.boxes.get(n.backendDOMNodeId ?? 0);
        let off = box && offBy(box, box.in);
        for (const c of n.childIds ?? []) {
          if (off === null) break; // ancestors of something on screen are kept
          const kid = byId.get(c);
          const k = kid && offOf(kid);
          off = k === null ? null : (off ?? k);
        }
        seen.set(n, off);
        return off;
      };
      const walk = (n: AX | undefined, inside: string, up: Off | null = null) => {
        if (!n) return;
        const role = String(n.role?.value ?? '');
        const name = norm(n.name?.value);
        // v2: what hides n, null when it is on screen. A node without a box goes with its parent.
        const mine = geo ? offOf(n) : null;
        const off = mine === undefined ? up : mine;
        const kids = () => n.childIds?.forEach((c) => walk(byId.get(c), inside, off));
        const area = !off && geo?.areas.get(n.backendDOMNodeId ?? 0);
        if (area && !area.off) {
          flush();
          lines.push(announce(area, name));
        }
        if (n.ignored) return kids();
        // v2: a closed drawer keeps aria-modal while it is parked off screen. Only a dialog with a box on screen counts.
        if (/dialog$/.test(role) && prop(n, 'modal') && mine === null) modal = true;
        if (role === 'StaticText') {
          const t = name.toLowerCase();
          if (off) return;
          if (t && !inside.includes(t) && (visible === undefined || visible.includes(t))) {
            // v2: outside a block, text whose box starts below the end of the previous text is a new line (rows of plain divs).
            const box = geo?.boxes.get(n.backendDOMNodeId ?? 0);
            if (box && !block && text.length && box.y >= textEnd) flush();
            if (box) textEnd = box.y + box.h;
            text.push(name);
          }
          return;
        }
        if (role === 'heading' && name) {
          if (off) return kids(); // v2: off screen it is no line, and no control to count either
          flush();
          lines.push(`## ${name}`);
          inside = name.toLowerCase();
          return kids();
        }
        const id = n.backendDOMNodeId;
        // Focusable wrappers (tabindex=-1 dialogs, <main>) are only controls if they carry a name, value or editing.
        const focusable =
          prop(n, 'focusable') &&
          role !== 'RootWebArea' &&
          (name || n.value?.value || prop(n, 'editable'));
        if (!id || !(CONTROLS.has(role) || focusable)) {
          if (!BLOCKS.has(role)) return kids();
          flush();
          block++;
          kids();
          block--;
          return flush();
        }
        const value = norm(n.value?.value);
        // A native <select> keeps its options in a popup child: summarize them instead of listing each.
        const popup = n.childIds
          ?.map((c) => byId.get(c))
          .find((c) => c?.role?.value === 'MenuListPopup');
        const shown = popup
          ? 'select'
          : role === 'button' && value
            ? 'file'
            : role === 'generic' && prop(n, 'editable')
              ? 'textbox'
              : role;
        this.last.set(id, { role: shown, name });
        const widget = popup || NATIVE_INPUTS.has(role); // their children are the browser's own widget parts
        if (off) {
          // v2: an off-screen control is counted, on line 2 or on its scroll area's line, not printed.
          // It is still known: no * when it scrolls into view, and it is not a hidden file input.
          off.by[off.above ? 'above' : 'below']++;
          return widget ? undefined : kids();
        }
        flush();
        if (lines.at(-1)?.toLowerCase() === name.toLowerCase()) lines.pop(); // its label, printed as its name
        const states = [
          prop(n, 'checked') === undefined
            ? ''
            : prop(n, 'checked') === 'false'
              ? 'unchecked'
              : 'checked',
          prop(n, 'expanded') === undefined ? '' : prop(n, 'expanded') ? 'expanded' : 'collapsed',
          ...['selected', 'disabled', 'focused'].map((p) => (prop(n, p) ? p : '')),
        ].filter(Boolean);
        const options: string[] = [];
        const collect = (c?: AX): unknown =>
          c?.role?.value === 'option'
            ? options.push(norm(c.name?.value))
            : c?.childIds?.forEach((k) => collect(byId.get(k)));
        collect(popup);
        lines.push(
          `${!this.#ax.diff && previous.size && !previous.has(id) ? '*' : ''}[${id}] ${shown}${name ? ` "${clip(name, 150)}"` : ''}${value ? ` = ${JSON.stringify(clip(value, 100))}` : ''}${states.length ? ` ${states.join(' ')}` : ''}${options.length ? `  options: ${options.slice(0, 5).join(' | ')}${options.length > 5 ? ` | … ${options.length - 5} more` : ''}` : ''}`,
        );
        if (widget) return;
        // Only what the line showed counts as said: a card link's text past the clipped name still prints.
        inside = `${inside} ${clip(name, 150)} ${value}`.toLowerCase();
        kids();
        flush();
      };
      walk(frame.nodes[0], '');
      flush();
      if (frame.url && lines.length > start) lines.splice(start, 0, `--- frame ${frame.url} ---`);
      // v2: a frame that scrolls by itself has its scroll area line under its frame line.
      const scrolls = geo?.areas.get(frame.id);
      if (scrolls && lines.length > start) lines.splice(start + 1, 0, announce(scrolls, ''));
    }
    // v2: a scroll area gets its line when it hides a control or more than 40 px (two lines of text).
    let inner = 0;
    if (announced.size)
      lines = lines.flatMap((line) => {
        const a = announced.get(line);
        if (!a) return [line];
        if (!(a.above + a.below) && a.height - a.shown <= 40) return [];
        inner++;
        return [
          `[${a.id}] scroll area${a.name ? ` "${clip(a.name, 150)}"` : ''} ${view(a)} | ${a.above} above | ${a.below} below`,
        ];
      });
    // Styled uploaders hide their file input, which drops it from the AX tree; its id still works for uploads.
    const hidden = files
      .filter((f) => !this.last.has(f.backendNodeId))
      .map((f) => {
        const at = (k: string) => f.attributes?.find((_, i, a) => i % 2 === 1 && a[i - 1] === k);
        const name = at('aria-label') ?? at('name') ?? at('id') ?? '';
        this.last.set(f.backendNodeId, { role: 'file', name });
        return `[${f.backendNodeId}] file "${name}" (hidden)`;
      });
    lines.unshift(...hidden);
    const screen = geo?.page;
    // v2 line 2: where the screen is on the page, and the controls that are not on it.
    // "whole page" only when nothing scrolls: the page fits, hides no control, and no scroll area has a line.
    const whole = screen && screen.height <= screen.h && !(screen.above + screen.below + inner);
    const line2 = screen
      ? `\nview ${view(screen)} | ${whole ? 'whole page' : `${screen.above} controls above | ${screen.below} below`}${modal ? ' | modal open' : ''}`
      : '';
    const title = `${info.title} | ${info.url}`;
    const loading = settled.pending ? ` | loading: ${settled.pending}` : '';
    const dialogs = this.flushDialogs();
    const header = `[state] ${title}${loading}${line2}${dialogs}`;
    const max = options.max ?? (geo ? (this.#ax.cap ?? 6000) : 3000);
    // v2: no line takes more than half the print. A longer one (a text file is one line) was cut whole.
    if (geo) lines = lines.map((line) => clip(line, max / 2));
    const fit = (from: string[], budget: number) => {
      let size = 0;
      const n = from.findIndex((l) => (size += l.length + 1) > budget);
      return n < 0 ? from.length : n;
    };
    let body = lines;
    // Over max, keep the top and the last fifth: a dialog's Done/Submit is usually its last line.
    if (fit(lines, max) < lines.length) {
      const head = fit(lines, max * 0.8);
      const tail = fit(lines.toReversed(), max * 0.2);
      body = [
        ...lines.slice(0, head),
        screen // the cut is in the middle of the screen: half a screen further down it is at the top, if the page can go there
          ? `... ${lines.length - head - tail} on-screen lines cut at ${max} chars: ${screen.top + screen.shown < screen.height - 1 ? 'scroll half a screen or ' : ''}read with page.evaluate`
          : `... ${lines.length - head - tail} lines cut here (bu.state({max: 30000}) or page.evaluate)`,
        ...lines.slice(lines.length - tail),
      ];
    }
    const out = `${header}\n${body.join('\n')}\n[/state]`;
    // v2: the ids of the lines the model is shown are remembered with their page. An id that was only counted
    // or cut is not: the model cannot hold an old copy of it, and a raw DOM query may return its number.
    for (const line of geo ? body : []) {
      const id = Number(/^\*?\[(\d+)\]/.exec(line)?.[1]);
      const n = this.last.get(id);
      if (n) this.#ids.set(id, { ...n, key });
    }
    const now = { key, page: title, view: line2, lines: body };
    this.log(this.#ax.diff ? this.#brief(now, loading, dialogs, out, options.full) : out);
    return printed(out);
  }

  /**
   * ax.diff: what this look prints. All of it on a first look, on a new page and on request. Else the diff,
   * when it says what changed in at most half the chars, and the "same" form when nothing changed.
   */
  #brief(now: Shown, loading: string, dialogs: string, out: string, full?: boolean) {
    const was = this.#shown;
    this.#shown = now; // the base of the next diff is what the model has now: these lines, after the cap
    full ||= this.full;
    this.full = false;
    if (!was || full || was.key !== now.key) return out;
    const { gone, lines } = changes(was.lines, now.lines);
    const head = [
      // Title and url only when they changed: the Cloud UI reads text after the tag as the page title.
      `[state diff]${now.page !== was.page || loading ? ` ${now.page}${loading}` : ''}`,
      ...(now.view !== was.view ? [now.view.slice(1)] : []),
      ...(dialogs ? [dialogs.slice(1)] : []),
      ...(gone ? [`gone: ${gone}`] : []),
    ];
    // No line to print: nothing changed, or only what a diff cannot say (text that left, lines that moved).
    if (head.join() === '[state diff]' && !lines.length)
      return now.lines.join('\n') === was.lines.join('\n') ? SAME : out;
    const diff = [...head, ...lines, '[/state]'].join('\n');
    const marked = lines.filter((line) => line[0] !== '@').length;
    return diff.length <= DIFF_RATIO * out.length && marked <= DIFF_LINES ? diff : out;
  }

  private async fileInputs(page: Page) {
    const { root } = await page.cdp('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await page.cdp('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: 'input[type=file]',
    });
    return Promise.all(
      nodeIds.map(async (nodeId) => (await page.cdp('DOM.describeNode', { nodeId })).node),
    );
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
          (response.exceptionDetails.exception?.description ?? 'Node operation failed.').split(
            '\n    at ',
          )[0],
        );
      return response.result.value as T;
    } finally {
      await page.cdp('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  private describe(id: number) {
    const n = this.#ids.get(id) ?? this.last.get(id); // v2: as last printed, also after its page is gone
    return n ? `[${id}] ${n.role}${n.name ? ` "${clip(n.name, 60)}"` : ''}` : `[${id}]`;
  }

  /** Scroll into view and return a clickable, unobstructed center point, or throw a precise reason. */
  private async point(page: Page, id: number, editableCover = false) {
    await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => {});
    const p = await this.onNode<{ x: number; y: number; covered: boolean }>(
      page,
      id,
      `function(editableCover) {
        const e = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!e || !e.isConnected) throw Error('Target detached');
        if (e.matches(':disabled') || e.closest('[inert],[aria-disabled="true"]')) throw Error('Target disabled');
        if (e.matches('input[type=file]')) throw Error("File input: clicking opens the OS file chooser; upload with DOM.setFileInputFiles instead");
        if (!e.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) throw Error('Target hidden');
        const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw Error('Target outside viewport');
        const hit = e.getRootNode().elementFromPoint(x, y);
        const textField = (n) => n && (['INPUT','TEXTAREA'].includes(n.tagName) || n.isContentEditable);
        const covered = !e.contains(hit) && !(hit && hit.contains(e) && getComputedStyle(hit).pointerEvents !== 'none' && hit.tagName === 'LABEL') && !(editableCover && textField(e) && textField(hit));
        // Inside same-origin iframes, add each frame's content-box offset to get top-level viewport coordinates.
        let px = x, py = y;
        for (let w = e.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
          const f = w.frameElement, fr = f.getBoundingClientRect(), cs = getComputedStyle(f);
          px += fr.x + f.clientLeft + parseFloat(cs.paddingLeft);
          py += fr.y + f.clientTop + parseFloat(cs.paddingTop);
        }
        return {x: px, y: py, covered};
      }`,
      editableCover,
    );
    if (!p.covered) return p;
    const hit = await page
      .cdp('DOM.getNodeForLocation', { x: Math.round(p.x), y: Math.round(p.y) })
      .catch(() => undefined);
    const tree = hit
      ? await page
          .cdp('Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId })
          .catch(() => undefined)
      : undefined;
    // The node under the point and its ancestors: name the nearest one with a name or a dialog role.
    const byId = new Map(tree?.nodes.map((n) => [n.nodeId, n]));
    const top = tree?.nodes.find((a) => a.backendDOMNodeId === hit?.backendNodeId);
    let n = top;
    while (
      n &&
      n.role?.value !== 'RootWebArea' &&
      (n.ignored || !(norm(n.name?.value) || /dialog/.test(String(n.role?.value))))
    )
      n = n.parentId ? byId.get(n.parentId) : undefined;
    // A nameless overlay: name it by its own text instead of the page it sits on.
    const text = (x?: AX) =>
      norm(x?.name?.value) ||
      norm(
        x?.childIds?.map((c) => byId.get(c)).find((c) => c?.role?.value === 'StaticText')?.name
          ?.value,
      );
    if (!n || n.role?.value === 'RootWebArea') n = top;
    throw new Error(
      `Target covered by ${n ? `[${n.backendDOMNodeId}] ${n.role?.value} "${clip(text(n), 60)}"` : hit ? `[${hit.backendNodeId}]` : 'another element'}; nothing was clicked`,
    );
  }

  /** Runs one action on id and prints one line: navigated to <url> / page changed / no change. */
  private async act(op: string, id: number, body: (page: Page) => Promise<string>) {
    // Set before awaiting: an un-awaited or failed action still gets the state printed after its cell.
    this.acted = true;
    this.actedAt = 0;
    const page = this.page();
    await this.trackNetwork(page).catch(() => {});
    const before = await this.probe(page).catch(() => undefined);
    let detail: string;
    const raw = this.raw;
    const stale = (why: string) => {
      this.#shown = undefined; // ax.diff: the state that follows is a full one, not a diff
      return `stale: ${id} ${why}; use ids from ${this.#ax.autoState === false ? 'a new bu.state()' : 'the state below'}`;
    };
    try {
      // v2: an id last printed on an earlier page is another element here, even where Chrome reuses the number.
      // Nothing is sent to it. The state that follows the cell has this page's ids. An id that no look has
      // printed (from snapshot() or a DOM query) is not judged: it goes to Chrome as it is.
      const shown = this.#ids.get(id);
      if (shown) {
        const { frame } = (await page.cdp('Page.getFrameTree')).frameTree;
        if (shown.key !== `${frame.id}:${frame.loaderId}`)
          throw new Error(stale('belongs to a previous page'));
      }
      detail = await body(page);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // v2: an element that was removed, by Chrome's three texts for it, is stale too.
      const gone =
        this.#ax.state === 'v2' &&
        /Target detached|No node with given id|does not belong to the document/.test(why);
      throw new Error(
        `${op} ${this.describe(id)} failed: ${gone ? stale('is gone from this page') : why}`,
      );
    } finally {
      if (this.raw !== raw) this.raw = !!raw; // ax.rawInput: the helper's own input is not raw input
    }
    this.actedAt = Date.now();
    const settled = await this.settle();
    const line = `[ok] ${op} ${this.describe(id)}${detail} -> ${await this.change(before, settled.probe)}${this.flushDialogs()}`;
    this.log(line);
    return printed(line);
  }

  private async change(
    before: Awaited<ReturnType<AxHelpers['probe']>> | undefined,
    after?: Awaited<ReturnType<AxHelpers['probe']>>,
  ) {
    after ??= await this.probe(this.page()).catch(() => undefined);
    if (!before || !after) return 'page changed';
    if (after.doc !== before.doc || after.url !== before.url) return `navigated to ${after.url}`;
    return after.n !== before.n ? 'page changed' : 'no change';
  }

  async click(id: number) {
    return this.act('click', id, async (page) => {
      const p = await this.point(page, id);
      await page.clickAt(p.x, p.y);
      return '';
    });
  }

  async type(id: number, text: string, options: { enter?: boolean } = {}) {
    if (typeof text !== 'string') throw new Error('type needs a string.');
    return this.act('type', id, async (page) => {
      const kind = await this.onNode<{ tag: string; type: string }>(
        page,
        id,
        `function(){const e=this.nodeType===1?this:this.parentElement;if(!e||!e.isConnected)throw Error('Target detached');return {tag:e.tagName,type:e.type||''};}`,
      );
      if (kind.tag === 'SELECT') {
        const label = await this.onNode<string>(
          page,
          id,
          `function(want){
            const n = s => String(s).replace(/\\s+/g,' ').trim().toLowerCase(), opts = [...this.options].filter(o => !o.disabled);
            const pre = opts.filter(o => n(o.label).startsWith(n(want)));
            const o = opts.find(o => n(o.label) === n(want) || n(o.value) === n(want)) ?? (pre.length === 1 ? pre[0] : undefined);
            if (!o) throw Error((pre.length > 1 ? 'several options start with ' : 'no option ') + JSON.stringify(want) + '. Options: ' + (pre.length > 1 ? pre : opts).slice(0, 40).map(o => o.label).join(' | '));
            this.value = o.value;
            this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
            return o.label;
          }`,
          text,
        );
        return ` = ${JSON.stringify(label)}`;
      }
      if (
        kind.tag === 'INPUT' &&
        ['date', 'time', 'datetime-local', 'month', 'week'].includes(kind.type)
      ) {
        await this.onNode(
          page,
          id,
          `function(v){const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set,old=this.value;s.call(this,v);if(this.value!==v){s.call(this,old);throw Error('Invalid native date/time value; use its ISO format');}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}`,
          text,
        );
        return ` = ${JSON.stringify(text)}`;
      }
      const p = await this.point(page, id, true);
      await page.clickAt(p.x, p.y);
      // Comboboxes often move focus to their own overlay input on click; type there, not into the hidden original.
      const moved = await this.onNode<boolean>(
        page,
        id,
        `function(){const e=this.nodeType===1?this:this.parentElement;let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return !!a&&a!==e&&!e.contains(a)&&(['INPUT','TEXTAREA'].includes(a.tagName)||a.isContentEditable);}`,
      ).catch(() => false);
      if (!moved) await page.cdp('DOM.focus', { backendNodeId: id }).catch(() => {});
      const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 };
      await page.cdp('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        ...a,
        commands: ['selectAll'],
      });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...a });
      if (text === '') await this.key(page, 'Backspace', 8);
      else {
        // Datepickers and autocompletes react to key events, which insertText never sends: type the last character as a key.
        const chars = [...text];
        const last = chars.pop()!;
        if (chars.length) await page.cdp('Input.insertText', { text: chars.join('') });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: last, text: last });
        await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: last });
      }
      const actual = await (
        moved
          ? page.evaluate(() => {
              let a = document.activeElement as HTMLInputElement | null;
              while (a?.shadowRoot?.activeElement)
                a = a.shadowRoot.activeElement as HTMLInputElement;
              return a ? (a.isContentEditable ? a.innerText : (a.value ?? '')) : '';
            })
          : this.onNode<string>(
              page,
              id,
              `function(){const e=this.nodeType===1?this:this.parentElement;return e.isContentEditable?e.innerText:(e.value??'');}`,
            )
      ).catch(() => undefined);
      if (options.enter) await this.key(page, 'Enter', 13, '\r');
      return ` = ${JSON.stringify(clip(text, 60))}${moved ? ' (into the focused overlay input)' : ''}${actual !== undefined && actual !== text ? ` (field now shows ${JSON.stringify(clip(actual, 60))})` : ''}${options.enter ? ' +Enter' : ''}`;
    });
  }

  /**
   * ax.scroll. One wheel event over the scroll area `at`, else over what a wheel at the middle of the screen
   * moves: the innermost scroll area there that can still go that way, else the page. One page is the height
   * of what scrolls, so no row is skipped. Prints its new position.
   */
  async #scroll(to: 'down' | 'up', { pages = 1, at }: { pages?: number; at?: number } = {}) {
    if (to !== 'down' && to !== 'up') throw new Error("scroll needs 'down' or 'up'.");
    this.acted = true;
    this.actedAt = 0;
    const page = this.page();
    // The page, then every scroll area in page order, so the innermost is the last.
    const read = async () => {
      const geo = layout(await page.cdp('DOMSnapshot.captureSnapshot', SNAPSHOT), this.#ax.small);
      return [geo.page, ...geo.areas.values()];
    };
    const areas = await read();
    const screen = areas[0]!;
    const [x, y] = [screen.w / 2, screen.h / 2];
    const moves = (a: Area) =>
      !a.off &&
      a.x <= x &&
      x < a.x + a.w &&
      a.y <= y &&
      y < a.y + a.h &&
      (to === 'down' ? a.top + a.shown < a.height - 1 : a.top > 0);
    const target =
      at === undefined
        ? (areas.findLast(moves) ?? screen)
        : areas.find((a) => a.id === at && !a.off);
    if (!target)
      throw new Error(`scroll ${to} in ${this.describe(at!)} failed: not a scroll area on screen`);
    // The wheel goes to the middle of the part of it that is on screen.
    const mid = (from: number, size: number, max: number) =>
      (Math.max(from, 0) + Math.min(from + size, max)) / 2;
    await page.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: mid(target.x, target.w, screen.w),
      y: mid(target.y, target.h, screen.h),
      deltaX: 0,
      deltaY: (to === 'down' ? 1 : -1) * pages * target.h,
    });
    this.actedAt = Date.now();
    await this.settle();
    const now = (await read()).find((a) => a.id === target.id) ?? target;
    const line = `[ok] scroll ${to} ${pages} page${pages === 1 ? '' : 's'}${target === screen ? '' : ` in ${this.describe(target.id)}`} -> ${now.top === target.top ? 'no change: ' : ''}${target === screen ? 'view ' : ''}${view(now)}`;
    this.log(line);
    return printed(line);
  }

  private async key(page: Page, key: string, keyCode: number, text?: string) {
    const k = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    if (text)
      await page.cdp('Input.dispatchKeyEvent', { type: 'char', ...k, text, unmodifiedText: text });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }
}
