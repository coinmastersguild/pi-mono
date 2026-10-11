import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  stdin: {
    resolveDir: root,
    contents: `
import { PioneerIntroScene, PIONEER_INTRO_DURATION_MS, pioneerAsciiCell } from './packages/coding-agent/src/modes/interactive/components/pioneer-intro-scene.ts';
const scene = new PioneerIntroScene();
const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const raster = document.createElement('canvas');
const rasterCtx = raster.getContext('2d');
const scrubber = document.querySelector('#time');
const play = document.querySelector('#play');
const mode = document.querySelector('#mode');
const size = document.querySelector('#size');
let elapsed = 0, running = true, previous = performance.now(), lastDraw = -100;
function draw() {
  const [width, rows] = size.value.split('x').map(Number);
  const frame = scene.render(width, rows - 8, elapsed);
  canvas.width = width * 8; canvas.height = frame.height * 8;
  if (mode.value === 'pixel') {
    raster.width = width; raster.height = frame.height;
    const data = rasterCtx.createImageData(width, frame.height);
    frame.pixels.forEach((p,i) => {data.data[i*4]=p>>16;data.data[i*4+1]=(p>>8)&255;data.data[i*4+2]=p&255;data.data[i*4+3]=255;});
    rasterCtx.putImageData(data,0,0);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(raster,0,0,canvas.width,canvas.height);
  } else {
    ctx.fillStyle='#080e20';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.font='14px monospace'; ctx.textBaseline='top';
    for(let y=0;y<frame.height;y+=2) for(let x=0;x<width;x++) {
      const a=frame.pixels[y*width+x], b=frame.pixels[(y+1)*width+x];
      const cell=pioneerAsciiCell(a,b);
      ctx.fillStyle='#'+cell.color.toString(16).padStart(6,'0');
      ctx.fillText(cell.glyph,x*8,y*8);
    }
  }
  scrubber.value=elapsed;
  document.querySelector('#stamp').textContent=(elapsed/1000).toFixed(1)+' / 9.0 s';
}
play.onclick=()=>{running=!running; if(running&&elapsed>=PIONEER_INTRO_DURATION_MS)elapsed=0;play.textContent=running?'Pause':'Play';};
document.querySelector('#replay').onclick=()=>{elapsed=0;running=true;play.textContent='Pause';};
scrubber.oninput=()=>{elapsed=Number(scrubber.value);running=false;play.textContent='Play';draw();};
mode.onchange=draw;size.onchange=draw;
function tick(now){
  if(running)elapsed=Math.min(PIONEER_INTRO_DURATION_MS,elapsed+now-previous);
  previous=now;
  if(now-lastDraw>66){draw();lastDraw=now;}
  if(elapsed>=PIONEER_INTRO_DURATION_MS){running=false;play.textContent='Play';}
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
`,
  },
  bundle: true, write: false, format: "iife", platform: "browser",
});
const directory = new URL("../output/pioneer-intro/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("index.html", directory), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pioneer — Follow your own path</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#050910;color:#b7c6d8;font:14px ui-monospace,SFMono-Regular,monospace}main{max-width:1200px;margin:36px auto;padding:0 28px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}small{color:#668197;letter-spacing:2px}a{color:#65cbaa;text-decoration:none}h1{font-size:15px;color:#e0e9f3;font-weight:500;letter-spacing:3px}section{border:1px solid #213146;border-radius:12px;overflow:hidden;background:#080e20;box-shadow:0 24px 100px #0008}canvas{display:block;width:100%;image-rendering:pixelated}.wordmark{text-align:center;color:#42dc7e;font-size:clamp(22px,5vw,60px);font-weight:900;letter-spacing:.25em;padding:20px 0 4px;text-shadow:0 0 25px #42dc7e33}.tagline{text-align:center;letter-spacing:3px;color:#799788;padding:0 10px 26px;font-size:11px}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:16px;border-top:1px solid #213146;background:#0c1421}button,select{font:inherit;color:#b7c6d8;background:#122234;border:1px solid #294158;border-radius:5px;padding:8px 12px;cursor:pointer}button:hover{border-color:#42dc7e}input{flex:1;min-width:100px;accent-color:#42dc7e}footer{display:flex;gap:24px;justify-content:space-between;margin:22px 0;color:#61778f;font-size:12px}code{color:#c4d7c7}
</style>
<main><header><h1>PIONEER / TRAIL INTRO</h1><small>3D TERMINAL STUDY · 01</small></header>
<section><canvas aria-label="Animated three dimensional alpine trail and sparkling Bitcoin emblem"></canvas><div class="wordmark">PIONEER</div><div class="tagline">FOLLOW YOUR OWN PATH</div>
<div class="controls"><button id="replay">Replay</button><button id="play">Pause</button><select id="mode" aria-label="Rendering style"><option value="ascii">ASCII</option><option value="pixel">Half-block</option></select><select id="size" aria-label="Terminal size"><option>160x50</option><option>120x40</option><option>80x24</option></select><input id="time" aria-label="Animation time" type="range" min="0" max="9000" step="1"><span id="stamp"></span></div></section>
<footer><span>CLI: <code>/intro</code> · <code>/intro ascii</code> · launch with <code>--no-intro</code> to skip</span><span><a href="../imagegen/pioneer-night-expedition-v1.png">Art reference</a> · <a href="https://github.com/tweakyourpc/vertex-city">Vertex City</a></span></footer></main>
<script>${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`);
console.log(fileURLToPath(new URL("index.html", directory)));
