import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function exportComposition(directory, video, brief, frames) {
  await mkdir(directory, { recursive: true });
  const relative = path.relative(directory, video).split(path.sep).join('/');
  const relativeVideo = relative.startsWith('.') ? relative : `./${relative}`;
  const source = `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="asset" from="@hypit/media@1"/>
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="spatial" from="@hypit/spatial@1"/>
  <import as="media" from="@hypit/media-track@1"/>
  <import as="audio" from="@hypit/audio-track@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="look" source="./look.svs"/>
  <asset:Video id="clip" src="${xml(relativeVideo)}"/>
  <time:Clock id="clock" frame-rate="24"/>
  <time:Timeline id="program" clock={clock} end="${frames}f"/>
  <spatial:Canvas id="canvas" width="${brief.width}" height="${brief.height}"/>
  <spatial:Frame id="full" within={canvas} left="0px" top="0px" right="100%" bottom="100%"/>
  <pipeline:Normalize id="footage" source={clip} video="primary-moving" audio="default" span-authority="video" clock={clock}/>
  <media:Track id="picture" timeline={program.timeline} canvas={canvas}>
    <media:Item id="cafe" media={footage.media} frame={full} during="program" appearance={look.media.full}/>
  </media:Track>
  <audio:Track id="native-sound" timeline={program.timeline}>
    <audio:Item source={footage.media} during="program" playback="once" gain="1"/>
  </audio:Track>
  <film:Film id="main" canvas={canvas} timeline={program.timeline} appearance={look.film.main}>
    <film:Track source={picture.visual}/>
    <film:Track source={native-sound.audio}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={program.timeline}/>
</svml>
`;
  await writeFile(path.join(directory, 'main.svml'), source);
  await writeFile(path.join(directory, 'look.svs'), `<?svml using="@hypit/svs@1"?>\n<sheet version="1">\nfilm.main { background: #101918; }\nmedia.full { stack-order: 1; fit: contain; playback: once-start; }\n</sheet>\n`);
  await writeFile(path.join(directory, 'build.svrun'), `<?svml using="@hypit/run-markup@1"?>\n<svrun version="1">\n  <author source="./main.svml"/>\n  <target output="final.video"/>\n</svrun>\n`);
  return path.join(directory, 'build.svrun');
}
