import { ConversationAudio } from '../engine/audio/conversation-audio';
import type { RuntimeAssetConfig } from '../engine/assets/runtime-store';
import type { RenderCoordinatorCallbacks } from '../engine/runtime/render-coordinator';

export class FeatherCoordinator {
  private worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module',name:'feathertalk'});
  private context: CanvasRenderingContext2D;
  private frames=new Map<number,ImageBitmap>();
  private epoch=0; private response=''; private played=0; private received=0;
  private streaming=false; private started=false; private inFlight=false; private complete=false;
  private destroyed=false; private timer=0; private animation=0;
  private readyResolve?:()=>void; private readyReject?:(error:Error)=>void;
  private initTimer?:ReturnType<typeof setTimeout>;
  constructor(private canvas:HTMLCanvasElement,private video:HTMLVideoElement,
    private callbacks:RenderCoordinatorCallbacks,readonly audio:ConversationAudio) {
    this.context=canvas.getContext('2d',{alpha:false})!;
    if(!this.context)throw new Error('Canvas2D unavailable');
    this.worker.onmessage=({data})=>this.message(data);
    this.worker.onerror=e=>this.fail(`FeatherTalk worker: ${e.message}`);
    this.worker.onmessageerror=()=>this.fail('Unreadable FeatherTalk worker message');
    audio.onPlaybackTick=t=>{if(t.epoch===this.epoch){this.played=t.playedSamples;this.releaseFrames();}};
    audio.onPlaybackDrained=t=>{
      if(t.epoch!==this.epoch)return;
      this.played=t.playedSamples;this.streaming=false;this.started=false;this.clearFrames();
      void video.play().catch(()=>{});callbacks.onPlaybackEnded?.(this.epoch);
    };
  }
  async initialize(config:RuntimeAssetConfig):Promise<void> {
    this.canvas.width=config.manifest.width;this.canvas.height=config.manifest.height;
    this.video.loop=true;
    await this.audio.initialize();
    const ready=new Promise<void>((resolve,reject)=>{
      this.readyResolve=resolve;this.readyReject=reject;
      this.initTimer=setTimeout(()=>this.fail('FeatherTalk initialization timed out after 180 seconds'),180000);
    });
    this.worker.postMessage({type:'init',config});
    void this.video.play().catch(()=>{});
    this.draw();this.timer=window.setInterval(()=>this.pump(),25);
    await ready;
  }
  appendStreamingAudio(response:string,pcm:Int16Array,final=false):number {
    if(this.destroyed)throw new Error('FeatherTalk renderer is destroyed');
    if(response!==this.response){
      this.cancel();this.response=response;this.streaming=true;this.audio.beginStream(this.epoch);
    }
    const copy=new Int16Array(pcm);
    this.worker.postMessage({type:'audio',epoch:this.epoch,pcm:copy,final},[copy.buffer]);
    this.pump();return this.epoch;
  }
  private pump():void {
    if(this.destroyed||!this.streaming||this.inFlight||this.complete||this.frames.size>=20)return;
    this.inFlight=true;this.worker.postMessage({type:'render',epoch:this.epoch});
  }
  private message(data:any):void {
    if(this.destroyed){data.bitmap?.close();return;}
    if(data.type==='ready'){
      clearTimeout(this.initTimer);this.readyResolve?.();this.readyResolve=undefined;this.readyReject=undefined;return;
    }
    if(data.type==='progress'){
      this.callbacks.onRuntimeEvent?.({type:'status',loadedBytes:data.loadedBytes} as Parameters<NonNullable<RenderCoordinatorCallbacks['onRuntimeEvent']>>[0]);return;
    }
    if(data.type==='error'){this.fail(data.message);return;}
    if(data.epoch!==this.epoch){data.bitmap?.close();return;}
    if(data.type==='frame'){
      this.frames.set(data.frame,data.bitmap);this.received++;
      this.audio.appendStream(data.pcm,this.epoch);
    }else if(data.type==='batch'){
      this.inFlight=false;
      if(data.done){this.complete=true;this.audio.finalizeStream(this.epoch);}
      if(!this.started&&(this.received>=8||data.done&&this.received>0)){
        this.started=true;this.video.pause();void this.audio.start(this.epoch).catch(e=>this.fail(String(e)));
      }
    }
  }
  private draw=():void=>{
    if(this.destroyed)return;
    if(this.streaming&&this.started){
      const bitmap=this.frames.get(Math.floor(this.played/960));
      if(bitmap)this.context.drawImage(bitmap,0,0);
    }else if(this.video.readyState>=2){this.context.drawImage(this.video,0,0,this.canvas.width,this.canvas.height);}
    this.callbacks.onFirstHostFrame?.(performance.now());
    this.animation=requestAnimationFrame(this.draw);
  };
  private releaseFrames():void {
    const frame=Math.floor(this.played/960);
    for(const [index,bitmap] of this.frames)if(index<frame){bitmap.close();this.frames.delete(index);}
  }
  private clearFrames():void{for(const frame of this.frames.values())frame.close();this.frames.clear();}
  cancel():number {
    this.epoch++;this.audio.clear(this.epoch);this.worker.postMessage({type:'begin',epoch:this.epoch});
    this.response='';this.played=0;this.received=0;this.streaming=false;this.started=false;this.complete=false;this.inFlight=false;
    this.clearFrames();void this.video.play().catch(()=>{});return this.epoch;
  }
  get playedAudioMs():number{return Math.floor(this.played/24);}
  updateDownloadToken(token:string):void{this.worker.postMessage({type:'grant',token});}
  private fail(message:string):void {
    clearTimeout(this.initTimer);this.readyReject?.(new Error(message));this.readyReject=undefined;this.readyResolve=undefined;
    this.cancel();this.callbacks.onError?.(message);
  }
  destroy():void {
    this.destroyed=true;clearTimeout(this.initTimer);clearInterval(this.timer);cancelAnimationFrame(this.animation);
    this.readyReject?.(new Error('FeatherTalk renderer destroyed'));this.worker.terminate();this.clearFrames();this.video.pause();this.audio.close();
  }
}
