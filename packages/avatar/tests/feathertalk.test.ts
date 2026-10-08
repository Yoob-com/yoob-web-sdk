import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioInput, hostIndex, imageInput, validatePack, type FeatherPack } from '../src/feathertalk/contract';

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
    const input=imageInput(bank,0,p),hole=5*size+5;
    assert.equal(input.length,6*plane);assert.equal(input[hole],1);
    assert.equal(input[3*plane+hole],0);assert.equal(input[5*plane+hole],0);
    assert.equal(input[3*plane],1);assert.ok(Math.abs(input[4*plane]-128/255)<1e-6);
    assert.throws(()=>imageInput(bank.subarray(1),0,p));
  }
});
test('audio window uses target frame at index 10 and clamps boundary context',()=>{
  const hidden=new Float32Array(60*1024);
  for(let i=0;i<60;i++)hidden.fill(i,i*1024,(i+1)*1024);
  const centered=audioInput(hidden,60,18,2);
  assert.equal(centered[0],12);assert.equal(centered[20*1024],32);assert.equal(centered[39*1024],51);
  const first=audioInput(hidden,60,0,0);
  assert.equal(first[0],0);assert.equal(first[20*1024],0);assert.equal(first[39*1024],19);
});
