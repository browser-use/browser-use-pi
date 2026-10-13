import type { Protocol } from 'devtools-protocol';
import type { CDP } from './cdp.js';

type AX = Protocol.Accessibility.AXNode;
/** What a printed number points at: the node, the CDP session of its frame, and the page it was printed on. */
export type Target = { node: number; session: string; doc: string };
type Frame = {
  session: string;
  /** Key of the iframe element this frame's tree hangs under, '' for the main frame. */
  owner: string;
  nodes: AX[];
  ids: Map<number, string>;
};
type Item = {
  key: string;
  node: number | undefined;
  session: string;
  line: string;
  kids: Item[];
  focused: boolean;
};

/** Chrome role -> the word printed; unlisted roles are containers. '' prints no word (list options). */
const WORDS: Record<string, string> = {
  RootWebArea: 'AXWebArea',
  button: 'button',
  link: 'link',
  textbox: 'text field',
  searchbox: 'search text field',
  combobox: 'combo box',
  checkbox: 'checkbox',
  switch: 'checkbox',
  radio: 'radio button',
  radiogroup: 'radio group',
  slider: 'slider',
  spinbutton: 'stepper',
  tab: 'tab',
  tablist: 'tab group',
  heading: 'heading',
  image: 'image',
  img: 'image',
  StaticText: 'text',
  list: 'content list',
  listbox: 'list',
  ListMarker: 'AXListMarker',
  option: '',
  menuitem: '',
  menuitemcheckbox: '',
  menuitemradio: '',
  menu: 'menu',
  menubar: 'menu bar',
  table: 'table',
  grid: 'table',
  treegrid: 'table',
  row: 'row',
  cell: 'cell',
  gridcell: 'cell',
  columnheader: 'cell',
  rowheader: 'cell',
  toolbar: 'toolbar',
  progressbar: 'progress indicator',
  meter: 'level indicator',
  separator: 'splitter',
  scrollbar: 'scroll bar',
  tree: 'outline',
  treeitem: 'outline row',
  DisclosureTriangle: 'button',
  Date: 'date field',
  DateTime: 'date field',
  InputTime: 'time field',
};
/** Their children are the browser's own editor parts. */
const FIELDS = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
  'Date',
  'DateTime',
  'InputTime',
]);
/** Their text children only repeat the control's name. */
const ATOMIC = new Set(
  'button link checkbox switch radio tab option menuitem menuitemcheckbox menuitemradio treeitem DisclosureTriangle'.split(
    ' ',
  ),
);
const CHECKABLE = new Set(['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio']);
const DIFF_HEAD =
  'Changes since the last look: ~ changed, + added, unchanged lines left out. Removed ids are listed as ranges.';

const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const prop = (n: AX, name: string) => n.properties?.find((p) => p.name === name)?.value.value;
const ranges = (ns: number[]) =>
  ns
    .sort((a, b) => a - b)
    .reduce<number[][]>((out, n) => {
      const last = out.at(-1);
      if (last && n === last[1]! + 1) last[1] = n;
      else out.push([n, n]);
      return out;
    }, [])
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ');

/**
 * Every frame's full AX tree and DOM ids. Same-process frames come from the page session, out-of-process
 * frames from their own target. Child frames share 1 s, at most 500 ms each; one that fails is named, not fatal.
 */
