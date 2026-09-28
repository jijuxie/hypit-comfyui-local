import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID, createHash } from 'node:crypto';

export const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}
export function frameCount(seconds) {
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 15) throw new Error('duration must be between 5 and 15 seconds');
  const frames = Math.round(seconds * 24);
  return frames + ((5 - frames % 17 + 17) % 17);
}
export function validateBrief(brief) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(brief.id)) throw new Error('id must use lowercase letters, digits and hyphens');
  if (typeof brief.prompt !== 'string' || !brief.prompt.trim()) throw new Error('prompt is required');
  for (const name of ['width', 'height']) {
    if (!Number.isInteger(brief[name]) || brief[name] < 256 || brief[name] > 2048 || brief[name] % 32) throw new Error(`${name} must be a multiple of 32 between 256 and 2048`);
  }
  frameCount(brief.duration);
  if (brief.steps !== undefined && ![4, 8].includes(brief.steps)) throw new Error('This preset supports 4 or 8 Turbo steps');
  if (brief.seed !== undefined && (!Number.isSafeInteger(brief.seed) || brief.seed < 0)) throw new Error('seed must be a nonnegative safe integer');
  return brief;
}
export function createGraph(brief, config = {}) {
  validateBrief(brief);
  const models = config.models ?? {};
  const steps = brief.steps ?? 8;
  const seed = brief.seed ?? randomInt(0, 2 ** 48 - 1);
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    '1': node('UNETLoader', { unet_name: models.diffusion ?? 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: models.textEncoder ?? 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' }),
    '3': node('VAELoader', { vae_name: models.videoVae ?? 'minimax_h3_video_vae_fp16.safetensors' }),
    '4': node('VAELoader', { vae_name: models.audioVae ?? 'minimax_h3_audio_vae_fp32.safetensors' }),
    '5': node('LoraLoaderModelOnly', { model: ['1', 0], lora_name: models[`turbo${steps}`] ?? (steps === 8 ? 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' : 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'), strength_model: 1 }),
    '6': node('MiniMaxH3ImageToVideo', { clip: ['2', 0], vae: ['3', 0], prompt: brief.prompt, width: brief.width, height: brief.height, length: frameCount(brief.duration) }),
    '7': node('RandomNoise', { noise_seed: seed }),
    '8': node('KSamplerSelect', { sampler_name: 'res_multistep' }),
    '9': node('BasicScheduler', { model: ['5', 0], scheduler: 'simple', steps, denoise: 1 }),
    '10': node('BasicGuider', { model: ['5', 0], conditioning: ['6', 0] }),
    '11': node('SamplerCustomAdvanced', { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['6', 1] }),
    '12': node('VAEDecode', { samples: ['11', 0], vae: ['3', 0] }),
    '13': node('VAEDecodeAudio', { samples: ['11', 0], vae: ['4', 0] }),
    '14': node('CreateVideo', { images: ['12', 0], audio: ['13', 0], fps: 24 }),
    '15': node('SaveVideo', { video: ['14', 0], filename_prefix: `hypit-local/${brief.id}`, format: 'auto', codec: 'auto' }),
  };
  if (brief.firstFrame) {
    graph['16'] = node('LoadImage', { image: brief.firstFrame });
    graph['6'].inputs.first_frame = ['16', 0];
  }
  return graph;
}
export function validateGraph(graph, info) {
  for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type];
    if (!schema) throw new Error(`Missing ComfyUI node: ${node.class_type}`);
    const inputs = { ...schema.input.required, ...schema.input.optional };
    for (const required of Object.keys(schema.input.required ?? {})) {
      if (!(required in node.inputs)) throw new Error(`${id}.${required} is required`);
    }
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!inputs[key]) throw new Error(`Unknown input ${node.class_type}.${key}`);
      const [kind, options] = inputs[key];
      if (Array.isArray(value)) {
        const source = graph[value[0]];
        const output = source && info[source.class_type]?.output[value[1]];
        if (!output || output !== kind) throw new Error(`Invalid connection ${id}.${key}`);
      } else {
        const choices = Array.isArray(kind) ? kind : kind === 'COMBO' ? options?.options : undefined;
        if (choices && !choices.includes(value)) throw new Error(`Unavailable value for ${node.class_type}.${key}: ${value}`);
      }
    }
  }
}
export function guiGraph(graph, info) {
  const links = [];
  const depths = new Map();
  function depth(id, visiting = new Set()) {
    if (depths.has(id)) return depths.get(id);
    if (visiting.has(id)) throw new Error('Workflow contains a cycle');
    const next = new Set([...visiting, id]);
    const dependencies = Object.values(graph[id].inputs).filter(Array.isArray);
    const result = dependencies.length ? 1 + Math.max(...dependencies.map(v => depth(v[0], next))) : 0;
    depths.set(id, result); return result;
  }
  const cursors = {};
  const nodes = Object.entries(graph).map(([id, node], order) => {
    const schema = info[node.class_type];
    const slots = { ...schema.input.required, ...schema.input.optional };
    const widgets = [];
    const inputs = [];
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) {
        const linkId = links.length + 1;
        links.push([linkId, Number(value[0]), value[1], Number(id), inputs.length, slots[name][0]]);
        inputs.push({ name, type: slots[name][0], link: linkId });
      } else {
        widgets.push(value);
        if (slots[name]?.[1]?.control_after_generate) widgets.push('fixed');
      }
    }
    const column = depth(id), height = node.class_type === 'MiniMaxH3ImageToVideo' ? 420 : Math.max(180, widgets.length * 32 + 90);
    const y = cursors[column] ?? 70; cursors[column] = y + height + 80;
    return { id: Number(id), type: node.class_type, pos: [column * 470, y], size: [390, height], flags: {}, order, mode: 0, inputs,
      outputs: schema.output.map((type, slot) => ({ name: schema.output_name?.[slot] ?? type, type, links: [] })),
      properties: { 'Node name for S&R': node.class_type }, widgets_values: widgets };
  });
  for (const [link, source, slot] of links) nodes.find(n => n.id === source).outputs[slot].links.push(link);
  return { id: randomUUID(), revision: 0, last_node_id: Math.max(...nodes.map(n => n.id)), last_link_id: links.length, nodes, links, groups: [], config: {}, extra: { ds: { scale: 0.6, offset: [70, 30] } }, version: 0.4 };
}

