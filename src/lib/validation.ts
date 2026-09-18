import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { parse as parseJavaScript } from 'acorn';

type HtmlNode = DefaultTreeAdapterMap['node'];
type AstNode = Record<string, unknown>;

export const MAX_ARTIFACT_BYTES = 150_000;
const forbiddenTags = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'link', 'portal', 'fencedframe', 'foreignobject']);
const forbiddenGlobals = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'ServiceWorker', 'eval', 'Function', 'location']);
const forbiddenProperties = new Set([...forbiddenGlobals, 'sendBeacon', 'serviceWorker', 'open', 'write', 'writeln']);
const resourceAttributes = new Set(['src', 'href', 'xlink:href', 'poster', 'background', 'data', 'manifest', 'codebase', 'archive']);

function constantString(node: unknown, depth = 0): string | undefined {
  if (!node || typeof node !== 'object' || depth > 100) return undefined;
  const value = node as AstNode;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'BinaryExpression' && value.operator === '+') {
    const left = constantString(value.left, depth + 1);
    const right = constantString(value.right, depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function checkJavaScript(source: string, errors: Set<string>, label: string, handler = false, module = false) {
  let ast: unknown;
  try {
    ast = parseJavaScript(handler ? `function eventHandler(event) {\n${source}\n}` : source, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' });
  } catch (error) {
    errors.add(`${label} JavaScript 语法错误：${error instanceof Error ? error.message : '无法解析'}`);
    return;
  }
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object') return;
    if (depth > 150) { errors.add('JavaScript 嵌套过深，请简化表达式和函数层级。'); return; }
    if (Array.isArray(value)) { value.forEach(child => visit(child, depth + 1)); return; }
    const node = value as AstNode;
    if (node.type === 'Identifier' && typeof node.name === 'string' && forbiddenGlobals.has(node.name)) {
      errors.add(`禁止使用 ${node.name}；持久化请使用 await appStorage.get/set，应用必须自包含且不能发起网络请求。`);
    }
    if (node.type === 'MemberExpression') {
      const property = node.property as AstNode | undefined;
      const name = node.computed ? constantString(property) : typeof property?.name === 'string' ? property.name : undefined;
      if (name && forbiddenProperties.has(name)) errors.add(`禁止访问 ${name}；请使用受控 appStorage 接口且避免导航、动态代码及网络访问。`);
    }
    if (['ImportDeclaration', 'ImportExpression', 'ExportAllDeclaration'].includes(String(node.type)) || (node.type === 'ExportNamedDeclaration' && node.source)) {
      errors.add('禁止 import 外部模块；请将全部逻辑写为内联 JavaScript。');
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode | undefined;
      const name = callee?.type === 'Identifier' ? callee.name : undefined;
      const args = node.arguments as unknown[] | undefined;
      if ((name === 'setTimeout' || name === 'setInterval') && typeof constantString(args?.[0]) === 'string') errors.add('定时器必须使用函数回调，不能执行字符串代码。');
    }
    for (const [key, child] of Object.entries(node)) if (!['start', 'end', 'loc'].includes(key)) visit(child, depth + 1);
  };
  visit(ast);
}

function permittedUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || url.startsWith('#')) return true;
  // Only inert, embedded media is permitted. SVG data URLs can contain active content.
  return /^data:(?:image\/(?:png|gif|jpe?g|webp|avif)|font\/(?:woff2?|ttf|otf)|audio\/(?:mpeg|wav|ogg)|video\/(?:mp4|webm));base64,[a-z\d+/=\s]+$/i.test(url);
}

function checkCss(source: string, errors: Set<string>) {
  const decoded = source.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_match, hex: string | undefined, character: string | undefined) => {
    const codepoint = hex ? Number.parseInt(hex, 16) : 0;
    return hex ? String.fromCodePoint(codepoint > 0 && codepoint <= 0x10ffff ? codepoint : 0xfffd) : character || '';
  }).replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@\s*import\b/i.test(decoded)) errors.add('CSS 不能包含 @import；请内联全部样式。');
  for (const match of decoded.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gis)) {
    if (!permittedUrl(match[2])) errors.add('CSS url() 只能使用页面内片段或受支持的 base64 内嵌媒体，不能加载外部资源。');
  }
}

