'use strict';
// Personal history contains only small previews of acknowledged uploads.
// It has no Drive listing, image endpoint, OAuth token or upload capability.
class PhotoLibrary {
  constructor() {
    this.name='mis-xv-misquince-personal-1';this.db=null;this.memory=new Map();
    this.pending=Promise.resolve();this.ready=this.initialize();
  }
  async initialize() {
    this.db=await new Promise(resolve=>{
      if(!globalThis.indexedDB)return resolve(null);
      let request,done=false;
      const finish=db=>{if(done){if(db)db.close();return;}done=true;clearTimeout(timer);resolve(db);};
      const timer=setTimeout(()=>finish(null),3000);
      try{request=indexedDB.open(this.name,1);}catch(_){finish(null);return;}
      request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('meta',{keyPath:'id'});db.createObjectStore('photos',{keyPath:'id'});};
      request.onerror=request.onblocked=()=>finish(null);
      request.onsuccess=()=>finish(request.result);
    });
    if(this.db)this.db.onversionchange=()=>{this.db.close();this.db=null;};
    const generated=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    this.browserId=await this.transaction('meta','readwrite',store=>{
      const request=store.get('browser');let identity;
      request.onsuccess=()=>{identity=request.result?.value;if(!/^[a-f0-9]{32}$/.test(identity||'')){identity=generated;store.put({id:'browser',value:identity});}};
      return ()=>identity;
    }) || generated;
  }
  async transaction(storeName,mode,work) {
    if(!this.db)return null;
    try{return await new Promise(resolve=>{
      const tx=this.db.transaction(storeName,mode);let done=false;
      const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
      const timer=setTimeout(()=>{try{tx.abort();}catch(_){}finish(null);},5000);
      let result;
      tx.oncomplete=()=>finish(typeof result==='function'?result():result?.result??true);
      tx.onabort=tx.onerror=()=>finish(null);
      try{result=work(tx.objectStore(storeName));}catch(_){try{tx.abort();}catch(_){}finish(null);}
    });}catch(_){return null;}
  }
  async list() {
    await this.ready;
    const stored=await this.transaction('photos','readonly',store=>store.getAll()) || [];
    const records=new Map(stored.map(record=>[record.id,{id:record.id,name:record.name,sentAt:record.sentAt,
      preview:record.previewBytes?.byteLength>0&&record.previewBytes.byteLength<=524288?new Blob([record.previewBytes],{type:'image/jpeg'}):null}]));
    for(const [id,record] of this.memory)records.set(id,record);
    return Array.from(records.values()).sort((a,b)=>b.sentAt-a.sentAt||a.id.localeCompare(b.id));
  }
  async thumbnail(file) {
    const source=URL.createObjectURL(file),img=new Image();
    let timer;
    try{
      await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(Error('Preview timeout')),12000);
        img.onload=resolve;img.onerror=()=>reject(Error('Unsupported preview'));img.src=source;
      });
      if(!img.naturalWidth||!img.naturalHeight)throw Error('Invalid preview');
      const scale=Math.min(1,960/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
      return await new Promise(resolve=>{
        const limit=setTimeout(()=>resolve(null),3000);
        canvas.toBlob(blob=>{clearTimeout(limit);resolve(blob&&blob.size<=524288?blob:null);},'image/jpeg',0.72);
      });
    }finally{clearTimeout(timer);img.removeAttribute('src');URL.revokeObjectURL(source);}
  }
  record(item) {
    if(!item.completed)return Promise.resolve(false);
    // Serialize image decoding; never retain decoded originals for the whole batch.
    const file=item.file,id=item.id,sentAt=Date.now(),name=file.name;
    const task=async()=>{
      await this.ready;
      if(this.memory.has(id))return true;
      let preview=null;
      try{preview=await this.thumbnail(file);}catch(_){}
      const record={id,name,sentAt,preview};
      this.memory.set(id,record);
      // ArrayBuffer avoids Blob cloning failures in WebKit. Only the small JPEG
      // is copied into JS memory; original camera files are never encoded here.
      const stored={id,name,sentAt,previewBytes:preview?await preview.arrayBuffer():null};
      await this.transaction('photos','readwrite',store=>store.put(stored));
      window.dispatchEvent(new Event('personal-photos-updated'));
      return true;
    };
    this.pending=this.pending.then(task,task);return this.pending;
  }
}
globalThis.PhotoLibrary=PhotoLibrary;
const photoLibrary=new PhotoLibrary();

