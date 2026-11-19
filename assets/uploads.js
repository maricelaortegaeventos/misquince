'use strict';
class UploadError extends Error {
  constructor(message, retryable = false, renew = false) { super(message); this.retryable = retryable; this.renew = renew; }
}
class DirectUpload {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
    this.timeoutMs = options.timeoutMs;
  }
  async delay(attempt) { await this.sleep(Math.min(32000, 1000 * 2 ** attempt) + Math.floor(this.random() * 1000)); }
  async interpret(response, size) {
    if (response.status === 200 || response.status === 201) {
      const data = await response.json();
      if (!data.id || Number(data.size) !== size) throw new UploadError('No se pudo confirmar esta fotografía.');
      return {completed: true};
    }
    if (response.status === 308) {
      const range = response.headers.get('Range');
      if (!range) return {offset: 0}; // Google documents missing Range as zero received bytes.
      const match = /^bytes=0-(\d+)$/.exec(range);
      const offset = match ? Number(match[1]) + 1 : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new UploadError('No se pudo reanudar esta fotografía.');
      return {offset};
    }
    if (response.status === 404 || response.status === 410) throw new UploadError('La sesión de carga venció.', true, true);
    const body = await response.text();
    const temporary = [408,429,500,502,503,504].includes(response.status) ||
      (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(body));
    throw new UploadError(temporary ? 'La conexión o Google están ocupados. Inténtalo de nuevo.' : 'No se pudo enviar esta fotografía.', temporary);
  }
  async put(item, headers, body) {
    if (!/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(item.sessionUrl || ''))
      throw new UploadError('No se pudo autorizar esta fotografía.');
    const controller = new AbortController();
    // Bound the full response, including its body. Slow originals get a size-based deadline.
    const timeout = this.timeoutMs ?? (headers['Content-Range']?.startsWith('bytes */') ? 30000 :
      Math.min(900000, Math.max(120000, Math.ceil(body.size / 32768) * 1000)));
    let timer;
    try {
      return await Promise.race([
        (async () => this.interpret(await this.fetch(item.sessionUrl, {method: 'PUT', credentials: 'omit',
          referrerPolicy: 'no-referrer', headers, body, signal: controller.signal}), item.file.size))(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new UploadError('La conexión tardó demasiado. Reintentando.', true));
        }, timeout); })
      ]);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('Se interrumpió la conexión. Inténtalo de nuevo.', true);
    } finally { clearTimeout(timer); }
  }
  async send(item, renew) {
    // A failed previous attempt must query the existing session before transmitting more bytes.
    let probe = item.needsProbe === true, offset = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        if (item.completed) return;
        if (probe) {
          const state = await this.put(item, {'Content-Range': 'bytes */' + item.file.size}, new Blob([]));
          if (state.completed) { item.completed = true; return; }
          offset = state.offset; probe = false;
        }
        if (offset === item.file.size) {
          // A 308 with all bytes acknowledged still needs its final server response.
          throw new UploadError('Google aún no confirmó esta fotografía.', true);
        }
        const headers = {'Content-Type': item.mime};
        if (offset > 0) headers['Content-Range'] = 'bytes ' + offset + '-' + (item.file.size - 1) + '/' + item.file.size;
        item.needsProbe = true;
        const state = await this.put(item, headers, offset ? item.file.slice(offset) : item.file);
        if (state.completed) { item.completed = true; item.needsProbe = false; return; }
        offset = state.offset;
      } catch (error) {
        if (!(error instanceof UploadError) || !error.retryable || attempt === 7) throw error;
        if (error.renew) {
          item.sessionUrl = null; await renew(item);
          if (item.completed) return;
          item.needsProbe = false; probe = false; offset = 0;
        } else probe = true;
        await this.delay(attempt);
      }
    }
    throw new UploadError('No se pudo terminar esta fotografía. Inténtalo de nuevo.');
  }
}

async function photoMime(file) {
  if (!file.size) throw new UploadError('Este archivo está vacío.');
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const ascii = (start, count) => String.fromCharCode(...bytes.slice(start, start + count));
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return 'image/png';
  if (ascii(0,4) === 'RIFF' && ascii(8,4) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(ascii(0,6))) return 'image/gif';
  if (ascii(0,2) === 'BM') return 'image/bmp';
  if ((ascii(0,4) === 'II*\0') || ascii(0,4) === 'MM\0*') return 'image/tiff';
  if (ascii(4,4) === 'ftyp') {
    const end = Math.min(new DataView(bytes.buffer).getUint32(0), bytes.length), brands = [ascii(8,4)];
    for (let i=16;i+4<=end;i+=4) brands.push(ascii(i,4));
    if (brands.some(b => ['avif','avis'].includes(b))) return 'image/avif';
    if (brands.some(b => ['heic','heix','hevc','hevx'].includes(b))) return 'image/heic';
    if (brands.some(b => ['mif1','msf1'].includes(b))) return 'image/heif';
  }
  throw new UploadError('Este archivo no es una fotografía compatible.');
}

