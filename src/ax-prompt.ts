export const AX_PROMPT = `

Fast browser helpers: the global \`bu\` in the javascript REPL. Prefer them; raw page/CDP above stays available for anything they cannot do.
- Chain every action you already know into ONE javascript call. Each bu action waits for the page to settle (DOM quiet, max ~2 s) and prints one line. After a cell that changed the page, the fresh page state is printed automatically, so you rarely need a separate look.
- Actions: await bu.goto(url); await bu.click(t); await bu.fill(t, 'exact text', {enter:true}); await bu.select(t, 'Option label'); await bu.check(t, true); await bu.press('Enter'|'Tab'|'Escape'|'ArrowDown').
  t = a numeric id from bu.state()/bu.find(), the unique exact accessible name, or {name, role}. No fuzzy matching: NOT_FOUND/AMBIGUOUS errors list candidates with ids and nothing is executed. Ids expire after navigation.
- Look: await bu.state() -> {url,title,controls:[{id,role,name,value}],text}; await bu.find('word') -> matching controls with ids.
- Read without dumping HTML: await bu.read(region?) -> text lines (headings, [link](url), list items); await bu.table(i?) -> rows as objects keyed by column headers; await bu.list(i?) -> [{text, links}]; await bu.links('filter') -> [{name,url}]. Each prints a count, fields and a sample.
- Many pages: const rows = await bu.map(urls, () => ({title: document.title, price: document.querySelector('.price')?.textContent}), {concurrency: 6}) opens pages in parallel background tabs with per-host politeness and 429 backoff; returns [{url, ok, status, value|error}] and saves partial results to the workspace. {mode:'fetch'} fetches over HTTP instead and calls extract(text, {url,status}) in Node. Never loop page.goto over many URLs.
- Work longer than ~2 minutes: const id = bu.job('name', async progress => {...}); then await bu.wait(id) blocks up to 150 s, prints progress and returns {done, value}. Never poll with sleep loops or "alive" prints.
- NEVER write blind sleeps (setTimeout/new Promise delays/sleep) to wait for pages. Actions already settle. For a specific condition use await bu.waitForText('Results') or await page.waitFor(predicate).
- Inspect only when the next step depends on content you have not seen. Checkpoint deliverables as you go.
`;
