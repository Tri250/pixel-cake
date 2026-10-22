const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { removeTemporaryDirectory } = require('./helpers/temp-cleanup');

const root = path.resolve(process.env.BOO_PAK_RUNTIME_ROOT || path.join(__dirname, '..'));

function browserCandidates() {
  return [...new Set([
    process.env.BOO_BROWSER_EXECUTABLE,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(candidate => candidate && fs.existsSync(candidate)).map(candidate => path.resolve(candidate)))];
}

function decodeAttribute(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function scenarioScript() {
  return `<script>
(async function(){
  var results=[];
  if(typeof clearOriginalStaticChunkCache!=='function')window.clearOriginalStaticChunkCache=function(){};
  function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
  function send(data){window.dispatchEvent(new MessageEvent('message',{data:data}))}
  function check(value,message){if(!value)throw new Error(message)}
  function mapData(){return{
    map:{key:'viewport-map',mapId:'viewport-map',originalMapId:'viewport-map',name:'viewport-map',width:128,height:64},
    maps:[],markers:[],npcs:[],spawns:[],safeZones:[],merchantColumns:[],monGenColumns:[],
    engine:'GOM',entityWarnings:[],markerFile:'',warning:'',imageUrl:''
  }}
  function reset(){
    updateMap(mapData());window.__viewportPosted.length=0;switchToOriginalMap();
    var load=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMap'});
    check(load,'original map load request was not posted');return load;
  }
  function ready(load,chunkWidth,chunkHeight){
    send({type:'originalMapReady',requestId:load.requestId,generation:101,
      fileName:'viewport-map.map',format:'classic-14',width:128,height:64,
      pixelWidth:128*48,pixelHeight:64*32,chunkCellWidth:chunkWidth,chunkCellHeight:chunkHeight});
    var requests=window.__viewportPosted.filter(function(item){return item.type==='loadOriginalMapViewport'});
    check(requests.length>0,'Ready did not trigger an initial viewport request: '+JSON.stringify({
      load:load,active:state.original.active,requestId:state.original.requestId,
      generation:state.original.generation,lastViewportKey:state.original.lastViewportKey,
      posted:window.__viewportPosted
    }));
    return requests[requests.length-1];
  }
  function viewportData(request){return{
    type:'originalMapViewportData',requestId:request.requestId,generation:request.generation,
    viewportSeq:request.viewportSeq,viewport:request.viewport,prefetch:false,
    resources:[],tiles:[],smTiles:[],objects:[],objectAnimationFrames:[],objectAnimationTicks:[],
    objectAnimationSetIds:[],objectAnimationSets:[],permanentMapEffects:[],permanentMapEffectSets:[],
    animatedObjectCount:0,permanentMapEffectCount:0,warning:''
  }}
  async function loaded(chunkWidth,chunkHeight){
    var load=reset(),request=ready(load,chunkWidth,chunkHeight);send(viewportData(request));await wait(20);
    check(state.original.ready&&state.original.layer,'initial viewport data was not applied');
    return{load:load,request:request,layer:state.original.layer};
  }
  function appliedKey(){
    return state.original.appliedViewportKey!==undefined
      ?state.original.appliedViewportKey:state.original.lastViewportKey;
  }
  function lastVisibleRequest(){
    var requests=window.__viewportPosted.filter(function(item){
      return item.type==='loadOriginalMapViewport'&&!item.prefetch;
    });
    return requests[requests.length-1];
  }
  function checkPointGeometry(point,message){
    var worldX=point.x*48+24,worldY=point.y*32;
    var expectedX=state.worldW<=viewport.clientWidth
      ?Math.round((viewport.clientWidth-state.worldW)/2)
      :Math.round(Math.min(0,Math.max(viewport.clientWidth-state.worldW,viewport.clientWidth/2-worldX)));
    var expectedY=state.worldH<=viewport.clientHeight
      ?Math.round((viewport.clientHeight-state.worldH)/2)
      :Math.round(Math.min(0,Math.max(viewport.clientHeight-state.worldH,viewport.clientHeight/2-worldY)));
    check(state.scale===1,message+': map was not shown at 100%');
    check(state.offsetX===expectedX&&state.offsetY===expectedY,message+': wrong world-to-viewport geometry '+JSON.stringify({
      x:state.offsetX,y:state.offsetY,expectedX:expectedX,expectedY:expectedY,width:viewport.clientWidth,height:viewport.clientHeight
    }));
    var rect=canvas.getBoundingClientRect(),screenX=state.offsetX+worldX,screenY=state.offsetY+worldY;
    check(rect.width>0&&rect.height>0&&screenX>=0&&screenX<=rect.width&&screenY>=0&&screenY<=rect.height,
      message+': target did not land inside the real canvas bounds');
  }
  function checkRequestContainsPoint(request,point,message){
    check(request&&request.viewport,message+': no scoped viewport request');
    var area=request.viewport;
    check(area.left<=point.x&&area.right>=point.x&&area.top<=point.y&&area.bottom>=point.y,
      message+': requested viewport omitted target '+JSON.stringify({point:point,viewport:area}));
    check((area.right-area.left+1)*(area.bottom-area.top+1)<128*64,
      message+': point reveal requested the whole map');
  }
  function pointLoad(point,withNpcs){
    var data=mapData();data.originalMap=true;data.revealPoint=point;
    if(withNpcs)data.npcs=[
      {lineNumber:0,x:point.x,y:point.y,displayName:'同点NPC'},
      {lineNumber:8,x:point.x+1,y:point.y+1,displayName:'附近NPC'}
    ];
    window.__viewportPosted.length=0;send(Object.assign({type:'mapData'},data));
    var load=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMap'});
    check(load,'point payload did not issue an original-map load request');
    return load;
  }
  async function run(name,body){
    try{await body();results.push({name:name,status:'pass'})}
    catch(error){results.push({name:name,status:'fail',message:error&&error.stack?error.stack:String(error)})}
  }

  await run('MapInfo and MonGen payloads enter original mode through the normal load protocol',async function(){
    window.__viewportPosted.length=0;
    var data=mapData();data.originalMap=true;updateMap(data);
    check(state.original.active,'definition click remained on the miniature map');
    check(window.__viewportPosted.filter(function(item){return item.type==='loadOriginalMap'}).length===1,
      'definition payload did not issue exactly one normal original-map load request');
    check(!state.pendingNpcReveal,'map definition click invented an NPC selection');
  });

  await run('ready-map reveal command switches layers without duplicate loads while already original',async function(){
    var setup=await loaded(16,16);window.__viewportPosted.length=0;
    send({type:'revealOriginalMap'});
    check(state.original.layer===setup.layer,'reveal command discarded a valid map layer');
    check(!window.__viewportPosted.some(function(item){return item.type==='loadOriginalMap'}),
      'repeated original-map reveal restarted the loader');
    switchToPreviewMap();send({type:'revealOriginalMap'});
    check(state.original.active,'reveal command did not switch from preview back to original');
  });

  await run('MapInfo point survives actual Ready dimensions and the first visible viewport',async function(){
    var point={x:101,y:47},data=mapData();data.map.width=12;data.map.height=8;
    data.originalMap=true;data.revealPoint=point;window.__viewportPosted.length=0;
    send(Object.assign({type:'mapData'},data));
    var load=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMap'});
    check(load&&state.pendingMapPointReveal,'point was lost before Ready established the real dimensions');
    check(!state.pendingNpcReveal&&state.npcs.length===0,'generic point invented an NPC or NPC reveal');
    var request=ready(load,16,16);
    checkPointGeometry(point,'Ready point reveal');
    checkRequestContainsPoint(request,point,'first point viewport');
    check(state.pendingMapPointReveal,'point finalized before the first viewport was applied');
    send(viewportData(request));await wait(20);
    check(state.original.ready&&state.original.layer,'point viewport was not rendered');
    checkPointGeometry(point,'first applied point viewport');
    check(!state.pendingMapPointReveal,'applied point was left pending');
    check(state.selectedEntityType===''&&!entityLayer.querySelector('.selected'),
      'generic point selected a fake NPC');
  });

  await run('ready-map point reveals keep the layer and generation and clear existing NPC selection',async function(){
    var first={x:93,y:42},load=pointLoad(first,true),request=ready(load,16,16);
    send(viewportData(request));await wait(20);clearOriginalPrefetchTimer();
    var layer=state.original.layer,generation=state.original.generation,npc=state.npcs[0];
    selectEntity('npc',npc);check(state.selectedEntityType==='npc','NPC-selection fixture was not selected');
    window.__viewportPosted.length=0;
    var second={x:21,y:18};send({type:'revealOriginalMap',point:second});
    checkPointGeometry(second,'repeat ready point reveal');
    checkRequestContainsPoint(lastVisibleRequest(),second,'repeat ready point viewport');
    check(state.original.layer===layer&&state.original.generation===generation,'ready point discarded its rendered layer');
    check(!window.__viewportPosted.some(function(item){return item.type==='loadOriginalMap'}),
      'ready point reveal restarted the full-map loader');
    check(state.npcs.length===2&&state.npcs[0]===npc&&npc.x===first.x&&npc.y===first.y,
      'generic point reveal changed or invented NPC data');
    check(state.selectedEntityType===''&&state.selectedEntityLine===0&&!state.pendingNpcReveal&&
      !entityLayer.querySelector('.selected')&&!npcJumpList.querySelector('.active'),
      'generic point reused an NPC line number or retained its selection');
    clearOriginalViewportTimer();
  });

  await run('point reveal returns from preview without reloading and accepts coordinate zero',async function(){
    var setup=await loaded(16,16),layer=setup.layer,generation=state.original.generation;
    switchToPreviewMap();window.__viewportPosted.length=0;
    var point={x:91,y:40};send({type:'revealOriginalMap',point:point});
    check(state.original.active,'point reveal did not return from the miniature map');
    checkPointGeometry(point,'cached original point reveal');
    checkRequestContainsPoint(lastVisibleRequest(),point,'cached original point viewport');
    check(state.original.layer===layer&&state.original.generation===generation,'cached point reveal discarded a ready layer');
    check(!window.__viewportPosted.some(function(item){return item.type==='loadOriginalMap'}),'cached point reveal reloaded the map');
    window.__viewportPosted.length=0;
    var zero={x:0,y:0};send({type:'revealOriginalMap',point:zero});
    checkPointGeometry(zero,'zero coordinate reveal');
    checkRequestContainsPoint(lastVisibleRequest(),zero,'zero coordinate viewport');
    clearOriginalViewportTimer();clearOriginalPrefetchTimer();
  });

  await run('zoom cancels pending point so a late first viewport cannot pull the user back',async function(){
    for(var mode of ['button','wheel']){
      var load=pointLoad({x:101,y:47},false),request=ready(load,16,16);
      check(state.pendingMapPointReveal,'zoom fixture did not have a pending point');
      if(mode==='button')document.getElementById('zoomIn').click();
      else{
        var rect=viewport.getBoundingClientRect();
        viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,clientX:rect.left+120,clientY:rect.top+90,cancelable:true}));
      }
      check(!state.pendingMapPointReveal,mode+' zoom did not cancel the pending point');
      var view={scale:state.scale,x:state.offsetX,y:state.offsetY};
      send(viewportData(request));await wait(20);
      check(state.original.ready&&state.original.layer,'late zoom viewport did not finish loading');
      check(state.scale===view.scale&&state.offsetX===view.x&&state.offsetY===view.y,
        mode+' zoom was overwritten by the late first viewport');
      clearOriginalViewportTimer();clearOriginalPrefetchTimer();
    }
  });

  await run('drag cancels pending point and preserves the user position after viewport data',async function(){
    var load=pointLoad({x:101,y:47},false);ready(load,16,16);
    check(state.pendingMapPointReveal,'drag fixture did not have a pending point');
    var rect=viewport.getBoundingClientRect(),x=rect.left+220,y=rect.top+160;
    viewport.dispatchEvent(new MouseEvent('mousedown',{button:0,clientX:x,clientY:y}));
    viewport.dispatchEvent(new MouseEvent('mousemove',{buttons:1,clientX:x+73,clientY:y+41}));
    window.dispatchEvent(new MouseEvent('mouseup',{button:0,clientX:x+73,clientY:y+41}));
    check(!state.pendingMapPointReveal,'drag did not cancel the pending point');
    var view={scale:state.scale,x:state.offsetX,y:state.offsetY},request=lastVisibleRequest();
    check(request,'drag did not request the resulting viewport');
    send(viewportData(request));await wait(20);
    check(state.original.ready&&state.original.layer,'drag viewport data was not applied');
    check(state.scale===view.scale&&state.offsetX===view.x&&state.offsetY===view.y,
      'late drag viewport pulled the map back to the old point');
    clearOriginalViewportTimer();clearOriginalPrefetchTimer();
  });

  await run('new map without a point does not inherit the previous pending reveal',async function(){
    pointLoad({x:101,y:47},false);check(state.pendingMapPointReveal,'map-switch fixture had no pending point');
    var data=mapData();data.map.key='no-point-map';data.map.mapId='no-point-map';data.originalMap=true;
    window.__viewportPosted.length=0;send(Object.assign({type:'mapData'},data));
    check(!state.pendingMapPointReveal&&!state.pendingNpcReveal,'new map inherited a previous reveal target');
    var load=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMap'}),request=ready(load,16,16);
    send(viewportData(request));await wait(20);
    check(state.scale===1&&state.offsetX===Math.round((viewport.clientWidth-state.worldW)/2)&&
      state.offsetY===Math.round((viewport.clientHeight-state.worldH)/2),
      'new map without a reveal point did not retain the normal centered view');
    clearOriginalViewportTimer();clearOriginalPrefetchTimer();
  });

  await run('malformed reveal points cannot override a ready map view',async function(){
    await loaded(16,16);clearOriginalPrefetchTimer();
    var point={x:43,y:21};centerWorldPoint(point.x*48+24,point.y*32,1,false);
    var view={scale:state.scale,x:state.offsetX,y:state.offsetY},layer=state.original.layer;
    for(var invalid of [{x:'11',y:30},{x:-1,y:3},{x:2.5,y:3},{x:2,y:null},null]){
      window.__viewportPosted.length=0;send({type:'revealOriginalMap',point:invalid});
      check(state.scale===view.scale&&state.offsetX===view.x&&state.offsetY===view.y,
        'malformed point changed the ready viewport: '+JSON.stringify(invalid));
      check(!state.pendingMapPointReveal&&!state.pendingNpcReveal&&state.original.layer===layer,
        'malformed point became a pending reveal or invalidated the ready layer');
      check(!window.__viewportPosted.some(function(item){return item.type==='loadOriginalMap'}),
        'malformed point restarted the loader');
    }
    clearOriginalViewportTimer();clearOriginalPrefetchTimer();
  });

  await run('load-level error before Ready is visible',async function(){
    var load=reset();
    send({type:'originalMapError',requestId:load.requestId,generation:101,message:'pre-ready failure'});
    await wait(0);
    check(state.original.warning==='pre-ready failure','pre-Ready load error was hidden by generation gating');
    check(mapLayerToggle.disabled===false,'pre-Ready load error did not release the layer toggle');
  });

  await run('applied viewport key commits only after success',async function(){
    var load=reset(),request=ready(load,16,16),key=originalMapViewportKey(request.viewport);
    check(appliedKey()!==key,'requested viewport was marked applied before its data succeeded');
    send(viewportData(request));await wait(20);
    check(appliedKey()===key,'successful viewport data did not commit the applied key');
  });

  await run('non-square chunk width and height stay independent',async function(){
    var load=reset();ready(load,16,8);window.__viewportPosted.length=0;
    state.original.lastViewportKey='';
    state.original.pendingViewportKey='';
    if(state.original.appliedViewportKey!==undefined)state.original.appliedViewportKey='';
    centerWorldPoint(64*48,40*32,1,false);flushOriginalMapViewport();
    var request=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMapViewport'});
    check(request,'non-square viewport request was not posted');
    var scale=Math.max(.0001,Number(state.scale)||1);
    var worldTop=Math.max(0,Math.min(state.worldH,-state.offsetY/scale));
    var worldBottom=Math.max(worldTop,Math.min(state.worldH,(viewport.clientHeight-state.offsetY)/scale));
    var cellTop=Math.max(0,Math.min(63,Math.floor(worldTop/32)));
    var cellBottom=Math.max(cellTop,Math.min(63,Math.floor(Math.max(worldTop,worldBottom-1)/32)));
    var expectedTop=Math.floor(cellTop/8)*8;
    var expectedBottom=Math.min(63,(Math.floor(cellBottom/8)+1)*8-1);
    check(state.original.chunkCellHeight===8,'Ready did not retain chunkCellHeight');
    check(request.viewport.top===expectedTop&&request.viewport.bottom===expectedBottom,
      'vertical viewport bounds reused chunkCellWidth instead of chunkCellHeight');
  });

  await run('viewport error is non-fatal and the same target can retry',async function(){
    var setup=await loaded(16,16),layer=setup.layer,applied=appliedKey();
    window.__viewportPosted.length=0;state.offsetX-=32*48;render();flushOriginalMapViewport();
    var request=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMapViewport'});
    check(request,'second viewport request was not posted');
    check(appliedKey()===applied,'pending viewport replaced the applied key');
    send({type:'originalMapError',requestId:request.requestId,generation:request.generation,
      viewportSeq:request.viewportSeq,message:'viewport failure'});await wait(0);
    check(state.original.ready&&state.original.layer===layer,'viewport error destroyed the last good layer');
    var before=window.__viewportPosted.length;flushOriginalMapViewport();
    var retries=window.__viewportPosted.slice(before).filter(function(item){return item.type==='loadOriginalMapViewport'});
    check(retries.length===1&&retries[0].viewportSeq>request.viewportSeq,
      'failed viewport target could not be retried with a new sequence');
  });

  await run('navigator without MiniMap does not request the whole map',async function(){
    await loaded(16,16);state.image=null;window.__viewportPosted.length=0;
    renderMapNavigator();await wait(0);
    var loads=window.__viewportPosted.filter(function(item){
      return item.type==='loadOriginalMap'||item.type==='loadOriginalMapViewport';
    });
    check(loads.length===0,'navigator rendering triggered an original-map resource request');
  });

  await run('navigator draws readable location markers in grid coordinates without duplicate modes',async function(){
    await loaded(16,16);clearOriginalPrefetchTimer();
    var marker={x:64,y:32,displayText:'入口',text:'入口',color:'#ffff00',mode:0,lineNumber:1};
    state.markers=[marker,Object.assign({},marker,{mode:1,lineNumber:2}),
      {x:0,y:0,displayText:'边缘长文字地点标记'.repeat(6),text:'完整长文字',color:'#00ffff',mode:0},
      {x:-1,y:10,displayText:'越界',color:'#fff',mode:0}];
    var calls=[],fill=mapNavigatorContext.fillText;
    mapNavigatorContext.fillText=function(text,x,y){calls.push({text:text,x:x,y:y,color:this.fillStyle});return fill.apply(this,arguments)};
    renderMapNavigator();mapNavigatorContext.fillText=fill;
    check(calls.filter(function(c){return c.text==='入口'}).length===1,'location text absent or duplicated across large/small map modes');
    var g=state.navigatorGeometry,center=calls.find(function(c){return c.text==='入口'});
    check(Math.abs(center.x-(g.left+64*48*g.scale))<1,'grid X was not converted through original-map cell width');
    check(center.color==='#ffff00','marker color was lost');
    check(calls.every(function(c){return c.text!=='越界'}),'out-of-bounds marker was drawn');
    check(state.navigatorMarkers.length===2,'valid unique labels not retained for hover');
    check(state.navigatorMarkers.every(function(box){return box.left>=g.left&&box.right<=g.left+g.mapWidth&&box.top>=g.top&&box.bottom<=g.top+g.mapHeight}),'edge label is clipped outside map');
    var before=mapNavigatorCanvas.toDataURL();state.markers=[];renderMapNavigator();
    check(before!==mapNavigatorCanvas.toDataURL(),'marker text was not painted to the actual Canvas');
    state.markers=[marker];renderMapNavigator();
    var box=state.navigatorMarkers[0],rect=mapNavigatorOverlay.getBoundingClientRect();
    mapNavigatorOverlay.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+(box.left+box.right)/2,clientY:rect.top+(box.top+box.bottom)/2}));
    check(mapNavigatorOverlay.title.indexOf('入口')>=0,'hover does not reveal location text');
    var next=mapData();next.map.mapId='next-map';next.markers=[];updateMap(next);
    check(mapNavigator.hidden&&state.navigatorMarkers.length===0&&mapNavigatorOverlay.title==='','map switch retains old marker or hover');
  });

  await run('ready layer survives preview round trip',async function(){
    var setup=await loaded(16,16);
    var generation=state.original.generation;
    var layer=state.original.layer;
    var previousSeq=state.original.viewportSeq;

    reset100();
    var target=computeOriginalMapViewport();
    var targetKey=originalMapViewportKey(target);
    state.original.lastViewportKey='0:0:15:15';
    state.original.pendingViewportKey=targetKey;

    window.__viewportPosted.length=0;
    switchToPreviewMap();

    check(!window.__viewportPosted.some(function(item){return item.type==='cancelOriginalMap'}),
      'ready layer preview switch sent cancelOriginalMap');
    check(state.original.generation===generation,'ready preview switch cleared generation');
    check(state.original.layer===layer,'ready preview switch cleared layer');

    switchToOriginalMap();

    var request=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMapViewport'});
    check(request,'cached original-map return did not request the current region');
    check(request.generation===generation,'cached return changed generation');
    check(request.viewportSeq>previousSeq,'cached return did not advance viewportSeq');
    check(state.original.layer===layer,'cached return replaced the ready layer before data arrived');
    check(state.original.pendingViewportKey===originalMapViewportKey(request.viewport),
      'stale pending key was not replaced by the current request');
  });

  await run('unfinished first viewport cancels and reloads',async function(){
    var load=reset();
    ready(load,16,16);

    check(state.original.generation===101,'Ready generation was not installed');
    check(!state.original.ready&&!state.original.layer,'scenario unexpectedly became ready');

    var requestIdBefore=state.original.requestId;
    window.__viewportPosted.length=0;
    switchToPreviewMap();

    var cancel=window.__viewportPosted.find(function(item){return item.type==='cancelOriginalMap'});
    check(cancel,'unfinished first viewport did not send cancelOriginalMap');
    check(cancel.requestId===requestIdBefore,'cancel requestId changed');
    check(cancel.generation===101,'cancel generation changed');
    check(state.original.generation===0,'unfinished switch did not clear generation');
    check(state.original.layer===null,'unfinished switch retained layer');

    window.__viewportPosted.length=0;
    switchToOriginalMap();

    var reload=window.__viewportPosted.find(function(item){return item.type==='loadOriginalMap'});
    check(reload,'return after unfinished cancellation did not reload original map');
    check(reload.requestId>requestIdBefore,'reload did not advance requestId');
  });

  await run('first visible viewport is followed by bounded neighbor prefetch',async function(){
    var setup=await loaded(16,16),layer=setup.layer,sequence=state.original.viewportSeq;
    window.__viewportPosted.length=0;
    await wait(650);
    var requests=window.__viewportPosted.filter(function(item){
      return item.type==='loadOriginalMapViewport'&&item.prefetch===true;
    });
    check(requests.length===1,'successful visible viewport did not schedule exactly one neighbor prefetch');
    check(requests[0].viewportSeq>sequence,'neighbor prefetch did not advance viewportSeq');
    check(state.original.layer===layer,'neighbor prefetch cleared the visible layer before data arrived');
    var target=requests[0].viewport,expanded=expandedOriginalMapViewport(target);
    check(expanded,'neighbor prefetch exceeded the 36-chunk safety budget');
    var width=Math.floor(expanded.right/16)-Math.floor(expanded.left/16)+1;
    var height=Math.floor(expanded.bottom/16)-Math.floor(expanded.top/16)+1;
    check(width*height<=36,'neighbor prefetch expanded beyond 36 chunks');

    check(renderProgress.hidden===true,'first viewport progress overlay did not finish before prefetch');
    send({type:'originalMapProgress',requestId:requests[0].requestId,
      generation:requests[0].generation,viewportSeq:requests[0].viewportSeq,
      percent:77,label:'正在读取当前区域素材包 3/3'});
    var prefetched=viewportData(requests[0]);prefetched.prefetch=true;
    send(prefetched);await wait(20);
    check(renderProgress.hidden===true,
      'completed background prefetch left the blocking first-screen progress overlay at 77%');
  });

  document.body.dataset.viewportProtocolResults=JSON.stringify(results);
  document.body.dataset.viewportProtocolTest=results.every(function(item){return item.status==='pass'})?'pass':'fail';
}());
</script>`;
}

function main() {
  const windowWidth = Number(process.env.BOO_MAP_TEST_WIDTH || 1200), windowHeight = Number(process.env.BOO_MAP_TEST_HEIGHT || 800);
  assert.ok(Number.isInteger(windowWidth) && windowWidth >= 700 && windowWidth <= 3000);
  assert.ok(Number.isInteger(windowHeight) && windowHeight >= 500 && windowHeight <= 2000);
  const candidates = browserCandidates();
  assert.ok(candidates.length > 0, 'no installed Chromium browser was found');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-map-viewport-protocol-'));
  try {
    const harness = path.join(temporary, 'map-viewport-protocol.html');
    let html = fs.readFileSync(path.join(root, 'media', 'map-preview.html'), 'utf8');
    html = html.replace(
      '<script>',
      '<script>window.__viewportPosted=[];window.acquireVsCodeApi=function(){return{postMessage:function(message){window.__viewportPosted.push(message)}}};</script><script>'
    );
    html = html.replace('</body>', `${scenarioScript()}</body>`);
    fs.writeFileSync(harness, html, 'utf8');

    let selected;
    const diagnostics = [];
    for (let index = 0; index < candidates.length; index++) {
      const result = spawnSync(candidates[index], [
        '--headless=new', '--disable-gpu', '--disable-extensions',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run',
        '--allow-file-access-from-files', '--force-device-scale-factor=1',
        `--user-data-dir=${path.join(temporary, `profile-${index}`)}`,
        `--window-size=${windowWidth},${windowHeight}`, '--virtual-time-budget=2500', '--dump-dom', pathToFileURL(harness).href,
      ], { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      diagnostics.push(`${candidates[index]}: status=${result.status}, error=${result.error?.message || '<none>'}`);
      if (!result.error && result.status === 0 && /data-viewport-protocol-test=/i.test(result.stdout || '')) {
        selected = { candidate: candidates[index], result };break;
      }
    }
    assert.ok(selected, `no browser completed the viewport scenario:\n${diagnostics.join('\n')}`);
    const encoded = /data-viewport-protocol-results="([^"]*)"/.exec(selected.result.stdout)?.[1] || '[]';
    const results = JSON.parse(decodeAttribute(encoded));
    const failed = results.filter(result => result.status !== 'pass');
    console.log(`map-viewport-protocol-browser.test.js: browser=${selected.candidate}`);
    for (const result of results) console.log(`map-viewport-protocol-browser.test.js: ${result.status.toUpperCase()} - ${result.name}`);
    assert.deepEqual(failed, [], failed.map(result => `${result.name}: ${result.message}`).join('\n'));
  } finally {
    removeTemporaryDirectory(temporary);
  }
  console.log('map-viewport-protocol-browser.test.js: PASS');
}

main();
