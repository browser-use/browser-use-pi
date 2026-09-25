import type { AXNode, Page } from './page.js';
import type { ChoiceAnswer, ChoiceRequest } from './semantic-resolver.js';

type Operation = 'fill' | 'click' | 'select';
const roles: Record<Operation, Set<string>> = {
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
    'option',
    'combobox',
  ]),
  select: new Set(['combobox', 'listbox']),
};
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const pageText = (nodes: AXNode[]) =>
  [
    ...new Set(
      nodes.filter((n) => n.role !== 'InlineTextBox' && n.name).map((n) => `${n.role}: ${n.name}`),
    ),
  ]
    .join('\n')
    .slice(0, 6000);

/** Optional bounded target resolution inside Pi's existing persistent code runner. */
export class SemanticBrowser {
  readonly history: {
    operation: Operation;
    target: string | number;
    status: string;
    id: number | undefined;
  }[] = [];
  private busy = false;
  private afterInput = false;
  constructor(
    private page: () => Page,
    private resolve: (q: ChoiceRequest) => Promise<ChoiceAnswer>,
  ) {}

  private async observe(page: Page) {
    if (this.afterInput) {
      this.afterInput = false;
      // Read-only settling; never repeat a completed mutation if observation is interrupted.
      await page
        .evaluate(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 75);
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        )
        .catch(() => {});
    }
    return page.snapshot();
  }
  async state() {
    const state = await this.observe(this.page());
    return {
      url: state.url,
      title: state.title,
      text: pageText(state.nodes),
      elements: state.nodes.filter((n) => Object.values(roles).some((r) => r.has(n.role))),
    };
  }

  /** Rendered text evidence only; it is still the caller's job to check the task's outcome. */
  async visible(text: string) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Supply expected visible text.');
    const page = this.page();
    const state = await this.observe(page);
    for (const node of state.nodes.filter(
      (n) => n.role === 'StaticText' && normalize(n.name).includes(normalize(text)),
    )) {
      if (
        await this.onNode<boolean>(
          page,
          node.id,
          `function() {
        const e=this.nodeType===Node.ELEMENT_NODE ? this : this.parentElement;
        return !!e?.isConnected && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
      }`,
        ).catch(() => false)
      )
        return true;
    }
    return false;
  }

  private async pick(operation: Operation, target: string | number) {
    const page = this.page();
    const state = await this.observe(page);
    const candidates = state.nodes.filter((n) => roles[operation].has(n.role) && !n.disabled);
    if (!candidates.length || candidates.length > 250)
      throw new Error('NEEDS_PI: empty or oversized action space.');
    const exact = candidates.filter((n) =>
      typeof target === 'number' ? n.id === target : normalize(n.name) === normalize(target),
    );
    let node: AXNode | undefined;
    if (exact.length === 1) node = exact[0];
    else {
      if (typeof target !== 'string' || !target.trim() || target.length > 1000)
        throw new Error('NEEDS_PI: invalid or stale target.');
      const answer = await this.resolve({
        question: `Which observed ${operation === 'fill' ? 'editable field' : operation === 'select' ? 'dropdown' : 'clickable control'} has this purpose: ${target}? Match the function, allowing synonymous labels.`,
        state: {
          url: state.url,
          title: state.title,
          target,
          operation,
          elements: candidates,
          context: pageText(state.nodes),
        },
        options: Object.fromEntries(candidates.map((n) => [String(n.id), n])),
      });
      node = candidates.find((n) => String(n.id) === answer.choice);
      if (!node) throw new Error('NEEDS_PI: no matching target.');
    }
    if (!node) throw new Error('NEEDS_PI: no matching target.');
    const fresh = await page.snapshot();
    if (
      fresh.url !== state.url ||
      !fresh.nodes.some((n) => n.id === node!.id && JSON.stringify(n) === JSON.stringify(node))
    )
      throw new Error('NEEDS_PI: target changed during resolution; no action executed.');
    return { page, node };
  }

  private async onNode<T>(page: Page, id: number, fn: string, argument?: unknown): Promise<T> {
    const { object } = await page.cdp('DOM.resolveNode', { backendNodeId: id });
    if (!object.objectId) throw new Error('NEEDS_PI: node unavailable.');
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

  private async run(operation: Operation, target: string | number, value?: string) {
    if (this.busy) throw new Error('Await browser actions sequentially; no concurrent mutations.');
    if (value !== undefined && (typeof value !== 'string' || value.length > 20000))
      throw new Error('Invalid exact value.');
    this.busy = true;
    const entry = { operation, target, status: 'resolving', id: undefined as number | undefined };
    this.history.push(entry);
    try {
      const { page, node } = await this.pick(operation, target);
      entry.id = node.id;
      await page.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.id });
      const point = await this.onNode<{ x: number; y: number; nativeDate: boolean }>(
        page,
        node.id,
        `function(operation) {
        if (!this.isConnected || this.matches(':disabled') || this.closest('[inert],[aria-disabled="true"]') ||
            !this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) throw Error('Target unavailable');
        if (operation==='fill' && (this.readOnly || this.getAttribute('aria-readonly')==='true' ||
            ['password','file','hidden'].includes(this.type) ||
            !(['INPUT','TEXTAREA'].includes(this.tagName) || this.isContentEditable))) throw Error('Not an editable field');
        const r=this.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
        const root=this.getRootNode();
        if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight ||
            !this.contains(root.elementFromPoint(x,y))) throw Error('Target is covered or outside viewport');
        return {x,y,nativeDate:this.tagName==='INPUT' && ['date','time','datetime-local','month','week'].includes(this.type)};
      }`,
        operation,
      );
      if (operation === 'click') {
        entry.status = 'attempted';
        await page.clickAt(point.x, point.y);
      } else if (operation === 'fill') {
        if (point.nativeDate) {
          // Validate the browser's own value serialization before touching the live field.
          await this.onNode(
            page,
            node.id,
            `function(value) {
            const probe=this.cloneNode(false); probe.value=value;
            if(probe.value!==value) throw Error('Invalid native date/time value; use its exact ISO format');
          }`,
            value,
          );
          entry.status = 'attempted';
          await this.onNode(
            page,
            node.id,
            `function(value) {
            if(!this.isConnected || this.disabled || this.readOnly) throw Error('Date field changed');
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(this,value);
            this.dispatchEvent(new Event('input',{bubbles:true}));
            this.dispatchEvent(new Event('change',{bubbles:true}));
            if(this.value!==value) throw Error('Date field verification failed; inspect before retrying');
          }`,
            value,
          );
        } else {
          entry.status = 'attempted';
          await page.cdp('DOM.focus', { backendNodeId: node.id });
          const focused = `function() { if (!this.isConnected || this.getRootNode().activeElement!==this ||
          this.readOnly || this.matches(':disabled')) throw Error('Focus changed; input stopped'); return true; }`;
          await this.onNode(page, node.id, focused);
          await page.cdp('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers: process.platform === 'darwin' ? 4 : 2,
            commands: ['selectAll'],
          });
          await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
          await this.onNode(page, node.id, focused);
          if (value === '') {
            await page.cdp('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Backspace',
              code: 'Backspace',
              windowsVirtualKeyCode: 8,
              commands: ['deleteBackward'],
            });
            await page.cdp('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Backspace',
              code: 'Backspace',
            });
          } else await page.cdp('Input.insertText', { text: value! });
          const actual = await this.onNode<string>(
            page,
            node.id,
            `function() { return this.isContentEditable ? this.innerText : this.value; }`,
          );
          if (actual !== value)
            throw new Error('Field verification failed; inspect before retrying.');
        }
      } else {
        const options = await this.onNode<{ index: number; label: string; value: string }[]>(
          page,
          node.id,
          `function() {
          if (this.tagName!=='SELECT' || this.multiple) throw Error('Use raw browser tools for non-native/multiple select');
          return [...this.options].map((o,index)=>({index,label:o.label,value:o.value,disabled:o.disabled||!!o.closest('optgroup[disabled]')})).filter(o=>!o.disabled);
        }`,
        );
        let matches = options.filter((o) => normalize(o.label) === normalize(value!));
        if (matches.length !== 1) {
          const answer = await this.resolve({
            question: `Which dropdown option means: ${value}?`,
            state: { field: node.name, target: value, options },
            options: Object.fromEntries(options.map((o) => [String(o.index), o])),
          });
          matches = options.filter((o) => String(o.index) === answer.choice);
        }
        if (matches.length !== 1) throw new Error('NEEDS_PI: ambiguous dropdown option.');
        entry.status = 'attempted';
        await this.onNode(
          page,
          node.id,
          `function(option) {
          const o=this.options[option.index];
          if (!this.isConnected || this.disabled || !o || o.disabled || o.closest('optgroup[disabled]') ||
              o.label!==option.label || o.value!==option.value) throw Error('Dropdown changed');
          this.selectedIndex=option.index;
          this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
          if (this.selectedOptions[0]!==o) throw Error('Dropdown result differs; inspect before retrying');
        }`,
          matches[0],
        );
      }
      entry.status = 'completed';
      this.afterInput = true;
      return { ...entry };
    } catch (error) {
      entry.status = entry.status === 'attempted' ? 'uncertain' : 'not_executed';
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; bu.history records the executed prefix.`,
      );
    } finally {
      this.busy = false;
    }
  }
  fill(target: string | number, text: string) {
    return this.run('fill', target, text);
  }
  click(target: string | number) {
    return this.run('click', target);
  }
  select(target: string | number, option: string) {
    return this.run('select', target, option);
  }
}
