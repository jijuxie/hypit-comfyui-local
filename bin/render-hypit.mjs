import { spawn } from 'node:child_process';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { readJson, writeJson } from '../src/comfy.mjs';

const directory = process.argv[2];
if (!directory) {
  console.error('Usage: npm run render -- "output/<job>"');
  process.exit(1);
}
const job = path.resolve(directory);
const source = path.join(job, 'hypit', 'build.svrun');
const cli = path.resolve('node_modules/@hypit/hypit/bin/hypit.mjs');
async function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`Hypit exited with ${code}: ${stdout}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Unexpected Hypit response: ${stdout}`)); }
    });
  });
}
try {
  await access(source);
  const result = process.argv.includes('--export')
    ? await readJson(path.join(job, 'hypit-build.json'))
    : await invoke(['build', source, '--follow']);
  // Save the durable Hypit receipt before exporting. A failed export can be retried with `hypit get`.
  await writeJson(path.join(job, 'hypit-build.json'), result);
  if (result.build?.work?.outcome !== 'complete') throw new Error('Hypit build did not complete; inspect hypit-build.json');
  let destination = path.join(job, 'final.mp4');
  try { await access(destination); destination = path.join(job, `final-${result.build.id}.mp4`); } catch { /* The first export uses final.mp4. */ }
  await invoke(['get', result.build.id, '--output', 'final.video', '--to', destination]);
  console.log(`Exported ${destination}\nBuild: ${result.build.id}`);
} catch (error) {
  console.error(error.message);
  console.error('Generated source media is unchanged. Use `npm run hypit -- builds` to inspect durable builds.');
  process.exitCode = 1;
}
