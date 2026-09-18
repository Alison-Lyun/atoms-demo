import { parse, parseFragment, serialize } from 'parse5';

export const PREVIEW_CHANNEL = 'atoms-preview-v1';
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

/** Insert the trusted bootstrap before any generated scripts; never evaluate HTML on the server. */
export function buildPreviewDocument(html: string, nonce: string, parentOrigin: string): string {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(nonce)) throw new Error('Invalid preview nonce');
  const origin = new URL(parentOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parentOrigin) throw new Error('Invalid preview parent origin');
  const safe = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const bootstrap = `(() => {
    'use strict';
    const nonce = ${safe(nonce)};
    const parentOrigin = ${safe(parentOrigin)};
    const channel = ${safe(PREVIEW_CHANNEL)};
    const sendToParent = parent.postMessage.bind(parent);
    const send = payload => sendToParent({ channel, nonce, ...payload }, parentOrigin);
    let initialized = false;
    let nextId = 0;
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const requests = new Map();
    const report = error => send({ event: 'runtime-error', error: String(error && error.message || error || 'Unknown runtime error').slice(0, 2000) });
    addEventListener('error', event => report(event.error || event.message));
    addEventListener('unhandledrejection', event => report(event.reason));
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== parentOrigin) return;
      const message = event.data;
      if (!message || message.channel !== channel || message.nonce !== nonce) return;
      if (message.event === 'init' && !initialized) { initialized = true; clearInterval(hello); resolveReady(); }
      if (message.event === 'response' && typeof message.id === 'string') {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok) request.resolve(message.value); else request.reject(new Error(message.error || 'Storage request failed'));
      }
    });
    const request = async (op, key, value) => {
      await ready;
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('Storage request timed out')); }, 7000);
        requests.set(id, { resolve, reject, timer });
        send({ event: 'request', id, op, key, ...(op === 'set' ? { value } : {}) });
      });
    };
    Object.defineProperty(window, 'appStorage', { configurable: false, writable: false, value: Object.freeze({
      ready: () => ready,
      get: key => request('get', key),
      set: (key, value) => request('set', key, value).then(() => undefined)
    }) });
    document.addEventListener('submit', event => event.preventDefault(), true);
    const submitLocally = (form, submitter) => {
      if (!form.noValidate && !submitter?.formNoValidate && !form.reportValidity()) return;
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }));
    };
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('a,area')) { event.preventDefault(); return; }
      const control = event.target.closest('button,input');
      if (control && control.form && !control.disabled && (control.type === 'submit' || control.type === 'image')) {
        event.preventDefault();
        // Sandbox omits allow-forms, which can suppress native submit events.
        // Dispatch the local event explicitly; the capture listener above and
        // form-action CSP still prevent any document navigation.
        queueMicrotask(() => submitLocally(control.form, control));
      }
    }, true);
    document.addEventListener('keydown', event => {
      const input = event.target;
      if (event.key === 'Enter' && !event.isComposing && input instanceof HTMLInputElement && input.form && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file'].includes(input.type)) {
        event.preventDefault();
        queueMicrotask(() => submitLocally(input.form, null));
      }
    }, true);
    addEventListener('load', () => send({ event: 'loaded' }));
    const hello = setInterval(() => send({ event: 'hello' }), 150);
    send({ event: 'hello' });
  })();`;
  const document = parse(html);
  const root = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html');
  if (!root || !('childNodes' in root)) throw new Error('Preview document is missing html');
  const head = root.childNodes.find(node => 'tagName' in node && node.tagName === 'head');
  if (!head || !('childNodes' in head)) throw new Error('Preview document is missing head');
  const trusted = parseFragment(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${bootstrap}</script>`);
  for (const node of trusted.childNodes) node.parentNode = head;
  head.childNodes.unshift(...trusted.childNodes);
  return serialize(document);
}