export async function captureFrames(
  cdp: CDP,
  session: string,
  attached = new Map<string, string>(),
) {
  const deadline = Date.now() + 1000;
  const timed = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, no) =>
        setTimeout(
          () => no(new Error('timed out')),
          Math.max(1, Math.min(500, deadline - Date.now())),
        ),
      ),
    ]);
  const ids = async (s: string) => {
    const { documents, strings } = await cdp.send(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
      s,
    );
    const out = new Map<number, string>();
    for (const d of documents)
      d.nodes.attributes?.forEach((a, i) => {
        for (let k = 0; k < a.length; k += 2)
          if (strings[a[k]!] === 'id') out.set(d.nodes.backendNodeId![i]!, strings[a[k + 1]!]!);
      });
    return out;
  };
  const { frameTree } = await cdp.send('Page.getFrameTree', undefined, session);
  const [{ nodes }, mainIds] = await Promise.all([
    cdp.send('Accessibility.getFullAXTree', undefined, session),
    ids(session).catch(() => new Map<number, string>()),
  ]);
  const frames: Frame[] = [{ session, owner: '', nodes, ids: mainIds }];
  const failed: string[] = [];
  // A tree's child frames in the same process: their owners and AX trees through the same session.
  const children = async (
    tree: Protocol.Page.FrameTree,
    s: string,
    domIds: Map<number, string>,
  ) => {
    for (const child of tree.childFrames ?? []) {
      try {
        const [{ backendNodeId }, r] = await timed(
          Promise.all([
            cdp.send('DOM.getFrameOwner', { frameId: child.frame.id }, s),
            cdp.send('Accessibility.getFullAXTree', { frameId: child.frame.id }, s),
          ]),
        );
        frames.push({ session: s, owner: `${s}:${backendNodeId}`, nodes: r.nodes, ids: domIds });
        await children(child, s, domIds);
      } catch (error) {
        failed.push(
          `${child.frame.url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  await children(frameTree, session, mainIds);
  // Out-of-process frames: iframe targets whose parent frame is one we have, in the order they attach.
  const known = new Map<string, string>(); // frame id -> session
  const remember = (tree: Protocol.Page.FrameTree, s: string) => {
    known.set(tree.frame.id, s);
    tree.childFrames?.forEach((c) => remember(c, s));
  };
  remember(frameTree, session);
  const remote = (await cdp.send('Target.getTargets')).targetInfos.filter(
    (t) => t.type === 'iframe',
  );
  for (let progress = true; progress;) {
    progress = false;
    for (const t of remote) {
      const parent = known.get(t.parentFrameId ?? '');
      if (!parent || known.has(t.targetId)) continue;
      known.set(t.targetId, '');
      progress = true;
      try {
        const own = await timed(
          (async () => {
            // One session per frame target for the whole run: attached keeps it between looks.
            let s = attached.get(t.targetId);
            if (!s || !cdp.targetForSession(s)) {
              s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }))
                .sessionId;
              attached.set(t.targetId, s);
            }
            const [{ backendNodeId }, r, tree, domIds] = await Promise.all([
              cdp.send('DOM.getFrameOwner', { frameId: t.targetId }, parent),
              cdp.send('Accessibility.getFullAXTree', undefined, s),
              cdp.send('Page.getFrameTree', undefined, s),
              ids(s).catch(() => new Map<number, string>()),
            ]);
            frames.push({
              session: s,
              owner: `${parent}:${backendNodeId}`,
              nodes: r.nodes,
              ids: domIds,
            });
            return { s: s!, tree: tree.frameTree, domIds };
          })(),
        );
        remember(own.tree, own.s);
        await children(own.tree, own.s, own.domIds);
      } catch (error) {
        failed.push(`${t.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { doc: `${frameTree.frame.id}:${frameTree.frame.loaderId}`, frames, failed };
}

/** The page as one numbered tree, a tab per depth. Numbers stay with their element while the page is the same. */
export class AxTree {
  /** Number -> element of the last print. */
  targets = new Map<number, Target>();
  /** Element key -> number, and number -> printed line, of the last print. */
  private numbers = new Map<string, number>();
  private lines = new Map<number, string>();
  /** Frame target -> the session this run attached to it. */
  attached = new Map<string, string>();
  /** Out-of-process frame session -> its iframe element in the parent: clicks add that element's offset. */
  owners = new Map<string, { session: string; node: number }>();
  private doc = '';
  private next = 0;

  /** The line of number n in the last print, without its indent. */
  line(n: number) {
    return this.lines.get(n)?.trim();
  }

  /** Numbers an element the tree leaves out (a hidden file input) and returns its line. */
  add(node: number, session: string, line: string) {
    const key = `${session}:${node}`;
    const n = this.numbers.get(key) ?? this.next++;
    this.numbers.set(key, n);
    this.lines.set(n, `${n} ${line}`);
    this.targets.set(n, { node, session, doc: this.doc });
    return `${n} ${line}`;
  }

  render(capture: Awaited<ReturnType<typeof captureFrames>>, full = false) {
    const { doc, frames, failed } = capture;
    if (doc !== this.doc) {
      this.doc = doc;
      this.numbers = new Map();
      this.lines = new Map();
      this.next = 0;
    }
    const byOwner = new Map(frames.map((f) => [f.owner, f]));
    for (const f of frames) {
      const [session, node] = f.owner.split(/:(?=\d+$)/);
      if (f.owner && session !== f.session)
        this.owners.set(f.session, { session: session!, node: Number(node) });
    }
    let urls = 0; // URL characters printed so far: past 4,000 a link's value is …
    const build = (n: AX | undefined, f: Frame, byId: Map<string, AX>): Item[] => {
      if (!n) return [];
      const role = String(n.role?.value ?? '');
      const own = `${f.session}:${n.backendDOMNodeId ?? `ax${n.nodeId}`}`;
      const sub = byOwner.get(own); // an iframe element: its document hangs below it
      const kids = () => [
        ...(n.childIds ?? []).flatMap((c) => build(byId.get(c), f, byId)),
        ...(sub ? build(sub.nodes[0], sub, new Map(sub.nodes.map((x) => [x.nodeId, x]))) : []),
      ];
      if (n.ignored || role === 'none' || role === 'presentation') return kids();
      if (role === 'InlineTextBox' || role === 'LineBreak') return [];
      const name = norm(n.name?.value);
      if (role === 'StaticText')
        return name
          ? [
              {
                key: own,
                node: n.backendDOMNodeId,
                session: f.session,
                line: `text ${name}`,
                kids: [],
                focused: false,
              },
            ]
          : [];
      const domId = n.backendDOMNodeId ? f.ids.get(n.backendDOMNodeId) : undefined;
      const id = domId && !/^(_|NS)/.test(domId) && role !== 'RootWebArea' ? domId : '';
      const word = WORDS[role] ?? 'container';
      // A nameless container is named by its DOM id.
      const title = word === 'container' && !name && id ? id : name;
      let children = kids();
      const focusable = prop(n, 'focusable') || prop(n, 'editable');
      if (word === 'container' && !name && !focusable && !sub) {
        if (children.length < 2 && !id) return children; // an empty wrapper goes, a single child moves up
        if (!children.length) return [];
      }
      // A native select's options and a control's own text only repeat what its line says.
      const popup = n.childIds?.some((c) => byId.get(c)?.role?.value === 'MenuListPopup');
      if (
        popup ||
        FIELDS.has(role) ||
        (ATOMIC.has(role) &&
          children.every(
            (c) => c.line.startsWith('text ') && !c.kids.length && name.includes(c.line.slice(5)),
          ))
      )
        children = [];
      const expanded = prop(n, 'expanded');
      const settable = prop(n, 'settable') && !CHECKABLE.has(role);
      const states = [
        prop(n, 'selected') && 'selected',
        prop(n, 'disabled') && 'disabled',
        expanded === true && 'expanded',
        expanded === false && 'collapsed',
        settable && 'settable',
      ].filter(Boolean);
      const checked = prop(n, 'checked') ?? prop(n, 'pressed');
      let value: unknown = n.value?.value;
      if (role === 'link') {
        const url = String(prop(n, 'url') ?? '').replace(/^https?:\/\/(www\.)?/, '');
        value = url && (urls += url.length) > 4000 ? '…' : url;
      } else if (role === 'heading') value = prop(n, 'level');
      else if (checked !== undefined)
        value = checked === 'mixed' ? 'mixed' : checked === true || checked === 'true' ? 1 : 0;
      value = norm(value);
      const description = norm(n.description?.value);
      const labels = [
        description && description !== name && `Description: ${description}`,
        role === 'RootWebArea' &&
          `URL: ${String(prop(n, 'url') ?? '').replace(/^https?:\/\/(www\.)?/, '')}`,
        value !== '' && value !== name && `Value: ${value}`,
        id && title !== id && `ID: ${id}`,
        expanded !== undefined && `Secondary Actions: ${expanded ? 'Collapse' : 'Expand'}`,
      ].filter(Boolean);
      const shown = popup ? 'pop up button' : role === 'button' && value ? 'file input' : word;
      const head = [shown, states.length ? `(${states.join(', ')})` : '', title]
        .filter(Boolean)
        .join(' ');
      const line = labels.length ? `${head}${title ? ',' : ''} ${labels.join(', ')}` : head;
      return [
        {
          key: own,
          node: n.backendDOMNodeId,
          session: f.session,
          line,
          kids: children,
          focused: !!prop(n, 'focused'),
        },
      ];
    };
    const main = frames[0]!;
    const items = build(main.nodes[0], main, new Map(main.nodes.map((x) => [x.nodeId, x])));
    // Number in page order: an element printed last time keeps its number, a new one gets the next free.
    const numbers = new Map<string, number>();
    const lines = new Map<number, string>();
    const order: number[] = [];
    let focused = '';
    this.targets = new Map();
    const number = (it: Item, depth: number) => {
      const n = this.numbers.get(it.key) ?? this.next++;
      numbers.set(it.key, n);
      lines.set(n, `${'\t'.repeat(depth)}${n} ${it.line}`);
      order.push(n);
      if (it.node) this.targets.set(n, { node: it.node, session: it.session, doc });
      if (it.focused) focused = `${n} ${it.line}`;
      it.kids.forEach((k) => number(k, depth + 1));
    };
    items.forEach((it) => number(it, 0));
    const trailer = `${failed.map((f) => `Frame unavailable: ${f}`).join('\n')}${failed.length ? '\n' : ''}The focused element is ${focused || lines.get(order[0]!)?.trim() || 'none'}`;
    const whole = order.map((n) => lines.get(n)).join('\n');
    const previous = this.lines;
    this.numbers = numbers;
    this.lines = lines;
    if (full || !previous.size) return `${whole}\n${trailer}`;
    const changed = order.filter((n) => previous.get(n) !== lines.get(n));
    const removed = [...previous.keys()].filter((n) => !lines.has(n));
    if (!changed.length && !removed.length) return `No change since the last look.\n${trailer}`;
    const diff = [
      DIFF_HEAD,
      ...(removed.length ? [`Removed ids: ${ranges(removed)}`] : []),
      ...changed.map((n) => `${previous.has(n) ? '~' : '+'}${lines.get(n)}`),
    ].join('\n');
    // A diff only when it saves at least 1,000 characters and 30% of the whole print.
    return whole.length - diff.length >= 1000 && diff.length <= whole.length * 0.7
      ? `${diff}\n${trailer}`
      : `${whole}\n${trailer}`;
  }
}
