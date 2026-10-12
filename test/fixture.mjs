import { createServer } from 'node:http';

const html = (body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>${head}</head><body>${body}</body></html>`;
const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');
const rows = (n, name) =>
  times(n, (i) => `<div style="height:40px"><button>${name} ${i}</button></div>`);
/** Pages for the ultrafast state tests (test/state-v2.test.mjs). */
const statePages = {
  '/long': html(
    `<h1>Long list</h1>${times(300, (i) => `<p><button id="b${i}">Item ${i}</button></p>`)}<p><button id="submit">Submit order</button></p>`,
  ),
  '/divsoup': html(
    `${times(80, (i) => `<div>Row ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et</div>`)}<button>After soup</button>`,
  ),
  '/clickdiv': html(
    `<div id="cd" onclick="document.getElementById('out').textContent='div clicked'" style="cursor:pointer;padding:10px;border:1px solid">Open settings</div>
     <span id="sp" onclick="1" style="cursor:pointer">Delete row</span> <a id="nohref">Anchor without href</a><p id="out"></p>`,
  ),
  '/innerscroll': html(
    `<div style="height:100vh;display:flex;flex-direction:column"><header><button>Top bar</button></header>
     <div id="list" aria-label="Results" style="flex:1;overflow:auto">${times(500, (i) => `<div style="height:40px"><button>Row ${i}</button></div>`)}</div></div>`,
    '<style>body{margin:0}</style>',
  ),
  '/sticky': html(
    `<header style="position:sticky;top:0;height:60px;background:#fff"><a href="#home">Brand home</a></header>
     ${times(100, (i) => `<p><button>Item ${i}</button></p>`)}`,
  ),
  '/bodyscroll': html(
    times(200, (i) => `<div style="height:40px"><button>Row ${i}</button></div>`),
    '<style>html,body{height:100%;margin:0}body{overflow:auto}</style>',
  ),
  '/shellscroll': html(
    times(200, (i) => `<div style="height:40px"><button>Row ${i}</button></div>`),
    '<style>html,body{height:100%;margin:0}html{overflow:hidden}body{overflow:auto}</style>',
  ),
  '/scrollframe': html(
    `<h1>Outer</h1><iframe title="Inner" src="/framed" style="width:400px;height:200px"></iframe>`,
  ),
  '/framed': html(times(60, (i) => `<p><button>Framed ${i}</button></p>`)),
  // One page per way the first print was wrong (artifacts/state-v2/review-print-*.md), and per edge case it has to keep.
  '/fixedin': html(
    `<div aria-label="Panel" style="height:200px;overflow:auto;margin-top:300px">${rows(30, 'P')}<button style="position:fixed;top:10px;right:10px">Floating close</button></div>`,
  ),
  '/menu': html(
    `<div style="position:relative"><h1>Table</h1><div aria-label="Rows" style="height:120px;overflow:auto;margin-top:150px">${rows(30, 'Row')}
     <div style="position:absolute;top:10px;left:400px"><button>Rename</button><button>Delete</button></div></div></div><button>Footer</button>`,
  ),
  '/dialoginlist': html(
    `<div style="height:500px"></div><div aria-label="Orders" style="height:200px;overflow:auto">${rows(30, 'Order')}
     <dialog id="d"><h2>Delete order?</h2><button>Delete</button><button>Keep</button></dialog></div><script>d.showModal()</script>`,
  ),
  '/tabhead': html(
    `<button>Top</button><div style="height:2000px"></div>${times(5, () => '<h2 tabindex="-1">Section</h2>')}<button>Bottom</button>`,
  ),
  '/carousel': html(
    `<h1>Shop</h1><div aria-label="Deals" style="width:400px;overflow-x:auto;white-space:nowrap">${times(30, (i) => `<button style="width:150px">Deal ${i}</button>`)}</div>
     <div style="width:5000px;height:40px;position:relative"><button style="position:absolute;left:3000px">Far right</button></div>`,
  ),
  '/pay': html(
    `<h1>Checkout</h1><button onclick="document.title='PAID'">Pay now</button><button>Cancel</button><a href="/other">Other</a>`,
  ),
  '/other': html(
    `<h1>Account</h1><button onclick="document.title='DELETED'">Delete account</button><button onclick="document.title='kept'">Keep</button><a href="/pay">Pay</a>`,
  ),
  '/spa': html(
    `<button id="go" onclick="history.pushState({}, '', '/spa/next'); document.querySelector('h1').textContent = 'Next'">Go next</button><h1>Home</h1><button onclick="document.title='kept'">Kept</button>${rows(12, 'Row')}`,
  ),
  '/ticker': html(
    `<h1>News</h1><div id="t" style="height:40px;overflow:hidden">${times(500, (i) => `<div style="height:40px">Headline ${i}</div>`)}</div><button>Read more</button>
     <script>setInterval(() => { t.scrollTop = (t.scrollTop + 1) % 19000 }, 16)</script>`,
  ),
  '/para': html(
    `<p style="width:150px">Total price: <b>1234567890123</b> incl. tax</p><p style="width:150px">Ships to <span>Switzerland</span> only</p>
     <ul><li style="width:150px">Free <b>returns</b> within thirty days of delivery</li></ul>`,
  ),
  '/shelltext': html(
    `<header style="height:50px"><a href="#home">Home</a></header><main aria-label="Terms" style="height:calc(100vh - 150px);overflow:auto">
     ${times(300, (i) => `<p style="margin:0;height:40px">Paragraph ${i} of the terms.</p>`)}<p>THE SECRET CODE IS 4711.</p></main><button>Accept</button>`,
    '<style>html,body{height:100%;margin:0;overflow:hidden}</style>',
  ),
  '/parked': html(
    `<a href="#main" style="position:absolute;top:-9999px">Skip to content</a><ul style="position:absolute;left:-9999px;margin:0"><li><a href="#s">Skip to search</a></li></ul>
     <h1>Form</h1>${['Radio A', 'Radio B'].map((t) => `<label style="display:block;height:30px"><input type="radio" name="r" style="position:absolute;left:-9999px"> ${t}</label>`).join('')}
     <label style="display:block;height:30px"><input type="checkbox" style="position:absolute;top:-9999px"> Newsletter</label>
     <label style="display:block">Avatar<input type="file" aria-label="avatar" style="position:absolute;left:-9999px"></label>
     <div style="height:2000px"></div><label style="display:block;height:30px"><input type="radio" name="q" style="position:absolute;left:-9999px"> Radio far below</label>`,
  ),
  '/zoom': html(
    `<div style="zoom:2"><div aria-label="Zoomed" style="height:300px;overflow:auto">${times(40, (i) => `<div style="height:30px"><button>Z ${i}</button></div>`)}</div></div>
     <div style="transform:scale(.5);transform-origin:0 0;width:200%"><div aria-label="Small" style="height:300px;overflow:auto">${times(40, (i) => `<div style="height:30px"><button>S ${i}</button></div>`)}</div></div>`,
    '<style>body{margin:0}</style>',
  ),
  '/transformscroll': html(
    `<div id="wrap" style="position:fixed;top:0;left:0;right:0">${rows(200, 'T')}</div>
     <script>let y = 0; addEventListener('wheel', (e) => { y = Math.max(0, y + e.deltaY); wrap.style.transform = 'translateY(' + -y + 'px)' })</script>`,
    '<style>html,body{height:100%;margin:0;overflow:hidden}</style>',
  ),
  '/drawer': html(
    `${rows(100, 'Page')}<div role="dialog" aria-modal="true" aria-label="Menu" style="position:fixed;top:0;left:0;width:300px;height:100%;transform:translateX(-100%)"><button>Drawer link</button></div>`,
  ),
  '/dense': html(times(700, (i) => `<button>B${i}</button> `)),
  '/bigtext': html(
    `<pre>${times(3000, (i) => `line ${i} of the log: status ok, value ${i * 7}\n`)}</pre><button>After log</button>`,
  ),
  '/nested': html(
    `<div aria-label="Outer" style="height:300px;overflow:auto">${rows(5, 'Outer')}
     <div role="listbox" aria-label="Cities" tabindex="0" style="height:100px;overflow-y:scroll">${times(20, (i) => `<div role="option" style="height:30px">City ${i}</div>`)}</div>
     ${rows(30, 'Tail')}<div aria-label="Deep" style="height:100px;overflow:auto">${rows(10, 'Deep')}</div></div>
     <div style="height:100px;overflow:auto">${times(20, (i) => `<div style="height:30px"><a href="#${i}">Link ${i}</a></div>`)}</div>`,
  ),
  '/odd': html(
    `<h1>Odd</h1><button style="display:contents"><span>Contents button</span></button><a href="#x" style="display:block;height:0"><span style="display:block">Zero height link</span></a>
     <input type="file" name="resume" style="display:none"><iframe title="Short" src="/framed-short" style="width:300px;height:100px"></iframe>
     <div style="height:2000px"></div><label>Speed <select><option>Standard</option><option>Express</option></select></label><input type="file" aria-label="Low upload">
     <iframe title="Low" src="/framed" style="width:300px;height:100px"></iframe>`,
  ),
  '/framed-short': html('<button>Short frame button</button>'),
  // The diff: a button that opens a list in place and closes it again.
  '/combo': html(
    `<h1>Trip</h1><button id="t" aria-expanded="false" onclick="toggle()">Round trip</button><div id="menu"></div><p>Fares shown per person</p><button>Search</button>${rows(12, 'Fare')}
     <script>function toggle() { const open = t.getAttribute('aria-expanded') !== 'true'; t.setAttribute('aria-expanded', open);
       menu.innerHTML = open ? '<div role="listbox" aria-label="Ticket type"><div role="option" aria-selected="true">Round trip</div><div role="option">One way</div><div role="option">Multi-city</div></div><p>Prices include taxes</p>' : ''; }</script>`,
  ),
  '/alert': html(
    `<h1>Alert</h1><button onclick="alert('Saved it')">Save</button>${rows(60, 'Item')}<script>const ping = () => fetch('/slow?' + Math.random()).catch(() => {}); ping(); setInterval(ping, 400)</script>`,
  ),
};

export async function startFixture() {
  const server = createServer((req, res) => {
    const statePage =
      statePages[req.url] ?? (req.url === '/spa/next' ? statePages['/spa'] : undefined);
    if (statePage) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(statePage);
      return;
    }
    if (req.url.startsWith('/slow')) return void setTimeout(() => res.end('ok'), 1400).unref(); // held open: `loading: <n>`
    if (req.url === '/catalog.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="catalog.csv"',
      });
      res.end('name,price\nAtlas,29\nOrbit,49\n');
      return;
    }
    if (req.url === '/frame') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<label>Reference <input id="ref"></label><button onclick="document.querySelector(\'#value\').textContent=document.querySelector(\'#ref\').value">Save reference</button><p id="value"></p>',
      );
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><head><title>Orbital Supply — test fixture</title><style>
      body{font:17px system-ui;background:#f5f6f8;color:#121a2b;max-width:900px;margin:70px auto;padding:24px}h1{font-size:48px;letter-spacing:-2px}button,a,input,select{font:inherit;padding:12px;margin:8px 8px 8px 0}button{background:#235bea;color:white;border:0;border-radius:8px}article{padding:16px;background:white;margin:12px 0;border-radius:12px}.label{color:#65718b;font-size:13px;letter-spacing:2px}#status{font-weight:600;color:#235bea}iframe{background:white;border:1px solid #ddd;width:100%;height:170px}
      </style></head><body><p class="label">BROWSER USE / LOCAL TEST STORE</p><h1>Orbital Supply</h1><p>A real browser. A local fixture. No account, no checkout.</p>
      <form id="search"><label>Search products <input name="query" type="search"></label><button>Search</button></form>
      <section id="products"><article data-price="29"><h2>Atlas</h2><p>Travel charger · $29</p></article><article data-price="49"><h2>Orbit</h2><p>Desktop charger · $49</p></article></section>
      <label>Shipping <select id="shipping" aria-label="Shipping"><option>Standard</option><option>Express</option></select></label>
      <label>Attach notes <input type="file" id="upload"></label>
      <p><button id="save">Save selection</button><a href="/catalog.csv" download>Export catalog</a><a href="/details" target="_blank">Open details</a></p>
      <p id="status" role="status">No selection saved</p><iframe title="Reference" src="/frame"></iframe><div id="shadow"></div>
      <script>
      let saves=0;document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='Saved '+(++saves)+' time(s)'};
      document.querySelector('#search').onsubmit=e=>{e.preventDefault();const q=e.target.query.value.toLowerCase();for(const a of document.querySelectorAll('article'))a.hidden=!a.textContent.toLowerCase().includes(q)};
      document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';document.querySelector('#shadow').shadowRoot.querySelector('button').onclick=e=>e.target.textContent='Shadow done';
      </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
