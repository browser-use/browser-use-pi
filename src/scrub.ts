/**
 * Text as telemetry sends it: Python browser_use/telemetry/stats.py scrub(), minimal port. The task (whole, and each run
 * of 5 of its words) as <task>; the run's secrets as <secret:name>; text the agent typed as <typed>; a URL's
 * user:password@, ;params, query and fragment dropped, its path tokens as <token>; a home folder's user as <user>;
 * emails as <email>; API keys, bearer tokens, cookies, password=... values and this process's *_KEY / *_TOKEN /
 * *_SECRET / *_PASSWORD environment values as <credential>; runs of 6+ digits as <number>; then cut to limit.
 */

export interface ScrubContext {
  /** The run's tasks: never sent. */
  tasks?: readonly string[];
  /** Text the agent typed: never sent. */
  typed?: readonly string[];
  /** Secret values, with the name sent in their place when known. */
  secrets?: readonly (readonly [value: string, name?: string])[];
}

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const KEYS = new RegExp(
  '(?<![A-Za-z0-9])(?:sk-ant-|sk-|sk_|rk_|bu_|gsk_|xai-|hf_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-|nvapi-' +
    '|pplx-|r8_|phc_)[A-Za-z0-9_-]{8,}' +
    '|(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])' +
    '|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]*)?' +
    '|(?<![A-Za-z0-9])(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9]{32,}',
  'g',
);
const BEARER =
  /\b([Bb]earer|[Bb]asic|BEARER|BASIC)(\s+)(?=\S*(?:\d|[a-z]\S*[A-Z]))[A-Za-z0-9._~+/=-]{8,}/g;
