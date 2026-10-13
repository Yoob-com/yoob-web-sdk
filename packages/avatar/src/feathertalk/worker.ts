import { ChunkStore, type CdnAccess, type CharacterManifest } from '../cdn';
import { createSession, ort, setOrtWasmUrl } from '../engine/inference/ort-runtime';
import { PcmResampler } from '../resampler';
import { audioInput, DEFAULT_TENSORS, hostIndex, imageInput, validatePack, type FeatherPack, type FeatherTensors } from './contract';
import { JpegHosts, VideoHosts, type HostFrames } from './hosts';
import { readPackV2 } from './pack-v2';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let access: CdnAccess, store: ChunkStore, pack: FeatherPack;
let frames: HostFrames, referenceCrop: Uint8Array;
/** Which execution provider the renderer session actually came up on. */
let backend='';
/** Milliseconds spent in each stage of the batch being built, reported with it. */
let encoderMs=0, rendererMs=0, hostMs=0, neuralFrames=0;
/** What this character's graphs call their tensors. The first layout's names are fixed; the second states its own. */
let tensors: FeatherTensors = DEFAULT_TENSORS;
let encoder: ort.InferenceSession, renderer: ort.InferenceSession;
let epoch=0, pcm=new Int16Array(0), samples16=new Int16Array(0), final=false, nextFrame=0, busy=false, requested=false;
let resampler=new PcmResampler(24000,16000);
/**
 * How much audio *after* a frame the renderer waits for before drawing it, in 40 ms frames.
 *
 * The cost of this is paid twice over: the voice cannot start until the first frames exist, so every frame of
 * lookahead is 40 ms added to how long the listener waits to hear anything. 9 is what the pack was tuned against and
 * stays the default; the knob is here to measure smaller values against a given pack rather than to guess at one.
 */
let lookahead=9;
/**
 * What to feed the encoder past the end of the audio received so far.
 *
 * Silence is the default because it is what the packs were tuned against. It reads as a pause the speaker did not
 * take, so the mouth closes for it; mirroring back into the voice that is still going keeps the spectrum instead.
 * Separate from `lookahead` on purpose: the two want measuring independently, and the window runs past the audio at
 * the end of every reply even at the default lookahead, so turning this on is never a no-op.
 */
