import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunContext } from '../dist/context.js';
import { workspaceFiles } from '../dist/history.js';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=';
function group(i) {
  return [
    fauxAssistantMessage(fauxToolCall('read', { path: 'capture.png' }, 't' + i)),
    {
      role: 'toolResult',
      toolCallId: 't' + i,
      toolName: 'read',
      content: [
        { type: 'text', text: 'exact visual evidence ' + i + ' ' + 'record '.repeat(500) },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
      isError: false,
      timestamp: i,
    },
  ];
}
test('new images leave every previously projected message byte-identical', () => {
  const faux = fauxProvider();
  const ctx = new RunContext(faux.getModel(), () => {}, '/unused', 1000000, false);
  const messages = [
    { role: 'user', content: 'Inspect captures.', timestamp: 1 },
    ...group(0),
    ...group(1),
  ];
  const before = JSON.stringify(ctx.project(messages));
  messages.push(...group(2));
  const after = ctx.project(messages);
  assert.equal(JSON.stringify(after.slice(0, -2)), before);
  assert.equal(
    after
      .filter((m) => m.role === 'toolResult')
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'image').length,
    3,
  );
});
test('compaction archives exact image bytes privately and keeps a retrievable path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'bu-image-history-'));
  const faux = fauxProvider({ tokensPerSecond: 1e6 }),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Continue with exact records from saved evidence.')]);
  const ctx = new RunContext(
    faux.getModel(),
    models.streamSimple.bind(models),
    workspace,
    15000,
    true,
  );
  const messages = [
    { role: 'user', content: 'Never submit. Preserve visual evidence.', timestamp: 1 },
  ];
  for (let i = 0; i < 8; i++) messages.push(...group(i));
  try {
    await ctx.prepare(messages, 'system');
    assert.equal(ctx.compactions, 1);
    const checkpoint = ctx.project(messages)[0].content;
    const archive = JSON.parse(checkpoint.match(/^Evidence archive \(JSON path\): (.+)$/m)[1]);
    const saved = JSON.parse(await readFile(archive, 'utf8'));
    const block = saved.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === 'text' && c.text.startsWith('Archived image'));
    assert.ok(block, 'image path must remain in searchable evidence');
    const imagePath = JSON.parse(block.text.match(/JSON path: (.+)$/)[1]);
    assert.deepEqual(await readFile(imagePath), Buffer.from(png, 'base64'));
    assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
    assert.equal((await workspaceFiles(workspace)).length, 0);
    assert.ok(messages[2].content.some((c) => c.type === 'image' && c.data === png));
    const compacted = JSON.stringify(ctx.project(messages));
    messages.push(...group(8));
    assert.equal(JSON.stringify(ctx.project(messages).slice(0, -2)), compacted);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('retained screenshots still count against context limits', () => {
  const faux = fauxProvider();
  const model = { ...faux.getModel(), contextWindow: 5000 };
  const ctx = new RunContext(model, () => {}, '/unused', 1000000, false);
  const images = Array.from({ length: 12 }, (_, i) => group(i)).flat();
  assert.ok(ctx.tokens(images, '') > model.contextWindow);
  assert.equal(ctx.fits(images, ''), false);
});