class PhotoQueue {
  constructor(options) {
    this.authorize = options.authorize; this.changed = options.changed || (() => {});
    this.transport = options.transport || new DirectUpload();
    this.items = []; this.running = false; this.authorizing = null;
    this.concurrency = 3;
    this.recovery = options.recovery;
    this.authorizationTimeoutMs = options.authorizationTimeoutMs ?? 45000;
    this.restoring = !!this.recovery;
    this.ready = this.restore();
  }
  async restore() {
    if (!this.recovery) return;
    try {
      const records = await this.recovery.load();
      this.items.push(...records.map(record => ({...record, state: 'pending', message: '', restored: true,
        autoResume: true, needsProbe: !!record.sessionUrl})));
    } finally { this.restoring = false; this.changed(); }
  }
  add(files) {
    if (this.running) return;
    for (const file of files) this.items.push({file, id: globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random(),
      state: 'pending', message: '', sessionUrl: null, permit: null});
    this.changed();
  }
  async checkpoint(item) { if (this.recovery) await this.recovery.save(item); }
  async authorizeGroup(group) {
    let pending = group;
    // Keep the same identifier after an ambiguous RPC outcome; the server can reuse its response.
    let requestId = globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random();
    for (let attempt = 0; pending.length && attempt < 16; attempt++) {
      let result, timer;
      try { result = await Promise.race([
        this.authorize(pending.map(item => ({name:item.file.name, size:item.file.size, mime:item.mime, permit:item.permit})), requestId),
        new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error('Authorization timeout')),this.authorizationTimeoutMs);})
      ]); }
      catch (_) { result = {ok:false,retryable:true,message:'No se pudo conectar con el servicio. Inténtalo de nuevo.'}; }
      finally { clearTimeout(timer); }
      const retry = [];
      pending.forEach((item, i) => {
        const answer = result && result.ok && Array.isArray(result.files) ? result.files[i] : result;
        if (answer && answer.permit) item.permit = answer.permit;
        if (answer && answer.ok && (answer.sessionUrl || answer.completed)) {
          item.sessionUrl = answer.sessionUrl; item.completed = answer.completed === true;
        } else if (answer && answer.retryable && attempt < 15) retry.push(item);
        else { item.state='failed'; item.retryable=answer?.retryable===true; item.message=answer && answer.message || 'No se pudo autorizar esta fotografía.'; }
      });
      await Promise.all(pending.map(async item => {
        try { await this.checkpoint(item); }
        catch (error) {item.state='failed';item.message=error.message;}
      }));
      for(let i=retry.length-1;i>=0;i--)if(retry[i].state==='failed')retry.splice(i,1);
      if (result?.ok) requestId = globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random();
      pending = retry;
      if (pending.length) await this.transport.delay(attempt);
    }
  }
  async session(item) {
    while (!item.sessionUrl && !item.completed && item.state !== 'failed') {
      if (!this.authorizing) {
        const group=this.items.filter(entry => ['pending','sending'].includes(entry.state) && !entry.sessionUrl && !entry.completed).slice(0,10);
        // All workers share one logical batch. An uncancellable timed-out RPC reuses the same key.
        this.authorizing=this.authorizeGroup(group).finally(()=>{this.authorizing=null;});
      }
      await this.authorizing;
    }
    if(item.state==='failed') throw new UploadError(item.message,item.retryable===true);
  }
  async start() {
    await this.ready;
    if (this.starting || this.running) return;
    this.starting = true;
    try { return await (this.recovery ? this.recovery.exclusive(() => this.run()) : this.run()); }
    finally { this.starting = false; this.changed(); }
  }
  async run() {
    if (this.running) return;
    if (this.recovery && this.items.some(item => item.restored)) {
      const records = new Map((await this.recovery.load()).map(item => [item.id,item]));
      // Another tab may have finished these records while this tab waited for its lock.
      this.items = this.items.filter(item => !item.restored || records.has(item.id));
      for (const item of this.items.filter(item => item.restored)) {
        Object.assign(item, records.get(item.id), {state:'pending', needsProbe:!!records.get(item.id).sessionUrl});
        item.restored = false;
      }
    }
    const batch=this.items.filter(item => item.state==='pending'||item.state==='failed');
    if (!batch.length) return;
    this.running=true; const started=performance.now(); let next=0;
    for(const item of batch) {item.state='pending'; item.message='';item.retryable=false;}
    this.changed();
    try {
      // Read only small signatures, never the whole selection into JS memory.
      for(const item of batch) try {item.mime=await photoMime(item.file);} catch(error){item.state='failed';item.message=error.message;}
      await Promise.all(batch.filter(item=>item.state!=='failed').map(async item=>{
        try {await this.checkpoint(item);}catch(error){item.state='failed';item.message=error.message;}
      }));
      const worker=async()=>{
        while(next<batch.length) {
          const item=batch[next++]; if(item.state==='failed')continue;
          item.state='sending';this.changed();
          try {
            await this.session(item);
            await this.checkpoint(item);
            await this.transport.send(item,async current=>{current.state='sending';await this.session(current);});
            item.state='completed';item.sessionUrl=null;item.permit=null;
            if (this.recovery) await this.recovery.remove(item.id);
          } catch(error) {item.state='failed';item.retryable=error.retryable===true;item.message=error.message||'No se pudo enviar esta fotografía.';}
          if (item.state==='failed') try {await this.checkpoint(item);} catch (_) {}
          this.changed();
        }
      };
      await Promise.all(Array.from({length:Math.min(this.concurrency,batch.length)},worker));
    } finally {
      this.lastRun={files:batch.length,completed:batch.filter(item=>item.state==='completed').length,
        failed:batch.filter(item=>item.state==='failed').length,bytes:batch.reduce((n,item)=>n+item.file.size,0),elapsedMs:performance.now()-started};
      this.running=false;this.changed();
    }
  }
}

