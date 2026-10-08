import { ConversationAudio } from '../audio/conversation-audio';
import { RenderCoordinator, type RenderCoordinatorCallbacks } from './render-coordinator';
import { FeatherCoordinator } from '../../feathertalk/coordinator';

/** Keeps the user-activated AudioContext while choosing the engine from the signed manifest. */
export class AvatarCoordinator {
  readonly audio=new ConversationAudio();
  private renderer?:RenderCoordinator|FeatherCoordinator;
  constructor(private canvas:HTMLCanvasElement,private video:HTMLVideoElement,private callbacks:RenderCoordinatorCallbacks){}
  async initialize(...args:Parameters<RenderCoordinator['initialize']>):Promise<void>{
    if(this.renderer)throw new Error('Renderer already initialized');
    if(args[0].manifest.engine==='feathertalk-web'){
      this.renderer=new FeatherCoordinator(this.canvas,this.video,this.callbacks,this.audio);
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
  get playedAudioMs():number{return this.renderer?.playedAudioMs??0;}
  updateDownloadToken(token:string):void{this.renderer?.updateDownloadToken(token);}
  destroy():void{if(this.renderer)this.renderer.destroy();else this.audio.close();}
}
