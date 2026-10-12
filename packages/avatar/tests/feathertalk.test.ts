import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioInput, bankCrop, hostIndex, imageInput, validatePack, type FeatherPack } from '../src/feathertalk/contract';
import { readPackV2 } from '../src/feathertalk/pack-v2';

function pack(innerSize=144):FeatherPack {
  return {fps:25,sampleRate:16000,innerSize,outerSize:innerSize*304/144,outputSize:innerSize*2,
    width:540,height:960,waveformMean:0,waveformStd:0.1,hole:{x:4,y:4,width:10,height:10},
    featherPixels:8,frames:[{bbox:[0,0,100,100],width:1080,height:1920,host:'hosts/0000.jpg'}],
    encoder:'encoder.onnx',renderer:'renderer.onnx',innerBank:'inner.bgr',referenceFrame:0};
}
test('supports both uploaded model sizes and rejects incompatible contracts',()=>{
  validatePack(pack(144));validatePack(pack(288));
  assert.throws(()=>validatePack({...pack(),outputSize:320}));
  assert.throws(()=>validatePack({...pack(),waveformStd:0}));
  assert.throws(()=>validatePack({...pack(),referenceFrame:1}));
});
test('host traversal reverses smoothly without duplicated endpoint frames',()=>{
  assert.deepEqual(Array.from({length:10},(_,i)=>hostIndex(i,4)),[0,1,2,3,2,1,0,1,2,3]);
  assert.equal(hostIndex(100,1),0);
});
test('image input preserves BGR reference, masks only source, and uses planar float32',()=>{
  for(const size of [144,288]) {
    const p=pack(size),plane=size*size,bank=new Uint8Array(plane*3);
    for(let i=0;i<plane;i++){bank[i*3]=255;bank[i*3+1]=128;bank[i*3+2]=64;}
    const crop=bankCrop(bank,0,p);
    const input=imageInput(crop,crop,p),hole=5*size+5;
    assert.equal(input.length,6*plane);assert.equal(input[hole],1);
    assert.equal(input[3*plane+hole],0);assert.equal(input[5*plane+hole],0);
    assert.equal(input[3*plane],1);assert.ok(Math.abs(input[4*plane]-128/255)<1e-6);
    assert.throws(()=>bankCrop(bank.subarray(1),0,p));
    assert.throws(()=>imageInput(crop.subarray(1),crop,p));
  }
});
/** The second layout, as the CDN actually publishes it — values from kofi 2026.10.12.1. */
function packV2() {
  return {
    format:'feathertalk-web',schema:1,id:'kofi',
    audio:{sampleRate:16000,fps:25,waveformMean:0.00007622,waveformStd:0.068032},
    geometry:{inner:288,output:576,outer:608,hole:{x:8,y:8,width:270,height:260},featherPixels:8,channelOrder:'BGR'},
    models:{encoder:{file:'encoder.onnx',input:'audio',output:'hidden'},
      renderer:{file:'renderer.onnx',image:'image',audio:'audio',output:'output'},closedAudio:'closed_audio.f32'},
    hosts:{width:1080,height:1920,count:2,boxes:[[347,599,697,949],[347,600,697,950]] as Array<[number,number,number,number]>,
      videos:[{file:'hosts.mp4',codec:'hvc1.1.6.L120.90',description:'AQ==',keyframeInterval:15,
        frames:[[44,109796],[109840,57975]] as Array<[number,number]>}]},
    still:{host:1},face:{voice:'echo'},
    instantLips:{lookaheadFrames:1,standIn:'mirror',voiceDelayMilliseconds:110},
  };
}
test('the second pack layout reads into the same contract the engine already speaks',()=>{
  const {pack:p,v2}=readPackV2(packV2());
  validatePack(p);
  assert.equal(p.innerSize,288);assert.equal(p.outputSize,576);assert.equal(p.outerSize,608);
  assert.equal(p.width,1080);assert.equal(p.height,1920);
  assert.equal(p.frames.length,2);assert.deepEqual(p.frames[0].bbox,[347,599,697,949]);
  // The boxes are already in host-frame coordinates, so the per-frame rescale in the worker is the identity.
  assert.equal(p.frames[0].width,1080);assert.equal(p.frames[0].height,1920);
  // The still's host is the neutral pose, not frame zero.
  assert.equal(p.referenceFrame,1);
  // No bank ships with this layout; the crops come from the video.
  assert.equal(p.innerBank,'');assert.equal(p.frames[0].host,'');
  assert.equal(v2.instantLips?.lookaheadFrames,1);assert.equal(v2.face?.voice,'echo');
  // The renderer's output was renamed from clip_0 to output in a re-export, so the names come from the pack.
  assert.equal(p.tensors?.rendererOutput,'output');assert.equal(p.tensors?.encoderOutput,'hidden');
});
test('a pack that names no tensors keeps the names the first layout has always used',()=>{
  const bare=packV2();
  bare.models={encoder:{file:'encoder.onnx'},renderer:{file:'renderer.onnx'}} as typeof bare.models;
  const {pack:p}=readPackV2(bare);
  assert.equal(p.tensors?.rendererOutput,'clip_0');assert.equal(p.tensors?.rendererImage,'image');
});
test('either engine name reads, since the same renderer was republished under a new one',()=>{
  assert.equal(readPackV2({...packV2(),format:'realistic-web'}).pack.innerSize,288);
});
test('the second layout refuses a pack whose host tables disagree',()=>{
  assert.throws(()=>readPackV2({...packV2(),format:'something-else'}));
  assert.throws(()=>readPackV2({...packV2(),schema:2}));
  const short={...packV2()};short.hosts={...short.hosts,count:3};
  assert.throws(()=>readPackV2(short),/frame count/);
  const video={...packV2()};
  video.hosts={...video.hosts,videos:[{...video.hosts.videos[0],frames:[[0,1]] as Array<[number,number]>}]};
  assert.throws(()=>readPackV2(video),/host video/);
});
test('audio window uses target frame at index 10 and clamps boundary context',()=>{
  const hidden=new Float32Array(60*1024);
  for(let i=0;i<60;i++)hidden.fill(i,i*1024,(i+1)*1024);
  const centered=audioInput(hidden,60,18,2);
  assert.equal(centered[0],12);assert.equal(centered[20*1024],32);assert.equal(centered[39*1024],51);
  const first=audioInput(hidden,60,0,0);
  assert.equal(first[0],0);assert.equal(first[20*1024],0);assert.equal(first[39*1024],19);
});
