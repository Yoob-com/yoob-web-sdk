import { isFeatherTalk } from '../../cdn';
import { ConversationAudio } from '../audio/conversation-audio';
import { RenderCoordinator, type RenderCoordinatorCallbacks } from './render-coordinator';
import { FeatherCoordinator } from '../../feathertalk/coordinator';
import type { IdleStill } from '../../feathertalk/idle';
import type { StatsCollector } from '../../stats';

/** Keeps the user-activated AudioContext while choosing the engine from the signed manifest. */
export class AvatarCoordinator {
  readonly audio=new ConversationAudio();
  private renderer?:RenderCoordinator|FeatherCoordinator;
  /**
   * Where the renderer reports what it is doing, when stats were asked for.
   *
   * Only the FeatherTalk path fills it in. The Luna renderer has its own, older telemetry — `onMetrics`,
   * `onLatency`, `onTurnTelemetry` — which nothing currently subscribes to; wiring that up is its own job.
   */
  stats?:StatsCollector;
  constructor(private canvas:HTMLCanvasElement,private video:HTMLVideoElement,private callbacks:RenderCoordinatorCallbacks){}
  async initialize(...args:Parameters<RenderCoordinator['initialize']>):Promise<void>{
    if(this.renderer)throw new Error('Renderer already initialized');
    if(isFeatherTalk(args[0].manifest.engine)){
      const feather=new FeatherCoordinator(this.canvas,this.video,this.callbacks,this.audio);
      feather.stats=this.stats;
      this.renderer=feather;
      await this.renderer.initialize(args[0]);
    }else{
      this.renderer=new RenderCoordinator(this.canvas,this.video,this.callbacks,this.audio);
      await this.renderer.initialize(...args);
    }
  }
  appendStreamingAudio(response:string,pcm:Int16Array,final=false):number{
    if(!this.renderer)throw new Error('Call and await avatar.prepare() before speak()');
    return this.renderer.appendStreamingAudio(response,pcm,final);
  }
  cancel():number{return this.renderer?.cancel()??0;}
  /** The FeatherTalk resting face; the Luna renderer has an idle loop of its own and ignores it. */
  setIdle(idle?:IdleStill):void{if(this.renderer instanceof FeatherCoordinator)this.renderer.setIdle(idle);}
  get playedAudioMs():number{return this.renderer?.playedAudioMs??0;}
  updateDownloadToken(token:string):void{this.renderer?.updateDownloadToken(token);}
  destroy():void{if(this.renderer)this.renderer.destroy();else this.audio.close();}
}
