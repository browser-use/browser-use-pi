import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { axNodes, type AXNode, type Page, type Tabs } from './page.js';
import type { CDP } from './cdp.js';

type Target = number | string | { name: string; role?: string };
type Op = 'click' | 'fill' | 'select' | 'check';
type RawAX = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

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
const SUGGESTIONS = new Set([
  'option',
  'menuitem',
  'menuitemradio',
  'treeitem',
  'gridcell',
  'listitem',
]);
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

/** A first-person give-up ("I could not…", "Unable to find…"), not a negative finding ("returns no results"). */
export const GAVE_UP =
  /\b(I (?:could ?n[o'’]t|can ?n[o'’]t|cannot|was(?: not|n[o'’]t) able to)|unable to (?:find|access|complete|locate|verify|identify|determine))\b/i;

type SerpRow = { title: string; url: string; snippet: string };
/** DuckDuckGo HTML result rows, run inside the results page. */
const SERP = (): SerpRow[] => {
  // DuckDuckGo answers suspected bots with a challenge page (HTTP 202) and no results.
  if (document.querySelector('.anomaly-modal, form.challenge-form'))
    throw new Error('SEARCH_BLOCKED: DuckDuckGo showed a bot challenge');
  return Array.from(document.querySelectorAll('.result:not(.result--ad)'))
    .map((r) => {
      const a = r.querySelector('a.result__a');
      const link = new URL(a?.getAttribute('href') ?? '', location.href);
      return {
        title: a?.textContent?.trim() ?? '',
        url: link.searchParams.get('uddg') ?? link.href,
        snippet: r.querySelector('.result__snippet')?.textContent?.trim() ?? '',
      };
    })
    .filter((r) => r.title)
    .slice(0, 10);
};

/** A value its bu call already printed: the REPL's echo of it becomes a one-line note instead of a second copy. */
const printed = <T extends object>(value: T, note: string): T =>
  Object.defineProperty(value, Symbol.for('nodejs.util.inspect.custom'), { value: () => note });

/** Appended to the system prompt when the `bu` helpers are enabled. */
export const AX_PROMPT = `

Fast browser helpers: the global \`bu\` in the javascript REPL. Prefer them; raw page/CDP above stays available for anything they cannot do.
- Chain every action you already know into ONE javascript call. Each bu action waits for the page to settle (DOM quiet, max ~2 s) and prints one line. After a cell that changed the page, the fresh page state is printed automatically unless the cell already looked (state/find/read/table/list/links), so you rarely need a separate look.
- Actions: await bu.goto(url); await bu.click(t); await bu.fill(t, 'exact text', {enter:true}); await bu.select(t, 'Option label'); await bu.check(t, true); await bu.press('Enter'|'Tab'|'Escape'|'Space'|'ArrowDown'|'ArrowRight'…); await bu.click(t, {count: 2} or {button: 'right'}); await bu.hover(t); await bu.drag(t, target or {dx, dy}) for sliders, sortable lists and drop zones; await bu.upload(t, 'name.txt', 'content') writes that workspace file (omit content to use an existing one) and sets it on the file input (t is often "Choose File" or its id).
  t = a numeric id from bu.state()/bu.find(), the exact accessible name or a unique prefix of it, or {name, role}. No fuzzy matching: NOT_FOUND/AMBIGUOUS errors list candidates with ids and nothing is executed. Ids expire after navigation.
- Autocomplete fields (cities, airports, addresses): await bu.fill(t, 'Zurich', {pick: 'Zürich, Switzerland'}) types, waits for suggestions and clicks that one. Don't press Enter on a suggestion list you have not seen.
- Never construct opaque or encoded URL parameters (base64/protobuf tokens); use the site's controls or URLs you have observed.
- If an interaction fails, try one different route (ids from bu.find, another control, keyboard) before reporting that you are blocked.
- JavaScript alert/confirm/prompt dialogs are accepted automatically; their text is printed as [dialog ...] after the action.
- Look: await bu.state() -> {url,title,controls:[{id,role,name,value}],text}; await bu.find('word') -> matching controls with ids.
- Read without dumping HTML: await bu.read(region?) -> text lines (headings, [link](url), list items); await bu.table(i?) -> rows as objects keyed by column headers; await bu.list(i?) -> [{text, links}]; await bu.links('filter') -> [{name,url}]. Each prints a count, fields and a sample.
- Web search: await bu.search('exact words') -> [{title,url,snippet}] from DuckDuckGo in a background tab (Google shows captchas to automated browsers). await bu.search(['query 1', 'query 2', ...]) runs up to 6 queries at once -> {query: rows}; batch your query variants this way. Then open or bu.map the promising urls.
- Many pages: const rows = await bu.map(urls, () => ({title: document.title, price: document.querySelector('.price')?.textContent}), {concurrency: 6}) opens pages in parallel background tabs with per-host politeness and 429 backoff; returns [{url, ok, status, value|error}] and saves partial results to the workspace. {mode:'fetch'} fetches over HTTP instead and calls extract(text, {url,status}) in Node. Never loop page.goto over many URLs.
- Work longer than ~2 minutes: const id = bu.job('name', async progress => {...}); then await bu.wait(id) blocks up to 150 s, prints progress and returns {done, value}. Never poll with sleep loops or "alive" prints.
- NEVER write blind sleeps (setTimeout/new Promise delays/sleep) to wait for pages. Actions already settle. For a specific condition use await bu.waitForText('Results') or await page.waitFor(predicate).
- Inspect only when the next step depends on content you have not seen.
- Result pages: read rows with bu.list() or bu.read(); if the page says it is loading or fetching, bu.waitForText the result, then read again before concluding.
- When the deliverables are ready, write all files in one javascript call and call finish or finish_from_js in that same response; do not spend a separate turn re-reading files you just wrote.
- Timestamps: every bu line shows the UTC time it observed the page ('at ...Z'). Use those printed times for observation and access times in deliverables. Never generate, backfill or guess times or dates: new Date() at the end of the work is not an observation time.
`;

/** Fast, strict accessibility-tree helpers for the persistent REPL. Raw page/CDP stays available. */
export class AxHelpers {
  /** Set by an action once its input reached the page, so a failure after that is reported as uncertain. */
  private attempted = false;
  /** Set by mutations; the worker prints a fresh compact state after such a cell. */
  dirty = false;
  private busy = false;
  private jobs = new Map<
    string,
    {
      name: string;
      promise: Promise<unknown>;
      log: string[];
      seen: number;
      done: boolean;
      value?: unknown;
      error?: string | undefined;
      started: number;
    }
  >();
  private mapCount = 0;
  // Observation times are printed, never reconstructed later by the model.
  private at() {
    return ` at ${new Date().toISOString().slice(0, 19)}Z`;
  }

  constructor(
    private page: () => Page,
    private tabs: () => Tabs,
    private browser: () => CDP,
    private workspace: string,
    private log: (text: string) => void,
  ) {}

  private inflight = new Map<string, Map<string, number>>();
  private lastNet = new Map<string, number>();
  private tracked = new Set<string>();
  private dialogs: string[] = [];

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
            `[dialog ${d.type}${this.at()}] ${JSON.stringify(clip(d.message, 300))} (accepted)`,
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

  /**
   * Event-based wait, never a fixed sleep: document parsed, no fresh in-flight requests
   * (older than 1.5 s are treated as long-poll/analytics), and no DOM mutation for quietMs. Bounded by capMs.
   */
  async settle(options: { capMs?: number; quietMs?: number; page?: Page } = {}) {
    const page = options.page ?? this.page();
    const cap = options.capMs ?? 2000;
    const quiet = options.quietMs ?? 250;
    const start = Date.now();
    const session = await this.trackNetwork(page).catch(() => undefined);
    while (Date.now() - start < cap) {
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
        probe.idle = Math.min(probe.idle, now - start); // quiet must be observed after this action began
        const pending = session
          ? [...(this.inflight.get(session)?.values() ?? [])].filter((t) => now - t < 1500).length
          : 0;
        const netIdle = session ? now - (this.lastNet.get(session) ?? 0) : quiet;
        if (
          probe.ready !== 'loading' &&
          probe.idle >= quiet &&
          pending === 0 &&
          netIdle >= Math.min(quiet, 150)
        )
          return { why: 'quiet', ready: probe.ready, ms: now - start };
      } catch (error) {
        if (!isContextLoss(error)) throw error; // navigation in progress: wait for the new document
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
        const [{ nodes }, info] = await Promise.all([
          page.cdp('Accessibility.getFullAXTree'),
          page.info(),
        ]);
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
          if (n instanceof Element) {
            if (n.shadowRoot) roots.push(n.shadowRoot);
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
      `[state${this.at()}] ${result.title} | ${result.url}${this.flushDialogs()}\n${result.controls.map(brief).join('\n')}${result.more ? `\n… ${result.more} more controls: bu.find('word')` : ''}\n[text] ${result.text}`,
    );
    return printed(result, '[state printed above]');
  }

  /** Web search via DuckDuckGo's HTML page in background tabs; Google answers automated browsers with captchas. */
  async search(query: string | string[]) {
    const queries = Array.isArray(query) ? query : [query];
    if (queries.length > 6) throw new Error('bu.search takes at most 6 queries per call.');
    const url = (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const { results } = await this.crawl(
      queries.map(url),
      SERP,
      { perHost: 1, minGapMs: 500 },
      () => {},
    );
    if (results.every((r) => !r.ok)) throw new Error(results[0]?.error ?? 'search failed');
    const rows = results.map((r, i) => {
      if (!r.ok) this.log(`[search ${JSON.stringify(queries[i])}] failed: ${r.error}`);
      else this.logSerp(queries[i]!, (r.value as SerpRow[]).slice(0, queries.length > 1 ? 5 : 10));
      return (r.value ?? []) as SerpRow[];
    });
    const out = Array.isArray(query)
      ? Object.fromEntries(queries.map((q, i) => [q, rows[i]!]))
      : rows[0]!;
    return printed(out, '[search results printed above]');
  }

  private logSerp(query: string, rows: SerpRow[]) {
    this.log(
      `[search ${JSON.stringify(query)}${this.at()}] ${rows.length} result(s)\n${rows
        .map((r, i) => `${i + 1}. ${clip(r.title, 90)} | ${r.url} | ${clip(r.snippet, 150)}`)
        .join('\n')}`,
    );
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
    this.log(`[find "${query}"${this.at()}] ${hits.length} hit(s)\n${hits.map(brief).join('\n')}`);
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
      // Sites append details to names ("Done. Search for…", "October 14, 2026, 97 US dollars"); a unique prefix is still exact enough.
      if (!matches.length && norm(name).length >= 3)
        matches = prefer(
          usable.filter((n) => norm(n.name).startsWith(norm(name)) && (!role || n.role === role)),
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
        return {x, y, tag: e.tagName, type: e.type || '', editable: textField(e)};
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
    }>,
  ) {
    if (this.busy) throw new Error('Await bu actions sequentially; no concurrent mutations.');
    this.busy = true;
    this.attempted = false;
    try {
      await this.trackNetwork(this.page()).catch(() => {});
      const { id, detail, value } = await body();
      this.dirty = true;
      const settled = await this.settle();
      const info = await this.page()
        .info()
        .catch(() => ({ url: '?', title: '?' }));
      this.log(
        `[ok${this.at()}] ${op} ${typeof target === 'object' ? JSON.stringify(target) : JSON.stringify(target ?? '')}${id ? ` #${id}` : ''}${detail ? ` ${detail}` : ''} -> settled ${settled.why} ${settled.ms}ms | ${clip(info.title, 60)} | ${info.url}${this.flushDialogs()}`,
      );
      return {
        ok: true,
        op,
        id,
        url: info.url,
        title: info.title,
        settled,
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
    }
  }

  async goto(url: string) {
    return this.act('goto', url, async () => {
      const page = this.page();
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

  /** Write `content` to workspace file `name` (or use the existing file) and set it on a file input. */
  async upload(target: Target, name: string, content?: string) {
    return this.act('upload', target, async () => {
      const { page, node } = await this.resolve('click', target);
      const path = join(this.workspace, name);
      if (content !== undefined) await writeFile(path, content);
      const bytes = await readFile(path).catch(() => {
        throw new Error(`${path} does not exist; pass its content`);
      });
      if (!bytes.length) throw new Error(`${name} is empty; pass its content`);
      this.attempted = true;
      await page.cdp('DOM.setFileInputFiles', { backendNodeId: node.id, files: [path] });
      const size = () =>
        this.onNode<number>(page, node.id, `function(){return this.files?.[0]?.size ?? -1;}`);
      if ((await size()) < 0)
        throw new Error(`#${node.id} is not a file input; pass the file input's id`);
      // A remote browser cannot read the local path and attaches a 0-byte file: build the file in the page.
      if ((await size()) === 0)
        await this.onNode(
          page,
          node.id,
          `function({name, b64}){const t=new DataTransfer();t.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],name));this.files=t.files;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}`,
          { name, b64: bytes.toString('base64') },
        );
      if ((await size()) !== bytes.length)
        throw new Error(`the file input holds ${await size()} bytes instead of ${bytes.length}`);
      return { id: node.id, detail: `${node.role} "${clip(node.name, 40)}" = ${name}` };
    });
  }

  async hover(target: Target) {
    return this.act('hover', target, async () => {
      const { page, node } = await this.resolve('click', target);
      const p = await this.point(page, node.id);
      this.attempted = true;
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      return { id: node.id, detail: `${node.role} "${clip(node.name, 50)}"` };
    });
  }

  /** Press on `from`, move in steps and release on `to` (a target) or at an offset; HTML5 draggables use Chrome's drag interception. */
  async drag(from: Target, to: Target | { dx: number; dy: number }) {
    return this.act('drag', from, async () => {
      const { page, node } = await this.resolve('click', from);
      const a = await this.point(page, node.id);
      const b =
        typeof to === 'object' && 'dx' in to
          ? { x: a.x + to.dx, y: a.y + to.dy }
          : await this.point(page, (await this.resolve('click', to)).node.id);
      const html5 = await this.onNode<boolean>(
        page,
        node.id,
        `function(){return !!(this.nodeType===1?this:this.parentElement).closest('[draggable=true]');}`,
      );
      this.attempted = true;
      const move = (
        x: number,
        y: number,
        type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' = 'mouseMoved',
      ) =>
        page.cdp('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
        });
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      if (html5) await page.cdp('Input.setInterceptDrags', { enabled: true });
      let pressed = false;
      try {
        const intercepted = html5
          ? this.browser().waitFor('Input.dragIntercepted', {
              sessionId: page.sessionId,
              timeoutMs: 3000,
            })
          : undefined;
        await move(a.x, a.y, 'mousePressed');
        pressed = true;
        for (let i = 1; i <= 10; i++)
          await move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
        if (intercepted) {
          const { data } = await intercepted;
          for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
            await page.cdp('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data });
        }
      } finally {
        if (pressed) await move(b.x, b.y, 'mouseReleased').catch(() => {});
        if (html5) await page.cdp('Input.setInterceptDrags', { enabled: false }).catch(() => {});
      }
      return {
        id: node.id,
        detail: `(${Math.round(a.x)},${Math.round(a.y)}) -> (${Math.round(b.x)},${Math.round(b.y)})${html5 ? ' html5' : ''}`,
      };
    });
  }

  async fill(target: Target, text: string, options: { enter?: boolean; pick?: string } = {}) {
    if (typeof text !== 'string') throw new Error('fill needs an exact string.');
    return this.act('fill', target, async () => {
      const { page, node } = await this.resolve('fill', target);
      const p = await this.point(page, node.id, true);
      this.attempted = true;
      let typedInto = node.id;
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
        // Comboboxes often move focus to their own overlay input on click; type there, not into the hidden original.
        const moved = await this.onNode<boolean>(
          page,
          node.id,
          `function(){const e=this.nodeType===1?this:this.parentElement;let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return !!a&&a!==e&&!e.contains(a)&&(['INPUT','TEXTAREA'].includes(a.tagName)||a.isContentEditable);}`,
        ).catch(() => false);
        if (moved) typedInto = 0;
        else await page.cdp('DOM.focus', { backendNodeId: node.id }).catch(() => {});
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
      const actual = await (
        typedInto
          ? this.onNode<string>(
              page,
              node.id,
              `function(){const e=this.nodeType===1?this:this.parentElement;return e.isContentEditable?e.innerText:(e.value??'');}`,
            )
          : page.evaluate(() => {
              let a = document.activeElement as HTMLInputElement | null;
              while (a?.shadowRoot?.activeElement)
                a = a.shadowRoot.activeElement as HTMLInputElement;
              return a ? (a.isContentEditable ? a.innerText : (a.value ?? '')) : '';
            })
      ).catch(() => undefined);
      const picked = options.pick ? await this.pickOption(page, options.pick, text) : undefined;
      if (options.enter && !picked) await this.key(page, 'Enter');
      const mismatch = actual !== undefined && actual !== text && !options.enter;
      return {
        id: node.id,
        detail: `${node.role} "${clip(node.name, 40)}"${typedInto ? '' : ' (focused overlay input)'} = ${JSON.stringify(clip(text, 60))}${mismatch ? ` (field now shows ${JSON.stringify(clip(actual ?? '', 60))}: autocomplete/format?)` : ''}${picked ? ` -> picked ${picked}` : options.enter ? ' +Enter' : ''}`,
      };
    });
  }

  /** After typing into an autocomplete, click the suggestion with this exact name or unique name prefix. */
  private async pickOption(page: Page, want: string, typed?: string) {
    const deadline = Date.now() + 4000;
    for (;;) {
      const options = (await this.nodes(page)).nodes.filter(
        (n) => SUGGESTIONS.has(n.role) && n.name,
      );
      let hit = options.filter((n) => norm(n.name) === norm(want));
      if (!hit.length) hit = options.filter((n) => norm(n.name).startsWith(norm(want)));
      if (hit.length > 1)
        throw new Error(
          `AMBIGUOUS pick "${want}":\n${hit.slice(0, 8).map(brief).join('\n')}\nPass a longer name.`,
        );
      if (hit.length === 1) {
        const q = await this.point(page, hit[0]!.id);
        await page.clickAt(q.x, q.y);
        return brief(hit[0]!);
      }
      if (Date.now() > deadline)
        throw new Error(
          `PICK_NOT_FOUND: ${typed === undefined ? 'opened it' : `typed ${JSON.stringify(typed)}`} but no option named "${want}". Options: ${
            options
              .filter((n) => n.role === 'option')
              .slice(0, 8)
              .map(brief)
              .join('; ') || 'none'
          }`,
        );
      await delay(150);
    }
  }

  async select(target: Target, option: string) {
    return this.act('select', target, async () => {
      const { page, node } = await this.resolve('select', target);
      const native = await this.onNode<boolean>(
        page,
        node.id,
        `function(){return this.tagName==='SELECT';}`,
      );
      if (!native) {
        // Custom dropdowns (role=combobox/listbox): open it with a real click, then click the option by name.
        const p = await this.point(page, node.id);
        this.attempted = true;
        await page.clickAt(p.x, p.y);
        const picked = await this.pickOption(page, option);
        return { id: node.id, detail: `"${clip(node.name, 40)}" -> picked ${picked}` };
      }
      const result = await this.onNode<string>(
        page,
        node.id,
        `function(label){
          const norm = s => String(s).trim().replace(/\\s+/g,' ').toLowerCase();
          const opts = [...this.options].filter(o => !o.disabled);
          const hits = opts.filter(o => norm(o.label) === norm(label) || norm(o.value) === norm(label));
          if (hits.length !== 1) throw Error((hits.length ? 'AMBIGUOUS' : 'NOT_FOUND') + ': option ' + JSON.stringify(label) + '. Options: ' + JSON.stringify(opts.slice(0,40).map(o=>o.label)));
          this.value = hits[0].value; this.selectedIndex = hits[0].index;
          this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
          return hits[0].label;
        }`,
        option,
      );
      this.attempted = true;
      return { id: node.id, detail: `"${clip(node.name, 40)}" = ${JSON.stringify(result)}` };
    });
  }

  async check(target: Target, on = true) {
    return this.act('check', target, async () => {
      const { page, node } = await this.resolve('check', target);
      if (node.checked === on) return { id: node.id, detail: `already ${on}` };
      const p = await this.point(page, node.id);
      this.attempted = true;
      await page.clickAt(p.x, p.y);
      return { id: node.id, detail: `-> ${on}` };
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
    const deadline = Date.now() + (options.timeoutMs ?? 8000);
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
    this.log(`[waitForText] "${text}" not visible after ${options.timeoutMs ?? 8000}ms`);
    return false;
  }

  private async tree(page = this.page()) {
    const { nodes } = (await page.cdp('Accessibility.getFullAXTree')) as unknown as {
      nodes: RawAX[];
    };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    return { nodes, byId, info: await page.info() };
  }

  private static prop(n: RawAX, name: string) {
    return n.properties?.find((p) => p.name === name)?.value?.value;
  }

  /** Text of a subtree without duplicating InlineTextBox fragments. */
  private static text(byId: Map<string, RawAX>, root: RawAX, limit = 4000) {
    const out: string[] = [];
    let size = 0;
    const walk = (n: RawAX | undefined) => {
      if (!n || size > limit) return;
      const role = String(n.role?.value ?? '');
      if (role === 'StaticText' && !n.ignored) {
        const t = String(n.name?.value ?? '').trim();
        if (t) (out.push(t), (size += t.length));
        return;
      }
      for (const c of n.childIds ?? []) walk(byId.get(c));
    };
    walk(root);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  private summarize(kind: string, rows: unknown[], extra = '') {
    const first = rows[0];
    const fields = first && typeof first === 'object' ? Object.keys(first as object) : [];
    this.log(
      `[${kind}${this.at()}] ${rows.length} row(s)${fields.length ? `; fields: ${fields.join(', ')}` : ''}${extra}\n${rows
        .slice(0, 3)
        .map((r) => clip(JSON.stringify(r), 300))
        .join('\n')}`,
    );
  }

  private pick(
    nodes: RawAX[],
    roles: Set<string>,
    which: number | string | undefined,
    byId: Map<string, RawAX>,
  ) {
    const all = nodes.filter((n) => !n.ignored && roles.has(String(n.role?.value ?? '')));
    if (typeof which === 'number') return all[which];
    if (typeof which === 'string') {
      const hit = all.filter((n) => norm(n.name?.value) === norm(which));
      if (hit.length === 1) return hit[0];
      throw new Error(
        `${hit.length ? 'AMBIGUOUS' : 'NOT_FOUND'}: ${[...roles].join('/')} named "${which}". Available: ${JSON.stringify(all.slice(0, 15).map((n, i) => `${i}: ${String(n.name?.value ?? '') || AxHelpers.text(byId, n, 60)}`))}`,
      );
    }
    return all;
  }

  /** Readable text lines of the page or of one region (landmark/dialog/form/article/section name or role). */
  async read(region?: string, options: { max?: number } = {}) {
    this.dirty = false;
    const { nodes, byId, info } = await this.tree();
    let root = nodes[0];
    if (region) {
      const regionRoles = new Set([
        'main',
        'navigation',
        'region',
        'dialog',
        'alertdialog',
        'form',
        'article',
        'complementary',
        'banner',
        'contentinfo',
        'search',
        'section',
        'table',
        'list',
        'group',
        'tabpanel',
      ]);
      const candidates = nodes.filter(
        (n) => !n.ignored && regionRoles.has(String(n.role?.value ?? '')),
      );
      const hit = candidates.filter((n) => norm(n.name?.value) === norm(region));
      const byRole = candidates.filter((n) => String(n.role?.value) === region);
      root = hit.length === 1 ? hit[0] : byRole.length >= 1 && !hit.length ? byRole[0] : undefined!;
      if (!root)
        throw new Error(
          `${hit.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND'} region "${region}". Named regions: ${JSON.stringify(
            candidates
              .filter((n) => n.name?.value)
              .slice(0, 20)
              .map((n) => `${n.role?.value}: ${n.name?.value}`),
          )}`,
        );
    } else {
      root = nodes.find((n) => String(n.role?.value) === 'main' && !n.ignored) ?? nodes[0];
    }
    const lines: string[] = [];
    const max = options.max ?? 400;
    const walk = (n: RawAX | undefined) => {
      if (!n || lines.length >= max) return;
      const role = String(n.role?.value ?? '');
      const name = String(n.name?.value ?? '').trim();
      if (!n.ignored) {
        if (role === 'heading')
          return void lines.push(`## ${name || AxHelpers.text(byId, n, 200)}`);
        if (role === 'link') {
          const url = AxHelpers.prop(n, 'url');
          return void lines.push(`[${name || AxHelpers.text(byId, n, 200)}](${url ?? ''})`);
        }
        if (['button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio'].includes(role))
          return void lines.push(
            `<${role}${name ? ` "${name}"` : ''}${n.value?.value !== undefined ? ` = ${n.value.value}` : ''}>`,
          );
        if (
          [
            'paragraph',
            'listitem',
            'row',
            'cell',
            'gridcell',
            'term',
            'definition',
            'caption',
            'blockquote',
            'figcaption',
          ].includes(role) &&
          !(n.childIds ?? []).some((c) =>
            ['link', 'heading', 'list', 'button', 'table'].includes(
              String(byId.get(c)?.role?.value),
            ),
          )
        ) {
          const t = AxHelpers.text(byId, n, 600);
          if (t) lines.push(role === 'listitem' ? `- ${t}` : t);
          return;
        }
        if (role === 'StaticText' && name) return void lines.push(name);
      }
      for (const c of n.childIds ?? []) walk(byId.get(c));
    };
    walk(root);
    const merged = lines.filter((l, i) => l !== lines[i - 1]);
    const shown = 25;
    this.log(
      `[read${region ? ` ${region}` : ''}${this.at()}] ${merged.length} line(s) | ${info.url}\n${clip(merged.slice(0, shown).join('\n'), shown * 100)}${merged.length > shown ? `\n… ${merged.length - shown} more lines in the returned array` : ''}`,
    );
    return merged;
  }

  /** Table/grid rows as objects keyed by column headers (arrays when no headers). */
  async table(which?: number | string) {
    this.dirty = false;
    const { nodes, byId } = await this.tree();
    const found = this.pick(nodes, new Set(['table', 'grid', 'treegrid']), which, byId);
    const tables = Array.isArray(found) ? found : found ? [found] : [];
    if (!tables.length) {
      this.log('[table] no table/grid on this page; use bu.list(), bu.read() or page.evaluate');
      return [];
    }
    if (Array.isArray(found) && found.length > 1)
      this.log(
        `[table] ${found.length} tables; using the largest. Pass an index or name to choose.`,
      );
    const rowsOf = (t: RawAX) => {
      const rows: RawAX[] = [];
      const walk = (n: RawAX | undefined) => {
        if (!n) return;
        if (String(n.role?.value) === 'row') return void rows.push(n);
        for (const c of n.childIds ?? []) walk(byId.get(c));
      };
      walk(t);
      return rows;
    };
    const table = tables
      .map((t) => ({ t, rows: rowsOf(t) }))
      .sort((a, b) => b.rows.length - a.rows.length)[0]!;
    const cells = (row: RawAX) => {
      const out: { header: boolean; text: string }[] = [];
      const walk = (n: RawAX | undefined) => {
        if (!n) return;
        const role = String(n.role?.value ?? '');
        if (['cell', 'gridcell', 'columnheader', 'rowheader'].includes(role))
          return void out.push({
            header: role === 'columnheader',
            text: String(n.name?.value ?? '').trim() || AxHelpers.text(byId, n, 500),
          });
        for (const c of n.childIds ?? []) walk(byId.get(c));
      };
      walk(row);
      return out;
    };
    const matrix = table.rows.map(cells).filter((r) => r.length);
    const headerRow = matrix.findIndex((r) => r.length && r.every((c) => c.header));
    let rows: unknown[];
    if (headerRow >= 0) {
      const headers = matrix[headerRow]!.map((c, i) => c.text || `col${i + 1}`);
      rows = matrix
        .slice(headerRow + 1)
        .map((r) => Object.fromEntries(r.map((c, i) => [headers[i] ?? `col${i + 1}`, c.text])));
    } else rows = matrix.map((r) => r.map((c) => c.text));
    this.summarize('table', rows);
    return rows;
  }

  /** List items with their text and links. Default: the list with the most items. */
  async list(which?: number | string) {
    this.dirty = false;
    const { nodes, byId } = await this.tree();
    const found = this.pick(nodes, new Set(['list', 'feed', 'listbox', 'tree']), which, byId);
    const lists = Array.isArray(found) ? found : found ? [found] : [];
    const itemsOf = (l: RawAX) =>
      (l.childIds ?? [])
        .map((c) => byId.get(c))
        .filter(
          (n): n is RawAX =>
            !!n && ['listitem', 'article', 'option', 'treeitem'].includes(String(n.role?.value)),
        );
    const best = lists
      .map((l) => ({ l, items: itemsOf(l) }))
      .sort((a, b) => b.items.length - a.items.length)[0];
    if (!best?.items.length) {
      this.log('[list] no list items found; use bu.read() or page.evaluate');
      return [];
    }
    const rows = best.items.map((item) => {
      const links: { name: string; url: string }[] = [];
      const walk = (n: RawAX | undefined) => {
        if (!n) return;
        if (String(n.role?.value) === 'link') {
          const url = AxHelpers.prop(n, 'url');
          if (url) links.push({ name: String(n.name?.value ?? '').trim(), url: String(url) });
        }
        for (const c of n.childIds ?? []) walk(byId.get(c));
      };
      walk(item);
      return { text: AxHelpers.text(byId, item, 800), links: links.slice(0, 5) };
    });
    this.summarize(
      'list',
      rows,
      lists.length > 1 && typeof which === 'undefined' ? ` (largest of ${lists.length} lists)` : '',
    );
    return rows;
  }

  /** All links on the page, optionally filtered by name/url substring. */
  async links(filter?: string) {
    this.dirty = false;
    const { nodes } = await this.tree();
    const f = filter ? norm(filter) : '';
    const seen = new Set<string>();
    const rows = nodes
      .filter((n) => !n.ignored && String(n.role?.value) === 'link')
      .map((n) => ({
        name: String(n.name?.value ?? '').trim(),
        url: String(AxHelpers.prop(n, 'url') ?? ''),
      }))
      .filter((l) => l.url && (!f || norm(l.name).includes(f) || l.url.toLowerCase().includes(f)))
      .filter((l) => (seen.has(l.url + l.name) ? false : (seen.add(l.url + l.name), true)));
    this.summarize('links', rows);
    return rows;
  }

  /**
   * Visit many URLs in parallel. mode 'tab' (default) runs extract in each page; mode 'fetch' runs
   * extract(text, {url,status}) in Node on the raw HTTP body. Per-host politeness and 429/503 backoff
   * happen here. Item failures never throw; partial results are saved to the workspace as they arrive.
   */
  async map<T>(
    urls: string[],
    extract?: ((...args: never[]) => T) | string,
    options: {
      concurrency?: number;
      perHost?: number;
      minGapMs?: number;
      mode?: 'tab' | 'fetch';
      retries?: number;
      timeoutMs?: number;
    } = {},
  ) {
    const { results, failed, file } = await this.crawl(urls, extract, options, (l) => this.log(l));
    this.summarize(
      'map',
      results.filter((r) => r.ok).map((r) => r.value),
      `; ${failed.length} failed${failed.length ? ` e.g. ${clip(JSON.stringify(failed.slice(0, 2)), 300)}` : ''}; saved ${file}`,
    );
    return results;
  }

  private async crawl(
    urls: string[],
    extract: unknown,
    options: {
      concurrency?: number;
      perHost?: number;
      minGapMs?: number;
      mode?: 'tab' | 'fetch';
      retries?: number;
      timeoutMs?: number;
    },
    say: (line: string) => void,
  ) {
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string'))
      throw new Error('map needs an array of URL strings.');
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 12));
    const perHost = Math.max(1, options.perHost ?? 2);
    const minGap = options.minGapMs ?? 250;
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? 25000;
    const mode = options.mode ?? 'tab';
    // Scratch under the host journal dir so partial results never masquerade as deliverables.
    const file = join(this.workspace, '.browser-use', `bu-map-${++this.mapCount}.json`);
    await mkdir(join(this.workspace, '.browser-use'), { recursive: true }).catch(() => {});
    const results: {
      url: string;
      ok: boolean;
      status?: number;
      value?: unknown;
      error?: string;
      observedAt?: string;
    }[] = new Array(urls.length);
    const active = new Map<string, number>();
    const lastStart = new Map<string, number>();
    const started = Date.now();
    let next = 0;
    let done = 0;
    const host = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return '';
      }
    };
    const one = async (url: string) => {
      const h = host(url);
      for (let attempt = 0; ; attempt++) {
        while ((active.get(h) ?? 0) >= perHost || Date.now() - (lastStart.get(h) ?? 0) < minGap)
          await delay(25);
        active.set(h, (active.get(h) ?? 0) + 1);
        lastStart.set(h, Date.now());
        try {
          const r =
            mode === 'fetch'
              ? await this.fetchOne(url, extract, timeoutMs)
              : await this.tabOne(url, extract, timeoutMs);
          if ((r.status === 429 || r.status === 503) && attempt < retries) {
            const wait = Math.min(30000, (r.retryAfter ?? 2 ** attempt * 2) * 1000);
            say(
              `[map] ${h} http ${r.status}; backing off ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${retries})`,
            );
            await delay(wait);
            continue;
          }
          return {
            url,
            ok: r.status === 0 || (r.status >= 200 && r.status < 400),
            status: r.status,
            value: r.value,
            observedAt: new Date().toISOString(),
          };
        } catch (error) {
          if (attempt < retries && /timeout|net::ERR|ECONNRESET|fetch failed/i.test(String(error)))
            continue;
          return {
            url,
            ok: false,
            error: clip(error instanceof Error ? error.message : String(error), 300),
          };
        } finally {
          active.set(h, (active.get(h) ?? 1) - 1);
        }
      }
    };
    const flush = () =>
      writeFile(file, JSON.stringify(results.filter(Boolean), null, 1)).catch(() => {});
    const step = Math.max(1, Math.ceil(urls.length / 10));
    await Promise.all(
      Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
        while (next < urls.length) {
          const i = next++;
          results[i] = await one(urls[i]!);
          done++;
          if (done % step === 0 || done === urls.length) {
            const ok = results.filter((r) => r?.ok).length;
            say(
              `[map] ${done}/${urls.length} done, ${ok} ok, ${done - ok} failed, ${((Date.now() - started) / 1000).toFixed(1)}s`,
            );
            await flush();
          }
        }
      }),
    );
    await flush();
    return { results, failed: results.filter((r) => !r.ok), file };
  }

  private async fetchOne(url: string, extract: unknown, timeoutMs: number) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    const retryAfter = Number(response.headers.get('retry-after')) || undefined;
    const text = await response.text();
    const value =
      typeof extract === 'function'
        ? await (extract as (t: string, m: object) => unknown)(text, {
            url,
            status: response.status,
          })
        : text.slice(0, 20000);
    return { status: response.status, value, retryAfter };
  }

  private async tabOne(url: string, extract: unknown, timeoutMs: number) {
    const page = await this.tabs().open();
    let timer: NodeJS.Timeout | undefined;
    try {
      const nav = await Promise.race([
        page.cdp('Page.navigate', { url }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if ((nav as { errorText?: string }).errorText)
        throw new Error(`Navigation failed: ${(nav as { errorText?: string }).errorText}`);
      const status = await this.status(page);
      await this.settle({ capMs: 1500, page });
      let value: unknown;
      if (typeof extract === 'function' || typeof extract === 'string')
        value = await page.evaluate(extract as string);
      else
        value = await page.evaluate(() => ({
          title: document.title,
          text: (document.body?.innerText ?? '').slice(0, 4000),
        }));
      return { status, value, retryAfter: undefined as number | undefined };
    } finally {
      clearTimeout(timer);
      await page.close().catch(() => {});
    }
  }

  /** Start long work in the background; bu.wait(job) blocks for it with streamed progress. */
  job<T>(name: string, fn: (progress: (line: string) => void) => Promise<T>) {
    const id = `${name}-${this.jobs.size + 1}`;
    const job = {
      name,
      log: [] as string[],
      seen: 0,
      done: false,
      started: Date.now(),
      promise: undefined as unknown as Promise<unknown>,
      value: undefined as unknown,
      error: undefined as string | undefined,
    };
    job.promise = fn((line) =>
      job.log.push(`${((Date.now() - job.started) / 1000).toFixed(0)}s ${line}`),
    )
      .then((v) => ((job.value = v), v))
      .catch((e) => ((job.error = e instanceof Error ? e.message : String(e)), undefined))
      .finally(() => (job.done = true));
    this.jobs.set(id, job);
    this.log(`[job ${id}] started; await bu.wait('${id}') to block until it finishes`);
    return id;
  }

  async wait(id: string, options: { timeoutMs?: number } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job ${id}. Jobs: ${[...this.jobs.keys()].join(', ')}`);
    const timeout = options.timeoutMs ?? 150000;
    await Promise.race([job.promise, delay(timeout)]);
    const fresh = job.log.slice(job.seen);
    job.seen = job.log.length;
    this.log(
      `[job ${id}] ${job.done ? (job.error ? `failed: ${job.error}` : 'done') : `still running after ${((Date.now() - job.started) / 1000).toFixed(0)}s; call bu.wait again`}${fresh.length ? `\n${fresh.slice(-15).join('\n')}` : ''}`,
    );
    return job.done ? { done: true, value: job.value, error: job.error } : { done: false };
  }
}