/** Static checks complement CSP/sandbox. They are not a proof of functional correctness. */
export function validateArtifact(html: string): { valid: boolean; errors: string[] } {
  const errors = new Set<string>();
  if (typeof html !== 'string' || !html.trim()) return { valid: false, errors: ['生成结果必须是完整的 HTML 文档。'] };
  if (new TextEncoder().encode(html).byteLength >= MAX_ARTIFACT_BYTES) return { valid: false, errors: ['HTML 必须小于 150 KB（150,000 字节）。'] };
  const document = parseHtml(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html');
  if (!root || !('tagName' in root) || !root.sourceCodeLocation) errors.add('必须提供显式的 <html>、<head> 和 <body>，不能仅返回代码片段或 Markdown。');
  if (root && 'childNodes' in root) for (const tag of ['head', 'body']) {
    const element = root.childNodes.find(node => 'tagName' in node && node.tagName === tag);
    if (!element || !('tagName' in element) || !element.sourceCodeLocation) errors.add(`完整 HTML 文档缺少显式的 <${tag}>。`);
  }
  const walk = (node: HtmlNode, depth = 0) => {
    if (depth > 150) { errors.add('HTML 嵌套过深，请简化 DOM 层级。'); return; }
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      if (forbiddenTags.has(tag)) errors.add(`禁止 <${tag}>；应用只能使用自包含 HTML/CSS/JavaScript。`);
      const attrs = new Map(node.attrs.map(attribute => [(attribute.prefix ? `${attribute.prefix}:` : '') + attribute.name.toLowerCase(), attribute.value]));
      if (tag === 'meta' && attrs.has('http-equiv')) errors.add('禁止 meta http-equiv，包括刷新和自定义安全策略。');
      for (const [name, value] of attrs) {
        if (name.startsWith('on')) checkJavaScript(value, errors, `${tag}[${name}]`, true);
        if (name === 'style') checkCss(value, errors);
        if ((name === 'action' || name === 'formaction') && value.trim()) errors.add('表单不能包含提交地址；请在 submit 事件中调用 preventDefault() 并在应用内处理。');
        if (['srcdoc', 'srcset', 'imagesrcset', 'ping', 'is'].includes(name)) errors.add(`禁止 ${name} 属性；请使用简单的内嵌资源和页面内交互。`);
        if (resourceAttributes.has(name) && !permittedUrl(value)) errors.add(`${tag}[${name}] 包含外部或危险 URL；请使用页面内片段或受支持的 base64 媒体。`);
      }
      const textContent = node.childNodes.filter(child => child.nodeName === '#text').map(child => (child as DefaultTreeAdapterMap['textNode']).value).join('');
      if (tag === 'style') checkCss(textContent, errors);
      if (tag === 'script') {
        if (attrs.has('src')) errors.add('禁止外部 script；全部 JavaScript 必须内联。');
        const type = (attrs.get('type') || '').trim().toLowerCase();
        if (type === 'application/json' || type === 'application/ld+json') {
          try { JSON.parse(textContent); } catch { errors.add('JSON script 内容必须是合法 JSON。'); }
        } else if (!type || ['text/javascript', 'application/javascript', 'module'].includes(type)) {
          checkJavaScript(textContent, errors, '内联 script', false, type === 'module');
        } else errors.add(`不支持 script type="${type}"。`);
      }
      if ('content' in node) walk(node.content as HtmlNode, depth + 1);
    }
    if ('childNodes' in node) node.childNodes.forEach(child => walk(child, depth + 1));
  };
  walk(document);
  return { valid: errors.size === 0, errors: [...errors].slice(0, 30) };
}
