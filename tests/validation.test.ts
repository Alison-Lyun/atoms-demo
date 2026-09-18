import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { parse as parseJavaScript } from 'acorn';
import { MAX_ARTIFACT_BYTES, validateArtifact } from '../src/lib/validation';
import { buildPreviewDocument, PREVIEW_CSP } from '../src/lib/preview-document';

const document = (body = '', head = '') => `<!DOCTYPE html><html><head><title>Test app</title>${head}</head><body>${body}</body></html>`;

describe('artifact validation', () => {
  it('accepts a self-contained interactive app using async appStorage', () => {
    const html = document('<form id="todo"><input><button>Add</button></form><script>(async () => { await appStorage.ready(); const items = await appStorage.get("items") || []; document.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); await appStorage.set("items", [...items, "new"]); }); })();</script>', '<style>body { color: #123; } button:hover { opacity: .8; }</style>');
    expect(validateArtifact(html)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['external script', '<script src="https://cdn.example.com/lib.js"></script>'],
    ['image network request', '<img src="//example.com/track">'],
    ['relative resource', '<img src="/image.png">'],
    ['javascript URL', '<a href="java&#115;cript:alert(1)">go</a>'],
    ['iframe', '<iframe srcdoc="hello"></iframe>'],
    ['object', '<object data="data:text/html,hello"></object>'],
    ['base', '<base href="https://example.com/">'],
    ['refresh', '<meta http-equiv="refresh" content="0;url=https://example.com">'],
    ['form destination', '<form action="/submit"></form>'],
    ['form override', '<button formaction="https://example.com">Submit</button>'],
    ['external style', '<style>@import "https://example.com/styles.css";</style>'],
    ['CSS external image', '<style>body { background:url(https://example.com/pixel) }</style>'],
    ['escaped CSS request', '<style>body { background:u\\72l(https://example.com/pixel) }</style>'],
    ['SVG active data', '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'],
    ['template script', '<template><script>fetch("https://example.com")</script></template>'],
    ['forbidden storage', '<script>localStorage.setItem("key", "value")</script>'],
    ['bracket storage', '<script>window["local" + "Storage"].getItem("key")</script>'],
    ['cookie', '<script>document.cookie = "key=value"</script>'],
    ['network API', '<script>fetch("https://example.com")</script>'],
    ['module import', '<script type="module">import x from "./x.js";</script>'],
    ['dynamic module', '<script>import("https://example.com/x.js")</script>'],
    ['dynamic eval', '<script>eval("1+2")</script>'],
    ['navigation', '<script>window.location.href = "https://example.com"</script>'],
    ['popup', '<script>window.open("https://example.com")</script>'],
    ['invalid handler', '<button onclick="const = broken">Click</button>'],
  ])('rejects %s', (_label, body) => {
    const result = validateArtifact(document(body));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects JavaScript syntax errors before previewing', () => {
    expect(validateArtifact(document('<script>const broken = ;</script>')).errors.join(' ')).toContain('语法错误');
  });
  it('rejects incomplete snippets and counts UTF-8 bytes', () => {
    expect(validateArtifact('<div>hello</div>').valid).toBe(false);
    expect(validateArtifact(document('中'.repeat(MAX_ARTIFACT_BYTES / 3))).valid).toBe(false);
  });
  it('accepts inert base64 images, same-page references and ordinary forms', () => {
    expect(validateArtifact(document('<img src="data:image/png;base64,aGVsbG8="><a href="#details">Details</a><form><input><button>Save</button></form>')).valid).toBe(true);
  });
  it('checks handlers as function bodies so return false remains valid', () => {
    expect(validateArtifact(document('<button onclick="return false">Click</button>')).valid).toBe(true);
  });
  it('rejects excessively deep HTML without exhausting the JavaScript stack', () => {
    expect(validateArtifact(document('<div>'.repeat(2000) + 'nested' + '</div>'.repeat(2000))).errors.join(' ')).toContain('嵌套过深');
  });
});

describe('preview document', () => {
  const nonce = '12345678-abcd-1234-abcd-123456789012';
  it('inserts CSP and a parseable bridge before generated code', () => {
    const html = buildPreviewDocument(document('<p>app</p>', '<script>window.generated = true;</script>'), nonce, 'http://localhost:3000');
    const parsed = parse(html);
    const root = parsed.childNodes.find(node => 'tagName' in node && node.tagName === 'html');
    expect(root && 'childNodes' in root).toBeTruthy();
    if (!root || !('childNodes' in root)) throw new Error('No html root');
    const head = root.childNodes.find(node => 'tagName' in node && node.tagName === 'head');
    if (!head || !('childNodes' in head)) throw new Error('No head');
    expect(head.childNodes.slice(0, 2).map(node => node.nodeName)).toEqual(['meta', 'script']);
    const script = head.childNodes[1];
    if (!('childNodes' in script)) throw new Error('No bootstrap');
    const source = script.childNodes.map(node => 'value' in node ? node.value : '').join('');
    expect(() => parseJavaScript(source, { ecmaVersion: 'latest' })).not.toThrow();
    expect(source).toContain("event.source !== parent || event.origin !== parentOrigin");
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("unhandledrejection");
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('window.generated'));
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).not.toContain('unsafe-eval');
  });
  it('rejects invalid bridge identity and parent origins', () => {
    expect(() => buildPreviewDocument(document(), '</script>', 'https://example.com')).toThrow();
    expect(() => buildPreviewDocument(document(), nonce, '*')).toThrow();
    expect(() => buildPreviewDocument(document(), nonce, 'https://example.com/path')).toThrow();
    expect(() => buildPreviewDocument(document(), nonce, 'file://')).toThrow();
  });
});