class EventGallery {
  constructor() {
    this.root=document.getElementById('event-gallery');this.frame=document.getElementById('gallery-open');
    this.photo=document.getElementById('gallery-photo');this.status=document.getElementById('gallery-status');
    this.hint=document.getElementById('gallery-hint');this.controls=document.getElementById('gallery-controls');
    this.dialog=document.getElementById('photo-viewer');this.large=document.getElementById('viewer-photo');
    this.viewerStatus=document.getElementById('viewer-status');this.viewerPosition=document.getElementById('viewer-position');
    this.previous=document.getElementById('viewer-prev');this.next=document.getElementById('viewer-next');
    this.items=[];this.recent=0;this.index=0;this.pauseUntil=0;this.urls=new Map();this.refreshNumber=0;
    this.frame.addEventListener('click',()=>this.open());
    document.getElementById('gallery-prev').addEventListener('click',()=>this.moveRecent(-1));
    document.getElementById('gallery-next').addEventListener('click',()=>this.moveRecent(1));
    this.previous.addEventListener('click',()=>this.moveViewer(-1));this.next.addEventListener('click',()=>this.moveViewer(1));
    document.getElementById('viewer-close').addEventListener('click',()=>this.dialog.close());
    this.dialog.addEventListener('close',()=>{document.body.classList.remove('viewer-is-open');this.pauseUntil=Date.now()+10000;this.release(this.large);});
    this.dialog.addEventListener('keydown',e=>{if(e.key==='ArrowRight'){e.preventDefault();this.moveViewer(1);}if(e.key==='ArrowLeft'){e.preventDefault();this.moveViewer(-1);}});
    this.swipe(this.frame,step=>this.moveRecent(step));this.swipe(this.dialog.querySelector('.viewer-stage'),step=>this.moveViewer(step));
    window.addEventListener('personal-photos-updated',()=>this.refresh());
    window.addEventListener('focus',()=>this.refresh());
    window.addEventListener('pageshow',()=>this.refresh());
    window.addEventListener('pagehide',()=>{this.release(this.photo);this.release(this.large);});
    this.ready=this.refresh();
    this.timer=setInterval(()=>{if(!document.hidden&&!this.dialog.open&&!globalThis.photoQueue?.running&&Date.now()>this.pauseUntil)this.moveRecent(1,false);},5000);
  }
  swipe(element,move) {
    let start=null;
    element.addEventListener('touchstart',e=>{start=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;},{passive:true});
    element.addEventListener('touchend',e=>{if(!start)return;const dx=e.changedTouches[0].clientX-start.x,dy=e.changedTouches[0].clientY-start.y;start=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5)move(dx<0?1:-1);},{passive:true});
  }
  release(target) {
    const source=this.urls.get(target);
    if(source){URL.revokeObjectURL(source);this.urls.delete(target);}
    target.removeAttribute('src');
  }
  showPicture(target,item,status) {
    this.release(target);status.textContent='';target.classList.remove('image-loading');
    target.alt=item.name || 'Fotografía enviada';
    if(item.preview){const url=URL.createObjectURL(item.preview);this.urls.set(target,url);target.src=url;}
    else status.textContent='Foto enviada. Este navegador no pudo guardar su vista previa.';
  }
  async refresh() {
    const generation=++this.refreshNumber,selected=this.items[this.index]?.id;
    const items=await photoLibrary.list();if(generation!==this.refreshNumber)return;
    this.items=items;this.recent=Math.min(this.recent,Math.max(0,Math.min(10,items.length)-1));
    this.root.hidden=false;this.frame.hidden=false;this.frame.disabled=!items.length;this.hint.hidden=!items.length;this.controls.hidden=items.length<2;
    this.frame.setAttribute('aria-label',items.length?'Ver mis fotos enviadas':'Aquí aparecerán tus fotos enviadas');
    if(items.length)this.showRecent();
    else{this.release(this.photo);this.photo.src='./assets/portada-carrusel.png';this.photo.alt='Celebración de quince años. Aquí aparecerán tus fotos enviadas.';this.status.textContent='';}
    if(this.dialog.open){this.index=Math.max(0,items.findIndex(item=>item.id===selected));this.showViewer();}
  }
  showRecent() {const item=this.items[this.recent];if(item)this.showPicture(this.photo,item,this.status);}
  moveRecent(step,manual=true) {
    const count=Math.min(this.items.length,10);if(count<2)return;
    if(manual)this.pauseUntil=Date.now()+12000;
    this.recent=(this.recent+step+count)%count;this.showRecent();
  }
  open() {
    if(!this.items.length)return;this.index=this.recent;
    this.dialog.showModal();document.body.classList.add('viewer-is-open');this.showViewer();
  }
  showViewer() {
    this.viewerPosition.textContent=(this.index+1)+' / '+this.items.length;
    this.previous.disabled=this.index===0;this.next.disabled=this.index>=this.items.length-1;
    const item=this.items[this.index];if(item)this.showPicture(this.large,item,this.viewerStatus);
  }
  moveViewer(step) {
    const target=this.index+step;
    if(target<0||target>=this.items.length)return;
    this.index=target;this.showViewer();
  }
}
const eventGallery=new EventGallery();