const AUTHORIZATION =
  /(?<![a-z])(authorization["']?\s*[=:]\s*["']?(?:bearer|basic)\s+)[^\s"'<>,;]+/gi;
const ASSIGNED =
  /(?<![a-z<])(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)(["']?\s*[=:]\s*)(?!(?:bearer|basic)\s)("[^"]*"|'[^']*'|[^\s&,;]+(?:&(?![A-Za-z_][\w.-]*=)[^\s&,;]*)*)/gi;
const COOKIE = /(?<![a-z])((?:set-)?cookie["']?\s*[=:]\s*)[^\r\n]+/gim;
const TAG = '<[a-z]+(?::[^\\s<>]*)?>';
const URL_RE = new RegExp(
  `\\b([a-z][a-z0-9+.-]{0,30}://)((?:[^\\s/?#@<>"'\`]|${TAG})*@)?((?:[^\\s;?#<>"'\`]|${TAG})*)` +
    `(?:[;?#](?:[^\\s<>"'\`]|${TAG})*)?`,
  'gi',
);
const QUERY = /(\/[^\s?#<>"'`]*)\?[^\s<>"'`]+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TOKEN = /(?<![A-Za-z0-9])(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9]{12,}/;
const GRANTS =
  /(?<![a-z])(?:reset|invite|invitation|magic|confirm|confirmation|verify|verification|token|tokens|activate|activation|unsubscribe|password)(?![a-z])/i;
const NUMBER = /(?<!\d)\+?\d(?:[ ()-]{0,2}\d){5,}(?!\d)/g;
const HOME =
  /((?:(?<=file:\/\/)|(?<![\w./-]))(?:\/Users\/|\/home\/)|(?<!\w)[a-z]:\\{1,2}Users\\{1,2})[^/\\\s'"<>`:]+/gi;
const HOSTNAME =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const ENV_SECRET = /(?:key|token|secret|password|passwd|credentials?)$/i;
/** Hostnames that alone open something private (a tunnel, a cloud IDE port, a preview deploy): sent as the provider. */
const CAPABILITY_SUFFIXES = [
  'trycloudflare.com',
  'ngrok-free.app',
  'ngrok-free.dev',
  'ngrok.io',
  'ngrok.app',
  'ngrok.dev',
  'loca.lt',
  'devtunnels.ms',
  'app.github.dev',
  'github.dev',
  'gitpod.io',
  'repl.co',
  'replit.dev',
  'csb.app',
];
const PREVIEW_HOSTS: Record<string, RegExp> = {
  'vercel.app': /^.+-(?:git-|[a-z0-9]{9}-).+$/,
  'netlify.app': /^.+--.+$/,
};
const LAMBDA_URL = /^.+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;
const CREDENTIAL =
  /(?:^|[:/])(?:sk-|sk_|gsk_|xai-|hf_|ghp_|github_pat_|nvapi-|pplx-|r8_|bu_|AIza|AQ\.|eyJ)|[A-Za-z0-9]{32}/;
const MIN_TASK = 8;
const TASK_WORDS = 5;
const MIN_TYPED = 4;
const SHORT_SECRET = 4;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const replaceAll = (text: string, find: string, by: string) => text.split(find).join(by);

function capabilityHost(hostname: string): string {
  for (const suffix of CAPABILITY_SUFFIXES)
    if (hostname.endsWith('.' + suffix)) return '*.' + suffix;
  const lambda = LAMBDA_URL.exec(hostname);
  if (lambda) return `*.lambda-url.${lambda[1]}.on.aws`;
  const dot = hostname.indexOf('.');
  const rest = hostname.slice(dot + 1);
  if (dot > 0 && PREVIEW_HOSTS[rest]?.test(hostname.slice(0, dot))) return '*.' + rest;
  return hostname;
}

/** An http(s) or ws(s) URL's hostname as the browser reads it, without user, port, path or query; else null. */
export function host(url: string): string | null {
  try {
    const u = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || !u.hostname) return null;
    const name = u.hostname.replace(/\.$/, '');
    if (name.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return name;
    return name.length <= 253 && HOSTNAME.test(name) ? capabilityHost(name) : null;
  } catch {
    return null;
  }
}

/** The model id as sent: 'other' for a URL or an API key, a local path's last segment, 64 characters. */
export function modelId(name: unknown): string {
  let text = String(name ?? '');
  if (text.includes('://') || CREDENTIAL.test(text)) return 'other';
  if (/^[/~.]/.test(text) || text.includes('\\') || /^[A-Za-z]:[\\/]/.test(text))
    text =
      text
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1) ?? '';
  return text.slice(0, 64);
}

function pathTokens(where: string): string {
  const slash = where.indexOf('/');
  if (slash < 0) return where;
  let granted = false;
  const segments = where
    .slice(slash + 1)
    .split('/')
    .map((segment) => {
      if (!segment || segment.includes('<')) return segment;
      const out = granted || UUID.test(segment) || TOKEN.test(segment) ? '<token>' : segment;
      granted ||= GRANTS.test(segment);
      return out;
    });
  return where.slice(0, slash + 1) + segments.join('/');
}

function url(_: string, scheme: string, userinfo: string | undefined, rest: string): string {
  const slash = rest.indexOf('/');
  let authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  const h = host(scheme + authority);
  if (h) authority = h;
  return scheme + (userinfo ? '<credential>@' : '') + pathTokens(authority + path);
}

/** A secret's forms as a page or a serializer shows it: escaped, cased, reversed, base64, hex, URL-encoded. */
function secretForms(secrets: ScrubContext['secrets'] = []): [string, string][] {
  const forms = new Map<string, string>();
  for (const [value, name] of secrets) {
    if (!value) continue;
    const label = name ? `<secret:${name}>` : '<secret>';
    const add = (form: string) => {
      if (form && !forms.has(form)) forms.set(form, label);
    };
    add(value);
    add(JSON.stringify(value).slice(1, -1));
    add(value.toLowerCase());
    add(value.toUpperCase());
    if (value.length >= SHORT_SECRET) {
      const bytes = Buffer.from(value);
      const b64 = bytes.toString('base64');
      for (const form of [
        [...value].reverse().join(''),
        b64,
        b64.replace(/=+$/, ''),
        bytes.toString('base64url'),
        bytes.toString('hex'),
        bytes.toString('hex').toUpperCase(),
        encodeURIComponent(value),
        encodeURIComponent(value).replace(/%20/g, '+'),
      ])
        add(form);
    }
  }
  return [...forms].sort((a, b) => b[0].length - a[0].length);
}

function redactForms(text: string, forms: [string, string][]): string {
  for (const [form, label] of forms)
    text =
      form.length < SHORT_SECRET
        ? text.replace(
            new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, 'gu'),
            label,
          )
        : replaceAll(text, form, label);
  return text;
}

const word = (w: string) =>
  w.replace(/^[.,;:!?"'()[\]{}*`]+|[.,;:!?"'()[\]{}*`]+$/g, '').toLowerCase();

/** Each run of TASK_WORDS or more of a source's words in a row (case and edge punctuation aside) as one placeholder. */
function wordRuns(text: string, sources: readonly string[], placeholder: string): string {
  const grams = new Set<string>();
  for (const source of sources) {
    const words = source.split(/\s+/).filter(Boolean).map(word);
    for (let i = 0; i + TASK_WORDS <= words.length; i++)
      grams.add(words.slice(i, i + TASK_WORDS).join('\u0000'));
  }
  if (!grams.size) return text;
  const tokens = [...text.matchAll(/\S+/g)];
  const words = tokens.map((m) => word(m[0]));
  const covered = new Array<boolean>(tokens.length).fill(false);
  for (let i = 0; i + TASK_WORDS <= tokens.length; i++)
    if (grams.has(words.slice(i, i + TASK_WORDS).join('\u0000')))
      covered.fill(true, i, i + TASK_WORDS);
  if (!covered.includes(true)) return text;
  let out = '';
  let end = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!covered[i]) continue;
    let j = i;
    while (j + 1 < tokens.length && covered[j + 1]) j++;
    out += text.slice(end, tokens[i]!.index) + placeholder;
    end = tokens[j]!.index! + tokens[j]![0].length;
    i = j;
  }
  return out + text.slice(end);
}

/** Typed text as a page quotes it and as a URL path does (pizza+near+me, 123-Main-St). */
function typedForms(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const forms = new Set([
    text,
    encodeURIComponent(text),
    encodeURIComponent(text).replace(/%20/g, '+'),
  ]);
  if (words.length > 1) for (const sep of ['-', '+', '_', '%20']) forms.add(words.join(sep));
  return [...forms].filter((f) => f.length >= MIN_TYPED);
}

function envSecrets(): string[] {
  return [
    ...new Set(
      Object.entries(process.env)
        .filter(
          ([k, v]) => ENV_SECRET.test(k) && v && v.length >= 12 && k !== 'PWD' && k !== 'OLDPWD',
        )
        .map(([, v]) => v!),
    ),
  ].sort((a, b) => b.length - a.length);
}

function scrubAll(text: string, context: ScrubContext): string {
  const tasks = (context.tasks ?? []).filter(Boolean);
  const forms = secretForms(context.secrets);
  const typed = [
    ...new Set(
      (context.typed ?? []).map((t) => String(t).trim()).filter((t) => t.length >= MIN_TYPED),
    ),
  ];
  let out = text;
  const quoted = new Set(
    tasks.flatMap((t) => [t, redactForms(t, forms)]).filter((f) => f.length >= MIN_TASK),
  );
  for (const form of [...quoted].sort((a, b) => b.length - a.length))
    out = replaceAll(out, form, '<task>');
  out = wordRuns(out, [...new Set(tasks.flatMap((t) => [t, redactForms(t, forms)]))], '<task>');
  out = redactForms(out, forms);
  const typedAll = [...new Set(typed.flatMap(typedForms))].sort((a, b) => b.length - a.length);
  for (const t of typedAll)
    if (out.toLowerCase().includes(t.toLowerCase()))
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'giu'),
        '<typed>',
      );
  out = wordRuns(out, typed, '<typed>');
  for (const value of envSecrets()) out = replaceAll(out, value, '<credential>');
  out = out.replace(URL_RE, url as (substring: string, ...args: string[]) => string);
  out = out.replace(QUERY, '$1');
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? '').replace(/[/\\]+$/, '');
  if (home.length > 1 && !new RegExp(`^${HOME.source}$`, 'i').test(home))
    out = out.replace(
      new RegExp(`(?:(?<=file://)|(?<![\\w./-]))${escapeRegExp(home)}(?![^/\\\\\\s'"<>\`:])`, 'g'),
      '~',
    );
  out = out.replace(HOME, (_, prefix: string) => prefix + '<user>');
  out = out.replace(BEARER, (_, a: string, b: string) => a + b + '<credential>');
  out = out.replace(AUTHORIZATION, (_, a: string) => a + '<credential>');
  out = out.replace(COOKIE, (_, a: string) => a + '<credential>');
  out = out.replace(ASSIGNED, (_, a: string, b: string) => a + b + '<credential>');
  return out.replace(KEYS, '<credential>').replace(EMAIL, '<email>').replace(NUMBER, '<number>');
}

/** Text as sent, at most limit characters; null for null/undefined. Cut last: a secret cut in half no longer matches. */
export function scrub(text: unknown, limit: number, context: ScrubContext = {}): string | null {
  if (text === null || text === undefined) return null;
  const value = String(text);
  const longest = Math.max(
    0,
    ...(context.tasks ?? []).map((t) => t.length),
    ...(context.typed ?? []).map((t) => 3 * String(t).length),
    ...(context.secrets ?? []).map(([v]) => 4 * v.length),
  );
  const window = 64 * limit + longest + 64;
  if (value.length > window) {
    const head = scrubAll(value.slice(0, window), context);
    if (head.length >= 2 * limit + window / 2) return head.slice(0, limit);
  }
  return scrubAll(value, context).slice(0, limit);
}
