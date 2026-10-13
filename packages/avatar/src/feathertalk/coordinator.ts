import { ConversationAudio } from '../engine/audio/conversation-audio';
import type { StatsCollector } from '../stats';
import type { RuntimeAssetConfig } from '../engine/assets/runtime-store';
import type { RenderCoordinatorCallbacks } from '../engine/runtime/render-coordinator';

export class FeatherCoordinator {
  private worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module',name:'feathertalk'});
  private context: CanvasRenderingContext2D;
  private frames=new Map<number,ImageBitmap>();
  private epoch=0; private response=''; private played=0; private received=0;
  private queuedSamples=0; private finalReceived=false;
  private streaming=false; private started=false; private inFlight=false; private complete=false;
  private destroyed=false; private timer=0; private animation=0;
  private readyResolve?:()=>void; private readyReject?:(error:Error)=>void;
  /** How long the voice waits for the mouth, in samples at 24 kHz. Stated by the pack; zero when it states none. */
  private voiceDelaySamples=0;
  private initTimer?:ReturnType<typeof setTimeout>;
  /** Set when the integrator asked for stats. Undefined costs one property read per draw and nothing else. */
  stats?: StatsCollector;
  /** The highest frame index actually drawn, so a frame released above it is known to have been thrown away unseen. */
  private drawn=-1;
  /**
   * When the audio for a frame arrived, as `[first frame of the chunk, timestamp]`.
   *
   * A drawn frame can then be measured against the packet that produced it, which is the only honest way to say how
   * far behind the voice the mouth is running. Kept only while stats are on, and pruned as frames are drawn.
   */
  private arrivals:Array<[number,number]>=[];
  constructor(private canvas:HTMLCanvasElement,private video:HTMLVideoElement,
    private callbacks:RenderCoordinatorCallbacks,readonly audio:ConversationAudio) {
    this.context=canvas.getContext('2d',{alpha:false})!;
    if(!this.context)throw new Error('Canvas2D unavailable');
    this.worker.onmessage=({data})=>this.message(data);
    this.worker.onerror=e=>this.fail(`FeatherTalk worker: ${e.message}`);
    this.worker.onmessageerror=()=>this.fail('Unreadable FeatherTalk worker message');
    audio.onPlaybackTick=t=>{if(t.epoch===this.epoch){
      this.played=t.playedSamples;
      if(this.stats){
        this.stats.noteAudioBuffered(t.bufferedSamples/24);
        // How far the rendered frames run ahead of the voice. The engine's own threshold is two frames, 80 ms.
        let highest=-1;for(const index of this.frames.keys())if(index>highest)highest=index;
        if(highest>=0)this.stats.noteRenderLead(highest-Math.floor(this.played/960));
      }
      this.releaseFrames();
    }};
    // Starvation is measured by the worklet and has never had a listener on this path. It is the thing a caller
    // hears as the voice breaking up, so it is the first number worth showing.
    audio.onPlaybackUnderrun=u=>{if(u.epoch===this.epoch)this.stats?.noteUnderrun(u.durationSamples/24);};
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
    // Playback follows the incoming PCM clock, not the GPU renderer. A slow
    // frame may hold the mouth pose, but must never create a gap in the voice.
    if(copy.length){
      if(this.stats){this.arrivals.push([Math.floor(this.queuedSamples/960),performance.now()]);this.stats.noteReplyAudio();}
      this.audio.appendStream(copy,this.epoch);this.queuedSamples+=copy.length;
    }
    if(final){this.finalReceived=true;this.audio.finalizeStream(this.epoch);}
    this.worker.postMessage({type:'audio',epoch:this.epoch,pcm:copy,final},[copy.buffer]);
    this.pump();this.maybeStart();return this.epoch;
  }
  private maybeStart():void {
    if(this.started||!this.streaming)return;
    // Keep a 400 ms PCM cushion so LiveKit jitter does not empty the worklet
    // right after playback begins. Short finalized replies use what they have.
    //
    // A pack that asks the voice to wait for the mouth adds to that cushion rather than replacing it: both are
    // reasons to hold the first sample back, and the longer one governs.
    if(this.queuedSamples<Math.max(9600,this.voiceDelaySamples)&&!this.finalReceived){this.stats?.noteStartGate('audio');return;}
    if(this.received<8&&!(this.finalReceived&&this.received>0)){this.stats?.noteStartGate('frames');return;}
    this.started=true;this.video.pause();
    // The first sound of this reply is about to be asked for. Pairs with the first audio that arrived for it.
    this.stats?.noteReplyHeard();
    void this.audio.start(this.epoch).catch(e=>this.fail(String(e)));
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
    if(data.type==='voiceDelay'){
      this.voiceDelaySamples=Math.max(0,Math.round(data.ms*24));return;
    }
    if(data.type==='progress'){
      this.callbacks.onRuntimeEvent?.({type:'status',loadedBytes:data.loadedBytes} as Parameters<NonNullable<RenderCoordinatorCallbacks['onRuntimeEvent']>>[0]);return;
    }
    if(data.type==='error'){this.fail(data.message);return;}
    if(data.epoch!==this.epoch){data.bitmap?.close();return;}
    if(data.type==='frame'){
      this.frames.set(data.frame,data.bitmap);this.received++;
      this.stats?.noteFrame();this.stats?.noteQueue(this.frames.size);
      this.maybeStart();
    }else if(data.type==='batch'){
      this.inFlight=false;
      // `waiting` has always been posted and never read: the batch produced nothing because the audio for it had
      // not arrived. Starved is not the same as slow, and they look identical on screen.
      if(data.waiting)this.stats?.noteWaiting();
      if(this.stats&&data.timing){
        this.stats.noteInference(data.timing.encoderMs,data.timing.rendererMs,data.timing.hostMs);
        this.stats.noteLipFrames(data.timing.neuralFrames??0);
      }
      if(this.stats&&data.backend)this.stats.noteBackend(data.backend);
      if(data.done)this.complete=true;
      this.maybeStart();
    }
  }
  private draw=():void=>{
    if(this.destroyed)return;
    if(this.streaming&&this.started){
      const index=Math.floor(this.played/960);
      const bitmap=this.frames.get(index);
      if(bitmap){
        this.context.drawImage(bitmap,0,0);
        if(index>this.drawn)this.drawn=index;
        // The first picture of this reply reached the screen; measure it against the audio that caused it.
        if(this.stats){const lag=this.lipLatency(index);if(lag>0)this.stats.noteLipLatency(lag);}
      }
      // No frame for where the voice is: the previous picture stays, which is the freeze a listener sees. Counted
      // here because nothing else can see it — the draw simply does not happen.
      else this.stats?.noteHeld();
    }else if(this.video.readyState>=2){this.context.drawImage(this.video,0,0,this.canvas.width,this.canvas.height);}
    this.stats?.noteDraw();
    this.callbacks.onFirstHostFrame?.(performance.now());
    this.animation=requestAnimationFrame(this.draw);
  };
  /** How long ago the audio for this frame arrived. Zero when it cannot be attributed. */
  private lipLatency(index:number):number {
    while(this.arrivals.length>1&&this.arrivals[1][0]<=index)this.arrivals.shift();
    const head=this.arrivals[0];
    return head&&head[0]<=index?performance.now()-head[1]:0;
  }
  private releaseFrames():void {
    const frame=Math.floor(this.played/960);
    for(const [index,bitmap] of this.frames)if(index<frame){
      // Rendered, then passed by the audio clock without ever being drawn: work done and thrown away.
      if(index>this.drawn)this.stats?.noteDropped();
      bitmap.close();this.frames.delete(index);
    }
  }
  private clearFrames():void{for(const frame of this.frames.values())frame.close();this.frames.clear();}
  cancel():number {
    this.epoch++;this.audio.clear(this.epoch);this.worker.postMessage({type:'begin',epoch:this.epoch});
    this.response='';this.played=0;this.received=0;this.queuedSamples=0;this.finalReceived=false;
    this.arrivals=[];this.drawn=-1;this.stats?.noteReplyEnded();
    this.streaming=false;this.started=false;this.complete=false;this.inFlight=false;
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
