import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frameCount, validateBrief, createGraph, ComfyClient, validateGraph, guiGraph } from '../src/comfy.mjs';
import { exportComposition } from '../src/hypit.mjs';
const brief = { id: 'test', prompt: 'Rain', width: 864, height: 480, duration: 5, seed: 42 };

test('H3 durations round upward to the actual model grid', () => {
  assert.equal(frameCount(5), 124);
  assert.equal(frameCount(15), 362);
  for (let seconds = 5; seconds <= 15; seconds += 0.25) {
    assert.equal(frameCount(seconds) % 17, 5);
    assert.ok(frameCount(seconds) >= Math.round(seconds * 24));
  }
  assert.throws(() => frameCount(0));
});
test('unsafe IDs, unsupported dimensions and seeds fail before submission', () => {
  for (const patch of [{ id: '../escape' }, { width: 865 }, { seed: -1 }, { seed: 2 ** 54 }, { steps: 3 }, { prompt: '' }]) {
    assert.throws(() => validateBrief({ ...brief, ...patch }));
  }
});
test('graph carries native audio and deterministic seed; first-frame is optional', () => {
  const graph = createGraph(brief);
  assert.deepEqual(graph['14'].inputs.audio, ['13', 0]);
  assert.equal(graph['7'].inputs.noise_seed, 42);
  assert.equal(graph['6'].inputs.length, 124);
  assert.equal(graph['6'].inputs.first_frame, undefined);
  assert.deepEqual(createGraph({ ...brief, firstFrame: 'cafe.png' })['6'].inputs.first_frame, ['16', 0]);
});
test('schema validation rejects missing weights and incompatible sockets', () => {
  const graph = { '1': { class_type: 'Load', inputs: { name: 'a' } }, '2': { class_type: 'Save', inputs: { source: ['1', 0] } } };
  const info = { Load: { input: { required: { name: [['a']] } }, output: ['IMAGE'] }, Save: { input: { required: { source: ['IMAGE'] } }, output: [] } };
  validateGraph(graph, info);
  const gui = guiGraph(graph, info);
  assert.equal(gui.links.length, 1);
  assert.equal(gui.nodes[0].outputs[0].links[0], gui.nodes[1].inputs[0].link);
  assert.ok(gui.nodes[0].pos[0] + gui.nodes[0].size[0] < gui.nodes[1].pos[0]);
  graph['1'].inputs.name = 'missing';
  assert.throws(() => validateGraph(graph, info), /Unavailable/);
  graph['1'].inputs.name = 'a'; info.Load.output = ['AUDIO'];
  assert.throws(() => validateGraph(graph, info), /connection/);
});

async function mockServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return new ComfyClient(`http://127.0.0.1:${server.address().port}`);
}
test('submit, poll, download and export work against a simulated ComfyUI server', async t => {
  let polls = 0, submitted;
  const client = await mockServer(t, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prompt') {
      let body = ''; for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body); res.end(JSON.stringify({ prompt_id: 'job-1' }));
    } else if (req.url === '/history/job-1') {
      res.end(JSON.stringify(++polls === 1 ? {} : { 'job-1': { status: { completed: true, status_str: 'success' }, outputs: { '15': { images: [{ filename: 'clip.webm', subfolder: 'test', type: 'output' }] } } } }));
    } else if (req.url.startsWith('/view?')) { res.end('mock-video-bytes'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  const temp = await mkdtemp(path.join(tmpdir(), 'hypit-comfy-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  assert.equal((await client.submit(createGraph(brief), {})).prompt_id, 'job-1');
  assert.equal(submitted.prompt['14'].inputs.fps, 24);
  const history = await client.wait('job-1', { intervalMs: 1, timeoutMs: 2000 });
  const artifact = await client.downloadVideo(history, path.join(temp, 'source.mp4'));
  assert.equal(path.extname(artifact.path), '.webm');
  assert.equal(await readFile(artifact.path, 'utf8'), 'mock-video-bytes');
  const run = await exportComposition(path.join(temp, 'hypit'), artifact.path, brief, 124);
  assert.match(await readFile(run, 'utf8'), /final.video/);
  const source = await readFile(path.join(temp, 'hypit/main.svml'), 'utf8');
  assert.match(source, /native-sound.audio/);
  assert.match(source, /end="124f"/);
  assert.match(source, /src="..\/source.webm"/);
});
test('errors and timeouts never become successful artifacts', async t => {
  const client = await mockServer(t, (req, res) => res.end(JSON.stringify({ failed: { status: { status_str: 'error', messages: ['out of memory'] } } })));
  await assert.rejects(client.wait('failed', { timeoutMs: 100 }), /out of memory/);
  await assert.rejects(client.wait('pending', { timeoutMs: 10, intervalMs: 2 }), /Resume/);
  await assert.rejects(client.downloadVideo({ outputs: {} }, 'unused.mp4'), /no saved video/);
});