let mirrorPadding=false;
let canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D;
let patch: OffscreenCanvas, patchContext: OffscreenCanvasRenderingContext2D;
let lastPixels: Uint8ClampedArray<ArrayBuffer> | undefined;
const post=(message: unknown, transfer: Transferable[]=[])=>scope.postMessage(message,transfer);
function append(a: Int16Array, b: Int16Array): Int16Array<ArrayBuffer> {
  const result=new Int16Array(a.length+b.length); result.set(a);result.set(b,a.length);return result;
}
async function initialize(config: CdnAccess & {manifest: CharacterManifest; ortWasmUrl:string; lookaheadFrames?:number; mirrorPadding?:boolean}) {
  access=config; store=new ChunkStore(access,config.manifest);setOrtWasmUrl(config.ortWasmUrl);
  mirrorPadding=config.mirrorPadding===true;
  let loadedBytes=0;
  const load=(path:string)=>store.bytes(path,n=>post({type:'progress',loadedBytes:loadedBytes+=n}));
  // Which layout this character ships. The manifest names its index file; a manifest that names none is the original
  // layout, whose index has always been called `feathertalk.json`.
  const packPath=config.manifest.runtime?.pack;
  const raw=JSON.parse(new TextDecoder().decode(await load(packPath ?? 'feathertalk.json')));
  if(packPath){
    const read=readPackV2(raw);
    pack=read.pack;validatePack(pack);
    // The pack's own timing, when it states one. These packs are built for a short lookahead and a mirrored stand-in;
    // the older ones were tuned against nine frames, which is why the default stays where it is.
    const lips=read.v2.instantLips;
    if(Number.isInteger(lips?.lookaheadFrames)&&lips!.lookaheadFrames!>=0)lookahead=lips!.lookaheadFrames!;
    if(lips?.standIn==='mirror')mirrorPadding=true;
    // How long the voice waits for the mouth. The page holds playback back by this much so the first word is never
    // ahead of the first lip frame; the pack states it because it depends on how the pack was built.
    if(Number.isFinite(lips?.voiceDelayMilliseconds))post({type:'voiceDelay',ms:lips!.voiceDelayMilliseconds});
    frames=await VideoHosts.open(pack,read.v2,load);
  } else {
    pack=raw as FeatherPack;validatePack(pack);
    frames=new JpegHosts(pack,new Uint8Array(await load(pack.innerBank)),load,(path)=>store.release(path));
  }
  // The caller's override wins over the pack, so a page can still measure one setting against another.
  if(Number.isInteger(config.lookaheadFrames)&&config.lookaheadFrames!>=0)lookahead=config.lookaheadFrames!;
  // The neutral pose every frame is rendered against. Fetched once and held: it is read on every single frame.
  tensors=pack.tensors??DEFAULT_TENSORS;
  referenceCrop=new Uint8Array(await frames.crop(pack.referenceFrame));
  encoder=await createSession(new Uint8Array(await load(pack.encoder)),['wasm'],'FeatherTalk encoder');
  // It asks for WebGPU and falls back to wasm without telling anyone, which is the difference between a smooth
  // character and a slideshow. `onFallback` fires only on that refusal, so it is the honest answer to which one ran.
  backend='webgpu';
  renderer=await createSession(new Uint8Array(await load(pack.renderer)),['webgpu','wasm'],'FeatherTalk renderer',
    ()=>{backend='wasm';});
  store.release(pack.encoder);store.release(pack.renderer);
  canvas=new OffscreenCanvas(pack.width,pack.height);context=canvas.getContext('2d')!;
  patch=new OffscreenCanvas(pack.outputSize,pack.outputSize);patchContext=patch.getContext('2d')!;
  if(!context||!patchContext)throw new Error('Offscreen Canvas2D unavailable');
  // Validate both model graphs on the actual backend before declaring the avatar ready.
  const input=new ort.Tensor('float32',new Float32Array(12880),[1,12880]);
  const warm=await encoder.run({[tensors.encoderInput]:input});input.dispose();
  if(warm[tensors.encoderOutput]?.dims.at(-1)!==1024)throw new Error('FeatherTalk encoder output mismatch');
  Object.values(warm).forEach(t=>t.dispose());
  const image=new ort.Tensor('float32',imageInput(referenceCrop,referenceCrop,pack),[1,6,pack.innerSize,pack.innerSize]);
  const audio=new ort.Tensor('float32',new Float32Array(40*1024),[1,40,1024]);
  const result=await renderer.run({[tensors.rendererImage]:image,[tensors.rendererAudio]:audio});image.dispose();audio.dispose();
  // Named by the pack rather than assumed: a re-export renamed this tensor once already, and the failure that caused
  // was a character that downloaded perfectly and then rendered nothing.
  if(result[tensors.rendererOutput]?.dims.join(',')!==`1,3,${pack.outputSize},${pack.outputSize}`)throw new Error('FeatherTalk renderer output mismatch');
  Object.values(result).forEach(t=>t.dispose());post({type:'ready'});
}
async function render(requestEpoch:number) {
  if(requestEpoch!==epoch)return;
  if(busy){requested=true;return;}busy=true;
  try {
    const totalFrames=Math.ceil(pcm.length/960);
    const available=final?totalFrames:Math.max(0,Math.floor((samples16.length-80)/640)-lookahead);
    const end=Math.min(nextFrame+8,available);
    if(end<=nextFrame){post({type:'batch',epoch,waiting:true});return;}
    encoderMs=0;rendererMs=0;hostMs=0;neuralFrames=0;
    const hostStart=performance.now();
    // Fetch the upcoming hosts concurrently so network RTT is paid per batch, not per frame.
    await Promise.all(Array.from({length:end-nextFrame},(_,i)=>frames.picture(hostIndex(nextFrame+i,pack.frames.length))));
    // The whole batch's pictures, fetched together: a JPEG each, or one group of video decoded at once.
    hostMs=(performance.now()-hostStart)/Math.max(1,end-nextFrame);
    if(epoch!==requestEpoch)return;
    const start=Math.max(0,nextFrame-16), stop=end+lookahead;
    const wave=new Float32Array((stop-start)*640+80);
    const n=samples16.length;
    const past=(i:number)=>{
      if(!mirrorPadding||n===0)return 0;
      // Fold back: the sample `over` steps past the end is the one `over` steps before it, wrapping if the reply is
      // shorter than the overrun.
      return samples16[n-1-((i-n)%n)]!;
    };
    for(let i=0;i<wave.length;i++){
      const at=start*640+i;
      const sample=at<n?samples16[at]!:past(at);
      wave[i]=(sample/32768-pack.waveformMean)/pack.waveformStd;
    }
    const tensor=new ort.Tensor('float32',wave,[1,wave.length]);
    const encoderStart=performance.now();
    const encoded=await encoder.run({[tensors.encoderInput]:tensor});tensor.dispose();
    encoderMs=performance.now()-encoderStart;
    try {
      const out=encoded[tensors.encoderOutput];
      const hidden=out.data as Float32Array, tokens=out.dims[1];
      for(let frame=nextFrame;frame<end;frame++) {
        if(epoch!==requestEpoch)return;
        const index=hostIndex(frame,pack.frames.length), hostImage=await frames.picture(index);
        // The 576px renderer is expensive on laptop GPUs. Refresh its mouth at 12.5 fps
        // while keeping host motion and the 25 fps audio clock. The 288px model runs every frame.
        if(pack.innerSize===144 || frame%2===0 || !lastPixels){
          const image=new ort.Tensor('float32',imageInput(referenceCrop,await frames.crop(index),pack),[1,6,pack.innerSize,pack.innerSize]);
          const audio=new ort.Tensor('float32',audioInput(hidden,tokens,frame,start),[1,40,1024]);
          const rendererStart=performance.now();
          const result=await renderer.run({[tensors.rendererImage]:image,[tensors.rendererAudio]:audio});image.dispose();audio.dispose();
          // Per neural frame, not per emitted frame: a big pack refreshes the mouth every other frame, so dividing
          // by the batch size would halve the number and hide what the renderer actually costs.
          rendererMs+=performance.now()-rendererStart;neuralFrames+=1;
          try {
            const output=result[tensors.rendererOutput].data as Float32Array, size=pack.outputSize, plane=size*size;
            const pixels=new Uint8ClampedArray(plane*4);
            for(let i=0;i<plane;i++) {
              const x=i%size,y=Math.floor(i/size);
              pixels[i*4]=output[2*plane+i]*255;pixels[i*4+1]=output[plane+i]*255;pixels[i*4+2]=output[i]*255;
              pixels[i*4+3]=255*Math.min(1,(Math.min(x,y,size-1-x,size-1-y)+1)/Math.max(1,pack.featherPixels));
            }
            lastPixels=pixels;
          } finally {Object.values(result).forEach(t=>t.dispose());}
        }
        if(epoch!==requestEpoch)return;
        patchContext.putImageData(new ImageData(lastPixels!,pack.outputSize,pack.outputSize),0,0);
        context.drawImage(hostImage,0,0);
        const f=pack.frames[index], [x1,y1,x2,y2]=f.bbox, inset=(pack.outerSize-pack.outputSize)/2/pack.outerSize;
        const sx=pack.width/f.width,sy=pack.height/f.height;
        context.drawImage(patch,(x1+(x2-x1)*inset)*sx,(y1+(y2-y1)*inset)*sy,
          (x2-x1)*(1-2*inset)*sx,(y2-y1)*(1-2*inset)*sy);
        const bitmap=canvas.transferToImageBitmap(), audioPcm=pcm.slice(frame*960,Math.min((frame+1)*960,pcm.length));
        post({type:'frame',epoch,frame,bitmap,pcm:audioPcm},[bitmap,audioPcm.buffer]);nextFrame=frame+1;
      }
    } finally {Object.values(encoded).forEach(t=>t.dispose());}
    post({type:'batch',epoch,done:final&&nextFrame>=totalFrames,backend,
      timing:{encoderMs,rendererMs:neuralFrames?rendererMs/neuralFrames:0,hostMs,neuralFrames}});
  } finally {
    busy=false;
    if(requested){requested=false;void render(epoch).catch(fail);}
  }
}
scope.onmessage=({data})=>{
  if(data.type==='init')void initialize(data.config).catch(fail);
  else if(data.type==='grant'){if(access)access.downloadToken=data.token;}
  else if(data.type==='begin') {
    epoch=data.epoch;pcm=new Int16Array(0);samples16=new Int16Array(0);resampler=new PcmResampler(24000,16000);final=false;nextFrame=0;lastPixels=undefined;
  } else if(data.type==='audio') {
    if(data.epoch!==epoch)return;
    pcm=append(pcm,data.pcm);samples16=append(samples16,resampler.process(data.pcm));final=data.final;
    if(final)samples16=append(samples16,resampler.process(new Int16Array(32)));
  } else if(data.type==='render')void render(data.epoch).catch(fail);
};
function fail(error:unknown){post({type:'error',message:error instanceof Error?error.message:String(error)});}