export class ComfyClient {
  constructor(host = 'http://127.0.0.1:8188') {
    const url = new URL(host);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid ComfyUI host');
    this.host = host.replace(/\/$/, '');
  }
  async request(route, init = {}) {
    const response = await fetch(this.host + route, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`ComfyUI ${route}: HTTP ${response.status} ${(await response.text()).slice(0, 2000)}`);
    return response.json();
  }
  async submit(graph, gui) {
    return this.request('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: randomUUID(), extra_data: { extra_pnginfo: { workflow: gui } } }) });
  }
  async wait(id, { timeoutMs = 7_200_000, intervalMs = 5000, onProgress = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await this.request(`/history/${encodeURIComponent(id)}`);
      const result = history[id];
      if (result?.status?.status_str === 'error') throw new Error(`ComfyUI generation failed: ${JSON.stringify(result.status.messages)}`);
      if (result?.status?.completed) return result;
      onProgress(id);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for ${id}. The server may still be running it. Resume this job; do not resubmit.`);
  }
  async downloadVideo(history, target) {
    const files = Object.values(history.outputs ?? {}).flatMap(out => [...(out.images ?? []), ...(out.gifs ?? []), ...(out.videos ?? [])]);
    const file = files.find(file => /\.(mp4|webm|mkv)$/i.test(file.filename) && file.type === 'output');
    if (!file) throw new Error('Completed workflow has no saved video output');
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: 'output' });
    const response = await fetch(`${this.host}/view?${query}`, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Video download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Video download was empty');
    // Keep the actual container extension; Hypit accepts all three supported containers.
    const destination = target.replace(/\.[^.]+$/, path.extname(file.filename).toLowerCase());
    await writeFile(`${destination}.part`, bytes);
    await rename(`${destination}.part`, destination);
    return { path: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
