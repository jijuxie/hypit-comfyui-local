import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { readJson, writeJson } from '../src/comfy.mjs';

// Machine-specific absolute paths belong only to an ignored local profile.
await Promise.all([ffmpeg, ffprobe.path].map(file => access(file, constants.X_OK)));
const profile = await readJson('hypit.runtime.json');
for (const endpoint of Object.values(profile.endpoints)) {
  Object.assign(endpoint.config, { ffmpegPath: ffmpeg, ffprobePath: ffprobe.path });
}
if (process.env.HYPIT_CHROME_PATH) profile.endpoints['hyperframes.local'].config.chromePath = path.resolve(process.env.HYPIT_CHROME_PATH);
await writeJson('hypit.runtime.local.json', profile);
console.log('Created hypit.runtime.local.json. Next:\n  npm run hypit -- runtime use hypit.runtime.local.json\n  npm run hypit -- runtime up');
