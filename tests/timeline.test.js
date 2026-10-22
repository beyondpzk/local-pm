const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/项目进度时间轴_可编辑.html'), 'utf8');
function functionSource(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
function canvas() {
  const context = vm.createContext({saveQueue:null,data:{view:{w:1385,h:1020},lanes:[],nodes:[],texts:[],arrows:[]}});
  vm.runInContext(functionSource('curveControl','arrowPath') + functionSource('ensureCanvasHeight','safeSave'), context);
  return context;
}
test('whiteboard retains its size until content needs more room, then never shrinks automatically', () => {
  const c = canvas();
  c.data.nodes.push({y:900});c.ensureCanvasHeight();assert.equal(c.data.view.h,1020);
  c.data.nodes[0].y=1500;c.ensureCanvasHeight();assert.ok(c.data.view.h>1600);
  const extended=c.data.view.h;c.data.nodes=[];c.ensureCanvasHeight();assert.equal(c.data.view.h,extended);
});
test('multiline text and lane names fit entirely on the extended whiteboard', () => {
  for(const kind of ['texts','lanes']) {
    const c=canvas();
    c.data[kind].push({y:950,text:'one\ntwo\nthree\nfour',fontSize:50,name:'one\ntwo\nthree\nfour'});
    c.ensureCanvasHeight();assert.ok(c.data.view.h>1020);
    if(kind==='texts')assert.ok(c.data.view.h>950+3*74+20);
  }
});
test('arrow endpoints and curved control points extend the whiteboard', () => {
  const c=canvas();c.data.arrows.push({points:[{x:0,y:500},{x:300,y:1600}]});
  c.ensureCanvasHeight();assert.ok(c.data.view.h>1700);
  const curved=canvas();curved.data.arrows.push({style:'curve',points:[{x:0,y:950},{x:1000,y:950}]});
  curved.ensureCanvasHeight();assert.ok(curved.data.view.h>1040);
});
test('saving and fitting include out-of-bounds content without changing its coordinates', () => {
  const c=canvas();let saved;
  Object.assign(c,{storageKey:'test',localStorage:{setItem:(key,value)=>saved=JSON.parse(value)},render:()=>{}});
  vm.runInContext(functionSource('safeSave','snapshot')+functionSource('fit','zoom'),c);
  c.data.nodes.push({x:300,y:2400});c.safeSave();assert.ok(saved.view.h>2400);
  c.fit();assert.equal(c.view.h,saved.view.h);assert.equal(c.data.nodes[0].y,2400);
});
test('edge panning uses SVG scale, stops outside the canvas, and ignores normal pan gestures', () => {
  const c=canvas();let scheduled=0,moved=0;
  Object.assign(c,{drag:{mode:'object'},dragPointer:{clientX:100,clientY:600},view:{x:0,y:0,w:1000,h:1000},autoPanFrame:null,autoPanTime:0,
    stage:{getBoundingClientRect:()=>({left:0,right:800,top:100,bottom:600}),getScreenCTM:()=>({d:.5}),setAttribute:()=>{}},
    moveDrag:()=>moved++,requestAnimationFrame:()=>++scheduled});
  vm.runInContext(source.slice(source.indexOf('function edgePanSpeed('),source.indexOf("stage.addEventListener('pointermove'")),c);
  assert.equal(c.edgePanSpeed(),1);c.autoPan(100);assert.equal(c.view.y,16);assert.equal(moved,1);
  c.dragPointer.clientX=900;c.autoPan(116);assert.equal(scheduled,1);
  c.dragPointer.clientX=100;c.drag.mode='pan';assert.equal(c.edgePanSpeed(),0);
  c.drag.mode='lane-move';c.dragPointer.clientY=100;assert.equal(c.edgePanSpeed(),-1);
});
test('whiteboard follows downward panning even with no new content, without enlarging exports', () => {
  const c=canvas();
  let screen={d:1,f:-600};
  Object.assign(c,{view:{y:600,h:800},stage:{getBoundingClientRect:()=>({bottom:1000}),getScreenCTM:()=>screen}});
  vm.runInContext(functionSource('canvasBottom','renderBase'),c);
  assert.ok(c.canvasBottom()>1600);
  screen={d:.5,f:-600};
  assert.ok(c.canvasBottom()>3200,'include zoom and SVG letterboxing');
  assert.equal(c.canvasBottom(true),1005,'export retains content height');
  assert.equal(c.data.view.h,1020,'panning must not enlarge saved content or fit bounds');
});
