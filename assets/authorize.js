'use strict';
function createPagesAuthorizer(url, options = {}) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url))
    throw new Error('No se pudo preparar la conexión.');
  const send = options.fetch || globalThis.fetch.bind(globalThis);
  const origin = options.origin || location.origin;
  const hash = options.hash ?? location.hash;
  const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(hash);
  const qr = match ? match[1] : '';
  const request = async function(payload) {
    if (!qr) return {ok:false,code:'QR',retryable:false,message:'Abre esta página desde el QR de la fiesta.'};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 40000);
    try {
      const response = await send(url, {
        method:'POST', mode:'cors', credentials:'omit', redirect:'follow',
        referrerPolicy:'no-referrer', cache:'no-store',
        headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:JSON.stringify({...payload,qr,origin}), signal:controller.signal
      });
      if (!response.ok) throw new Error('Conexión interrumpida.');
      const result = await response.json();
      if (!result || typeof result.ok !== 'boolean') throw new Error('Respuesta incompleta.');
      return result;
    } finally {clearTimeout(timer);}
  };
  const authorize = async (files,requestId) => {
    if(!qr)return {ok:false,code:'QR',retryable:false,message:'Abre esta página desde el QR de la fiesta.'};
    const browserId=options.identity?await options.identity():undefined;
    return request({files,requestId,...(browserId?{browserId}:{})});
  };
  return authorize;
}
