#!/usr/bin/env node
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { ComfyClient, readJson, writeJson, createGraph, validateGraph, guiGraph, frameCount, validateBrief } from '../src/comfy.mjs';
import { exportComposition } from '../src/hypit.mjs';

const args = process.argv.slice(2);
const command = args.shift();
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function config() {
  const file = process.env.LOCAL_VIDEO_CONFIG ?? 'config.local.json';
  const settings = await exists(file) ? await readJson(file) : {};
  settings.host = process.env.COMFY_HOST ?? settings.host ?? 'http://127.0.0.1:8188';
  return settings;
}
async function finish(client, state, dir, settings) {
  let lastMessage = 0;
  const result = await client.wait(state.promptId, { timeoutMs: settings.timeoutMs, onProgress: id => {
    if (Date.now() - lastMessage > 30_000) { console.log(`Waiting for ComfyUI job ${id}…`); lastMessage = Date.now(); }
  } });
  const artifact = await client.downloadVideo(result, path.join(dir, 'source.mp4'));
  const run = await exportComposition(path.join(dir, 'hypit'), artifact.path, state.brief, state.frames);
  await writeJson(path.join(dir, 'job.json'), { ...state, status: 'complete', artifact: { ...artifact, path: path.basename(artifact.path) }, completedAt: new Date().toISOString() });
  console.log(`Saved ${artifact.path}\nEditable composition: ${run}\nNext: npm run hypit -- plan "${run}"`);
}
async function main() {
  const settings = await config();
  const client = new ComfyClient(settings.host);
  if (command === 'doctor') {
    const [stats, info] = await Promise.all([client.request('/system_stats'), client.request('/object_info')]);
    const brief = await readJson('examples/rainy-cafe.json');
    validateGraph(createGraph(brief, settings), info);
    console.log(JSON.stringify({ host: settings.host, comfyVersion: stats.system.comfyui_version,
      devices: stats.devices.map(d => ({ name: d.name, vramGB: +(d.vram_total / 2 ** 30).toFixed(1) })),
      requiredNodesAndModels: 'available' }, null, 2));
    return;
  }
  if (command === 'resume') {
    if (!args[0]) throw new Error('Usage: resume output/<job>/job.json');
    const state = await readJson(args[0]);
    if (!state.promptId) throw new Error('No prompt ID was recorded; inspect ComfyUI history before submitting again');
    if (state.host !== client.host) throw new Error(`Resume requires the original host: ${state.host}`);
    return finish(client, state, path.dirname(path.resolve(args[0])), settings);
  }
  if (command === 'run' || command === 'prepare') {
    if (!args[0]) throw new Error('Usage: run|prepare examples/rainy-cafe.json');
    const brief = validateBrief(await readJson(args[0]));
    const info = await client.request('/object_info');
    const graph = createGraph(brief, settings);
    validateGraph(graph, info);
    const gui = guiGraph(graph, info);
    const dir = path.resolve('output', `${brief.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, 'workflow.api.json'), graph);
    await writeJson(path.join(dir, 'workflow.json'), gui);
    const state = { status: 'prepared', host: client.host, brief, frames: frameCount(brief.duration), seed: graph['7'].inputs.noise_seed, createdAt: new Date().toISOString() };
    await writeJson(path.join(dir, 'job.json'), state);
    if (settings.workflowDirectory) await writeJson(path.join(settings.workflowDirectory, `hypit-${path.basename(dir)}.json`), gui);
    console.log(`Prepared ${dir}; ${state.frames} frames at 24 fps (${(state.frames / 24).toFixed(3)} seconds).`);
    if (command === 'prepare') return;
    const queue = await client.request('/queue');
    if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error('ComfyUI has other work queued; try again after it finishes');
    await writeJson(path.join(dir, 'job.json'), { ...state, status: 'submitting' });
    const receipt = await client.submit(graph, gui);
    if (!receipt.prompt_id || Object.keys(receipt.node_errors ?? {}).length) throw new Error(`Rejected workflow: ${JSON.stringify(receipt)}`);
    Object.assign(state, { status: 'submitted', promptId: receipt.prompt_id });
    await writeJson(path.join(dir, 'job.json'), state);
    console.log(`Submitted ${receipt.prompt_id}\nResume: node bin/local-video.mjs resume "${path.join(dir, 'job.json')}"`);
    return finish(client, state, dir, settings);
  }
  console.log('Local Video Bridge\n\n  doctor                 Check live nodes and model filenames\n  prepare <brief.json>   Save API + editable GUI workflows without generation\n  run <brief.json>       Generate locally and export a Hypit composition\n  resume <job.json>      Reconnect to a submitted job without regenerating\n\nConfig: config.local.json; overrides: COMFY_HOST, LOCAL_VIDEO_CONFIG');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
