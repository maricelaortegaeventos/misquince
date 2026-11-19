'use strict';
class EventGallery {
  constructor() {
    this.root=document.getElementById('event-gallery');this.frame=document.getElementById('gallery-open');
    this.photo=document.getElementById('gallery-photo');this.status=document.getElementById('gallery-status');
    this.controls=document.getElementById('gallery-controls');
    this.dialog=document.getElementById('photo-viewer');this.large=document.getElementById('viewer-photo');
    this.viewerStatus=document.getElementById('viewer-status');this.viewerPosition=document.getElementById('viewer-position');
    this.previous=document.getElementById('viewer-prev');this.next=document.getElementById('viewer-next');
    this.items=[];this.cursor=null;this.recent=0;this.index=0;this.images=new Map();this.pending=new Map();this.chain=Promise.resolve();this.loadingMore=false;this.refreshing=false;this.pauseUntil=0;
    this.api=createPagesAuthorizer(PHOTO_CONFIG.authorizerUrl).gallery;
    this.frame.addEventListener('click',()=>this.open());
    document.getElementById('gallery-prev').addEventListener('click',()=>this.moveRecent(-1));
    document.getElementById('gallery-next').addEventListener('click',()=>this.moveRecent(1));
    this.previous.addEventListener('click',()=>this.moveViewer(-1));this.next.addEventListener('click',()=>this.moveViewer(1));
    document.getElementById('viewer-close').addEventListener('click',()=>this.dialog.close());
    this.dialog.addEventListener('close',()=>{document.body.classList.remove('viewer-is-open');this.pauseUntil=Date.now()+10000;});
    this.dialog.addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();this.moveViewer(1);}if(e.key==='ArrowLeft'){e.preventDefault();this.moveViewer(-1);}});
    this.swipe(this.frame,step=>this.moveRecent(step));this.swipe(this.dialog.querySelector('.viewer-stage'),step=>this.moveViewer(step));
    window.addEventListener('photos-uploaded',()=>setTimeout(()=>this.refresh(),5000));
    this.ready=this.refresh();
    this.timer=setInterval(()=>{if(!document.hidden&&!this.dialog.open&&!queue.running&&!this.photo.classList.contains('image-loading')&&Date.now()>this.pauseUntil)this.moveRecent(1,false);},5000);
    this.refreshTimer=setInterval(()=>{if(!document.hidden&&!this.dialog.open&&!queue.running)this.refresh();},120000);
  }
  swipe(element,move) {
    let start=null;
    element.addEventListener('touchstart',e=>{start=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;},{passive:true});
    element.addEventListener('touchend',e=>{if(!start)return;const dx=e.changedTouches[0].clientX-start.x,dy=e.changedTouches[0].clientY-start.y;start=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5)move(dx<0?1:-1);},{passive:true});
  }
  request(payload,needed=()=>true) {
    const work=async()=>{for(let attempt=0;attempt<3;attempt++){
      if(!needed())throw Object.assign(new Error('Foto omitida.'),{terminal:true});
      try{const result=await this.api(payload);if(result.ok)return result;if(!result.retryable)throw Object.assign(new Error('Galería no disponible.'),{terminal:true});}
      catch(error){if(error.terminal||attempt===2)throw error;}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
    }throw new Error('No se pudo cargar la foto.');};
    const task=this.chain.then(work,work);this.chain=task.catch(()=>{});return task;
  }
  async refresh() {
    if(this.refreshing||this.dialog.open||queue.running)return;
    this.refreshing=true;
    try {
      const result=await this.request({action:'gallery'});
      if(!Array.isArray(result.files))return;
      this.items=result.files;this.cursor=result.cursor;this.recent=Math.min(this.recent,Math.max(0,this.items.length-1));
      this.root.hidden=false;this.frame.hidden=!this.items.length;this.controls.hidden=this.items.length<2;
      this.status.textContent=this.items.length?'':'Las fotos de esta noche aparecerán aquí.';
      if(this.items.length)await this.showRecent();
    }catch(_){/* Gallery failure never blocks selecting or sending photographs. */}
    finally{this.refreshing=false;}
  }
  image(item) {
    if(this.images.has(item.id))return Promise.resolve(this.images.get(item.id));
    if(this.pending.has(item.id))return this.pending.get(item.id);
    const task=this.request({action:'galleryImage',image:item.image},()=>this.photo.dataset.photo===item.id||(this.dialog.open&&this.large.dataset.photo===item.id)).then(result=>{
      if(!/^image\/(jpeg|png|webp|gif)$/.test(result.mime)||typeof result.data!=='string'||result.data.length>700000||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))throw new Error('Imagen no disponible.');
      const source='data:'+result.mime+';base64,'+result.data;this.images.set(item.id,source);
      while(this.images.size>24)this.images.delete(this.images.keys().next().value);
      return source;
    }).finally(()=>this.pending.delete(item.id));
    this.pending.set(item.id,task);return task;
  }
  async showPicture(target,item,status) {
    target.dataset.photo=item.id;target.classList.add('image-loading');status.textContent='';
    try{const source=await this.image(item);if(target.dataset.photo!==item.id)return;target.src=source;await target.decode().catch(()=>{});}
    catch(_){if(target.dataset.photo===item.id){target.removeAttribute('src');status.textContent='No se pudo cargar esta foto.';}}
    finally{if(target.dataset.photo===item.id)target.classList.remove('image-loading');}
  }
  async showRecent() {
    const item=this.items[this.recent];if(!item)return;
    await this.showPicture(this.photo,item,this.status);
  }
  moveRecent(step,manual=true) {
    const count=Math.min(this.items.length,10);if(!count)return;
    if(manual)this.pauseUntil=Date.now()+12000;
    this.recent=(this.recent+step+count)%count;this.showRecent();
  }
  open() {
    if(!this.items.length)return;this.index=this.recent;
    this.dialog.showModal();document.body.classList.add('viewer-is-open');this.showViewer();
  }
  showViewer() {
    this.viewerPosition.textContent=(this.index+1)+(this.cursor?' / '+this.items.length+'+':' / '+this.items.length);
    this.previous.disabled=this.index===0||this.loadingMore;this.next.disabled=this.loadingMore||(!this.cursor&&this.index>=this.items.length-1);
    const item=this.items[this.index];if(item)this.showPicture(this.large,item,this.viewerStatus);
  }
  async moveViewer(step) {
    if(this.loadingMore)return;let target=this.index+step;if(target<0)return;
    if(target>=this.items.length&&this.cursor){
      this.loadingMore=true;this.previous.disabled=true;this.next.disabled=true;this.viewerStatus.textContent='Cargando fotos…';
      try{
        // Drive can return empty/overlapping pages while new files arrive; follow the cursor.
        for(let attempt=0;attempt<4&&target>=this.items.length&&this.cursor;attempt++){
          const result=await this.request({action:'gallery',cursor:this.cursor});
          const known=new Set(this.items.map(item=>item.id));this.items.push(...result.files.filter(item=>!known.has(item.id)));this.cursor=result.cursor;
        }
      }catch(_){this.viewerStatus.textContent='No se pudieron cargar más fotos.';}
      finally{this.loadingMore=false;}
    }
    if(target<this.items.length)this.index=target;
    this.showViewer();
  }
}
const eventGallery=new EventGallery();
