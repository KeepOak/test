/* Original Branch models, MIT as LICENSE. Pets extrude Branch's own PIXEL sprites;
   oak boxes are authored here. No remote assets, glTF resources or generation service. */
import { PIXEL, pixelCanvas } from "./pets.js";
import { afterDraw } from "./dom.js";

let style = "3d";
export const visualStyle = () => style;
export function setVisualStyle(value) { style = value === "3d" ? "3d" : "pixel"; }
export function voxelPet(kind, attrs = "") {
  const own = /class="/.test(attrs) ? attrs.replace('class="', 'class="voxel-pet ') : `class="voxel-pet" ${attrs}`;
  return `<span ${own}><span class="voxel-fallback">${pixelCanvas(kind, 'aria-hidden="true"')}</span><canvas data-voxel="${kind}" width="96" height="80" aria-hidden="true"></canvas></span>`;
}
const oak = () => [
  [0, -3, 0, 2, 8, 2, "#795338"], [-2, 0, 0, 4, 1, 1, "#795338"],
  [2, 1, 0, 4, 1, 1, "#795338"], [0, 3, 0, 9, 4, 6, "#487745"],
  [-3, 2, 1, 5, 4, 5, "#639454"], [3, 3, -1, 5, 4, 5, "#365F3C"],
  [0, 5, 0, 6, 3, 5, "#77A260"], [0, -7, 0, 13, 1, 9, "#536B40"],
];
function model(kind) {
  if (kind === "oak") return oak();
  const pet = PIXEL[kind]; if (!pet) return [];
  return pet.px.flatMap((row, y) => [...row].flatMap((ch, x) => pet.col[ch] ? [[x - 5.5, 4.5 - y, 0, .95, .95, 2, pet.col[ch]]] : []));
}
const faces = [
  [[0,0,1], [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
  [[0,0,-1], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
  [[1,0,0], [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],
  [[-1,0,0], [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],
  [[0,1,0], [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],
  [[0,-1,0], [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]],
];
function vertices(kind) {
  const out = [];
  for (const [x,y,z,w,h,d,hex] of model(kind)) {
    const rgb = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255);
    for (const [normal, corners] of faces) for (const i of [0,1,2,0,2,3]) {
      const point = corners[i], shade = .7 + normal[1]*.2 + normal[0]*.1;
      out.push(x+point[0]*w/2, y+point[1]*h/2, z+point[2]*d/2, ...rgb.map(c=>c*shade));
    }
  }
  return new Float32Array(out);
}
function shader(gl, type, source) {
  const result = gl.createShader(type); if (!result) throw new Error("Shader unavailable");
  gl.shaderSource(result, source); gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) { gl.deleteShader(result); throw new Error("Shader unavailable"); }
  return result;
}
/* Static orthographic 3D: depth tested triangles, bounded pixel size, no frame loop.
   Existing pet walker moves the whole model. Reduced motion adds no model movement. */
export function drawVoxel(canvas, kind = canvas.dataset.voxel) {
  if (canvas.dataset.voxelReady) return canvas.dataset.voxelReady === "yes";
  canvas.dataset.voxelReady = "no";
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return false;
  let program, buffer, vs, fs;
  try {
    vs = shader(gl, gl.VERTEX_SHADER, "attribute vec3 p; attribute vec3 c; varying vec3 color; void main(){ float a=.45; vec3 q=vec3(p.x*cos(a)+p.z*sin(a),p.y,-p.x*sin(a)+p.z*cos(a)); gl_Position=vec4(q.x/10.,(q.y*.94-q.z*.34)/10.,(q.y*.34+q.z*.94)/24.,1.); color=c; }");
    fs = shader(gl, gl.FRAGMENT_SHADER, "precision mediump float; varying vec3 color; void main(){gl_FragColor=vec4(color,1.);}");
    program = gl.createProgram(); buffer = gl.createBuffer();
    if (!program || !buffer) throw new Error("Renderer unavailable");
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Renderer unavailable");
    const data = vertices(kind); gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [name, offset] of [["p",0],["c",12]]) { const attr = gl.getAttribLocation(program,name); gl.enableVertexAttribArray(attr); gl.vertexAttribPointer(attr,3,gl.FLOAT,false,24,offset); }
    gl.viewport(0,0,canvas.width,canvas.height); gl.enable(gl.DEPTH_TEST); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES,0,data.length/6);
    const image = document.createElement("img");
    image.src = canvas.toDataURL("image/png"); image.alt = ""; image.setAttribute("aria-hidden", "true"); image.className = canvas.className;
    canvas.parentElement?.classList.add("voxel-ready"); canvas.replaceWith(image);
    return true;
  } catch { return false; }
  finally { if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); if (vs) gl.deleteShader(vs); if (fs) gl.deleteShader(fs); gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}
afterDraw(() => {
  /* Only the selected pet's small render plus bounded gallery slots. No context pool. */
  [...document.querySelectorAll("canvas[data-voxel]")].slice(0, 8).forEach(canvas => drawVoxel(canvas));
});
