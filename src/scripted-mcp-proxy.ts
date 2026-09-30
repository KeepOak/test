/** Only trusted relay code lives here; server HTML is loaded into a second opaque frame. */
export function scriptedProxyPage(nonce: string): string {
  const permissions = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'";
  const script = `const nonce=${JSON.stringify(nonce)};let inner;
    addEventListener('message',event=>{
      if(event.source===parent&&event.data?.nonce===nonce){
        const rpc=event.data.rpc;
        if(rpc?.method==='ui/notifications/sandbox-resource-ready'&&!inner){
          inner=document.createElement('iframe');inner.setAttribute('sandbox','allow-scripts');
          inner.setAttribute('allow',${JSON.stringify(permissions)});inner.setAttribute('referrerpolicy','no-referrer');
          inner.width='100%';inner.height='500';
          inner.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; connect-src &apos;none&apos;; frame-src &apos;none&apos;; object-src &apos;none&apos;; base-uri &apos;none&apos;; form-action &apos;none&apos;">'+rpc.params.html;
          document.body.append(inner);
        }else if(inner)inner.contentWindow.postMessage(rpc,'*');
      }else if(inner&&event.source===inner.contentWindow){
        try{if(JSON.stringify(event.data).length<=32768)parent.postMessage({nonce,rpc:event.data},'*');}catch{}
      }
    });
    parent.postMessage({nonce,rpc:{jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'}},'*');`;
  return `<!doctype html><meta charset="utf-8"><body><script>${script}</script></body>`;
}
export const scriptedProxyHeaders: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), fullscreen=(), clipboard-write=()',
  'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
};
