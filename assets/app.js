'use strict';
    const input = document.getElementById('photos-input'), send = document.getElementById('send');
    const list = document.getElementById('photos'), selection = document.getElementById('selection');
    const progress = document.getElementById('progress'), progressText = document.getElementById('progress-text');
    const rows = new Map();
    let removing = false;
    const authorize = createPagesAuthorizer(PHOTO_CONFIG.authorizerUrl);
    const queue = new PhotoQueue({authorize, changed: render, recovery: new PhotoRecovery()});
    function render() {
      const busy = queue.running || queue.restoring || queue.starting || removing;
      input.disabled = busy;
      const visible = queue.items.filter(item => item.state !== 'completed');
      send.disabled = busy || !visible.length;
      selection.hidden = !visible.length;
      selection.textContent = visible.length + (visible.length === 1 ? ' fotografía seleccionada' : ' fotografías seleccionadas');
      progress.hidden = !queue.running;
      progressText.textContent = 'Enviando fotos · ' + queue.items.filter(item => item.state === 'completed').length + '/' + queue.items.length;
      for (const [item, row] of rows) {
        if (!visible.includes(item)) {URL.revokeObjectURL(row.url); row.element.remove(); rows.delete(item);}
      }
      for (const item of visible) {
        let row = rows.get(item);
        if (!row) {
          const element = document.createElement('li'); element.className = 'photo';
          const img = document.createElement('img'); img.alt = item.file.name; img.loading = 'lazy'; img.decoding = 'async';
          const url = URL.createObjectURL(item.file); img.src = url;
          img.onerror = () => {img.removeAttribute('src'); img.alt = item.file.name;};
          const detail = document.createElement('small'); detail.hidden = true; detail.className = 'error'; detail.setAttribute('role','alert');
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'photo-remove';
          remove.textContent = '×'; remove.setAttribute('aria-label', 'Quitar ' + item.file.name); remove.title = 'Quitar foto';
          remove.addEventListener('click', () => removePhoto(item));
          element.append(img, remove, detail); list.append(element); row = {element, url, detail, remove}; rows.set(item, row);
        }
        row.remove.disabled = busy;
        row.element.dataset.state = item.state; row.detail.hidden = item.state !== 'failed';
        row.detail.textContent = item.state === 'failed' ? item.message : '';
      }
    }
    async function removePhoto(item) {
      if (removing || queue.running || queue.starting || queue.restoring || !queue.items.includes(item)) return;
      removing = true; render();
      try {
        await queue.recovery.exclusive(async () => {
          const removed = await queue.recovery.remove(item.id);
          if (removed === null && queue.recovery.db && !queue.recovery.memoryOnly.has(item.id))
            throw new Error('No se pudo quitar esta fotografía. Inténtalo de nuevo.');
          queue.recovery.memoryOnly.delete(item.id);
          queue.items = queue.items.filter(entry => entry !== item);
          item.sessionUrl = null; item.permit = null;
        });
      } catch (error) {item.state = 'failed'; item.message = error.message;}
      finally {removing = false; render();}
    }
    input.addEventListener('change', () => {queue.add(Array.from(input.files)); input.value = '';});
    async function sendBatch() {
      if (removing) return;
      await queue.start();
      if (queue.items.some(item => item.state === 'completed')) window.dispatchEvent(new Event('photos-uploaded'));
      queue.items = queue.items.filter(item => item.state !== 'completed'); render();
    }
    send.addEventListener('click', sendBatch);
    queue.ready.then(() => {if(queue.items.some(item=>item.autoResume))sendBatch();});
    window.addEventListener('online', () => {if(queue.items.some(item=>item.retryable))sendBatch();});
    window.addEventListener('pagehide', () => {for (const row of rows.values()) {URL.revokeObjectURL(row.url); row.element.remove();} rows.clear();});
    window.addEventListener('pageshow', render);