// Best-effort private browser recovery. No OAuth tokens, analytics, prompts, or whole-file JS reads.
class PhotoRecovery {
  constructor() { this.name='mis-xv-1rvzVYSK24dYe4eEN6lPpc3qtTScLC2-recovery'; this.db=null; this.opening=null; this.unavailable=false; this.memoryOnly=new Set(); }
  async open() {
    if (this.db) return this.db;
    if (this.opening) return this.opening;
    if (this.unavailable || !globalThis.indexedDB) return null;
    this.opening = new Promise(resolve => {
      let request;
      try { request=indexedDB.open(this.name,1); } catch (_) {resolve(null);return;}
      let done=false;
      const timer=setTimeout(()=>{done=true;resolve(null);},3000);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('uploads'))request.result.createObjectStore('uploads',{keyPath:'id'});};
      request.onsuccess=()=>{clearTimeout(timer);if(done)request.result.close();else resolve(request.result);};
      request.onerror=request.onblocked=()=>{clearTimeout(timer);done=true;resolve(null);};
    });
    this.db=await this.opening;this.opening=null;if(!this.db)this.unavailable=true;
    return this.db;
  }
  async transaction(mode,work) {
    try {
      const db=await this.open();if(!db)return null;
      return await new Promise(resolve=>{
        const tx=db.transaction('uploads',mode),request=work(tx.objectStore('uploads'));
        let done=false;const timer=setTimeout(()=>{if(!done){try{tx.abort();}catch(_){}resolve(null);}},5000);
        const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
        tx.oncomplete=()=>finish(request?.result ?? true);
        tx.onerror=tx.onabort=()=>finish(null);
      });
    } catch (_) { return null; } // Private mode/storage exhaustion must not prevent direct upload.
  }
  async save(item) {
    if(this.memoryOnly.has(item.id))return null;
    // Some WebKit versions cannot clone File handles. Persist a Blob plus its name instead.
    const record={id:item.id,file:item.file.slice(0,item.file.size,item.file.type),name:item.file.name,lastModified:item.file.lastModified,
      mime:item.mime,sessionUrl:item.sessionUrl,permit:item.permit,
      expires:item.expires || Date.now()+604800000};
    item.expires=record.expires;
    const result=await this.transaction('readwrite',store=>store.put(record));
    if(result===null&&this.db){
      // Remove stale durable state before falling back to memory. A reload must never upload it twice.
      const removed=await this.remove(item.id);
      if(removed===null)throw new UploadError('El navegador no pudo preparar esta fotografía. Inténtalo de nuevo.');
      this.memoryOnly.add(item.id);
    }
    return result;
  }
  async load() {
    const records=await this.transaction('readonly',store=>store.getAll()) || [];
    const valid=[];
    for(const record of records) {
      if(record.expires>Date.now() && record.file?.size>0){
        if(record.name)record.file=new File([record.file],record.name,{type:record.file.type,lastModified:record.lastModified});
        valid.push(record);
      }
      else await this.remove(record.id);
    }
    return valid;
  }
  async remove(id) { return this.transaction('readwrite',store=>store.delete(id)); }
  async exclusive(work) {
    if(globalThis.navigator?.locks)return navigator.locks.request(this.name,work);
    return work();
  }
}
globalThis.DirectUpload=DirectUpload;
globalThis.PhotoQueue=PhotoQueue;
globalThis.PhotoRecovery=PhotoRecovery;
