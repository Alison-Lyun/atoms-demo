'use client';

import { useEffect, useRef, useState } from 'react';
import type { AppState, JsonValue } from '@/lib/types';
import { buildPreviewDocument, PREVIEW_CHANNEL } from '@/lib/preview-document';

export interface PreviewFrameProps {
  html: string;
  projectId: string;
  versionId: string;
  initialState: AppState;
  mode: 'candidate' | 'published';
  readOnly?: boolean;
  onValidated?: (result: { ok: boolean; error?: string; stagedState: AppState }) => void;
  onStore?: (key: string, value: JsonValue) => Promise<void>;
  onRuntimeError?: (error: string) => void;
}

const MAX_STATE_BYTES = 64 * 1024;
const disallowedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyAllowed = (key: unknown): key is string => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(key) && !disallowedKeys.has(key);

function isJson(value: unknown): value is JsonValue {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10000 || depth > 20) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      const valid = item.every(child => visit(child, depth + 1));
      seen.delete(item);
      return valid;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    const valid = Object.entries(item).every(([key, child]) => !disallowedKeys.has(key) && visit(child, depth + 1));
    seen.delete(item);
    return valid;
  };
  return visit(value, 0);
}

/** Runs each version in an opaque-origin sandbox. Startup validation is not a functional test. */
export function PreviewFrame(props: PreviewFrameProps) {
  const { html, projectId, versionId, mode } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const identityRef = useRef<{ html: string; projectId: string; versionId: string; mode: string; nonce: string } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const previousIdentity = identityRef.current;
    const nonce = previousIdentity && previousIdentity.html === html && previousIdentity.projectId === projectId && previousIdentity.versionId === versionId && previousIdentity.mode === mode
      ? previousIdentity.nonce : crypto.randomUUID();
    identityRef.current = { html, projectId, versionId, mode, nonce };
    let disposed = false;
    let initialized = false;
    let loaded = false;
    let completed = false;
    let pending = 0;
    let lastRequestId = 0;
    let queue = Promise.resolve();
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const runtimeErrors = new Set<string>();
    let state: AppState = copy(latest.current.initialState);
    setStatus('starting');
    const isCurrent = () => !disposed && latest.current.projectId === projectId && latest.current.versionId === versionId && latest.current.mode === mode && latest.current.html === html;

    const send = (payload: Record<string, unknown>) => {
      // srcdoc has an opaque origin, so targetOrigin must be '*'. The receiver checks
      // the exact parent origin and nonce; incoming messages check the exact Window.
      if (isCurrent()) iframe.contentWindow?.postMessage({ channel: PREVIEW_CHANNEL, nonce, ...payload }, '*');
    };
    const finish = (ok: boolean, error?: string) => {
      if (!isCurrent() || completed) return;
      completed = true;
      clearTimeout(stableTimer);
      clearTimeout(deadline);
      setStatus(ok ? 'ready' : 'error');
      if (mode === 'candidate') latest.current.onValidated?.({ ok, ...(error ? { error } : {}), stagedState: copy(state) });
    };
    const settle = () => {
      clearTimeout(stableTimer);
      if (isCurrent() && !completed && initialized && loaded && pending === 0) {
        stableTimer = setTimeout(() => {
          if (pending === 0) finish(true);
        }, 600);
      }
    };
    const fail = (message: string) => {
      const error = message.slice(0, 2000);
      if (!isCurrent() || runtimeErrors.has(error)) return;
      if (runtimeErrors.size < 20) {
        runtimeErrors.add(error);
        latest.current.onRuntimeError?.(error);
      }
      if (!completed) finish(false, error);
      else setStatus('error');
    };
    const onMessage = (event: MessageEvent) => {
      if (!isCurrent() || event.source !== iframe.contentWindow || event.origin !== 'null') return;
      const message: unknown = event.data;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const data = message as Record<string, unknown>;
      if (data.channel !== PREVIEW_CHANNEL || data.nonce !== nonce) return;
      if (data.event === 'hello') {
        initialized = true;
        send({ event: 'init' });
        settle();
        return;
      }
      if (data.event === 'loaded') { loaded = true; settle(); return; }
      if (data.event === 'runtime-error') {
        if (typeof data.error === 'string') fail(data.error);
        return;
      }
      if (data.event !== 'request' || typeof data.id !== 'string' || !/^\d{1,10}$/.test(data.id)) return;
      const id = data.id;
      const reply = (payload: Record<string, unknown>) => send({ event: 'response', id, ...payload });
      if (Number(id) <= lastRequestId) return;
      lastRequestId = Number(id);
      if (!keyAllowed(data.key) || !['get', 'set'].includes(String(data.op))) {
        reply({ ok: false, error: 'Invalid appStorage request or key (1–64 ASCII letters, digits, underscores or hyphens).' });
        return;
      }
      if (pending >= 100) { reply({ ok: false, error: 'Too many pending storage requests.' }); return; }
      const key = data.key;
      const op = data.op;
      const value = data.value;
      if (op === 'set' && (!isJson(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_STATE_BYTES)) {
        reply({ ok: false, error: 'Storage values must be finite JSON within the 64 KiB quota and depth 20.' });
        return;
      }
      ++pending;
      clearTimeout(stableTimer);
      queue = queue.then(async () => {
        if (!isCurrent()) return;
        try {
          if (op === 'get') {
            reply({ ok: true, value: Object.hasOwn(state, key) ? copy(state[key]) : null });
            return;
          }
          if (latest.current.readOnly) throw new Error('This preview is read-only while a generation or restore is in progress.');
          if (mode === 'candidate' && completed) throw new Error('Candidate validation has finished. Wait for publication before saving.');
          const nextState = { ...state, [key]: copy(value as JsonValue) };
          if (Object.keys(nextState).length > 100) throw new Error('Project appStorage supports at most 100 keys.');
          if (new TextEncoder().encode(JSON.stringify(nextState)).byteLength > MAX_STATE_BYTES) throw new Error('Project appStorage quota exceeded (64 KiB).');
          if (mode === 'published') {
            if (!latest.current.onStore) throw new Error('Persistent storage is not available for this preview.');
            await latest.current.onStore(key, nextState[key]);
          }
          if (!isCurrent()) return;
          state = nextState;
          reply({ ok: true, value: null });
        } catch (error) {
          reply({ ok: false, error: (error instanceof Error ? error.message : 'Storage request failed').slice(0, 2000) });
        } finally {
          --pending;
          settle();
        }
      });
    };

    window.addEventListener('message', onMessage);
    deadline = setTimeout(() => {
      if (!completed) fail('预览在 8 秒内未完成启动或初始存储请求，请检查 appStorage 初始化及长时间运行的脚本。');
    }, 8000);
    try {
      const document = buildPreviewDocument(html, nonce, window.location.origin);
      // Replaying an effect must not enqueue a second iframe navigation. The
      // same version keeps its nonce; a different identity always rotates it.
      if (iframe.getAttribute('srcdoc') !== document) iframe.srcdoc = document;
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to create preview');
    }
    return () => {
      disposed = true;
      clearTimeout(stableTimer);
      clearTimeout(deadline);
      window.removeEventListener('message', onMessage);
      // Do not navigate to about:blank here. React development StrictMode replays
      // effects on the same iframe; that queued navigation can overwrite the next
      // srcdoc. Unmount removes the element, and replacement gets a fresh nonce.
    };
  }, [html, projectId, versionId, mode]);

  return <iframe
    ref={iframeRef}
    title="Generated application preview"
    data-testid="app-preview"
    data-preview-status={status}
    data-preview-mode={mode}
    className="preview-frame"
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'"
    style={{ width: '100%', height: '100%', minHeight: 420, border: 0, background: 'white' }}
  />;
}

export default PreviewFrame;
