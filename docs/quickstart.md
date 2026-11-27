# Browser Use, built on Pi

A TypeScript SDK. The agent writes JavaScript, sees Chrome’s accessibility tree, and uses raw CDP. Pi supplies the model loop. Browser Use Pi adds the browser and a persistent session.

## Install

Run your app with **Node 22.19+** or **Bun 1.3.14+**. Bun also requires Node on `PATH`: the persistent JavaScript worker uses Node’s V8 inspector. Set `BROWSER_USE_NODE=/absolute/path/to/node` to choose that executable. The worker does not inherit host preload flags or API keys.

Use local Chrome or [Browser Use Cloud](./sessions.md). Runtime checks cover macOS; Windows has not been verified. The SDK requires a Node process and filesystem, so it does not run directly inside Cloudflare Workers. A remote browser does not remove that runtime requirement.

```sh
npm install @browser_use/pi
# or: pnpm add @browser_use/pi
# or: bun add @browser_use/pi
export OPENROUTER_API_KEY=...
export BROWSER_USE_API_KEY=...
```

## Run

Save as `agent.ts`:

```ts
import { Browser, BrowserUse } from '@browser_use/pi';

const agent = await BrowserUse.create({
  model: 'openrouter/openai/gpt-5.6-luna',
  reasoning: 'xhigh',
  browser: Browser.cloud({ apiKey: process.env.BROWSER_USE_API_KEY! }),
  workspace: './work',
  log: 'pretty',
});
try {
  const result = await agent.run('Find the top story on Hacker News.');
  console.log(result.status, result.text);
  await agent.followUp('Summarize the comments.');
} finally {
  await agent.close();
}
```

```sh
node agent.ts
# or
bun agent.ts
```

`completed` means the agent delivered a schema-valid answer. Verify business outcomes in your application. Other statuses describe the stop reason; always check them.

Use [models](./models.md) for credentials, [sessions](./sessions.md) for login and persistence, and [API](./api.md) for output, events and hooks.

## Moving from `@browser_use/js`

Install `@browser_use/pi` and change your imports. The `BrowserUse` API, browser options, environment variables, profile directories and session history format are unchanged. The earlier package remains available; this rename does not migrate or delete existing data.

## Publish to npm (maintainers)

The public package is `@browser_use/pi`. Releases publish from GitHub Actions with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers); no npm token lives in this repository.

One-time setup by an npm owner of `@browser_use/pi` (`npm trust` needs a recent npm 11, pinned here):

```sh
npx -y npm@11.19.1 trust github @browser_use/pi --repo browser-use/browser-use-pi --file publish.yml --allow-publish
```

Or on npmjs.com: package Settings, Trusted Publisher, GitHub Actions, organization `browser-use`, repository `browser-use-pi`, workflow `publish.yml`.

To release: bump `version` in `package.json`, run `npm run check && npm test && npm run test:bun`, merge, then push a matching tag:

```sh
V=v$(node -p "require('./package.json').version")
git tag "$V" && git push origin "$V"
```

`.github/workflows/publish.yml` checks that the tag matches `package.json`, skips versions already on npm, builds and publishes with provenance. npm versions cannot be overwritten; bump the version for each later release.
