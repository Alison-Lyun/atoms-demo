'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight,
  CircleHelp, Code2, Copy, Database, FileCode2, FolderOpen, History,
  Layers3, LoaderCircle, Maximize2, MessageSquare, Monitor,
  Plus, RefreshCw, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Square,
  Terminal, TriangleAlert, WandSparkles, X,
} from 'lucide-react';
import { PreviewFrame } from '@/components/PreviewFrame';
import { activeRun, summary, type AppConfig, type AppState, type JsonValue, type Project, type ProjectSummary, type RunEvent, type Version } from '@/lib/types';

type Panel = 'preview' | 'code' | 'versions';
type MobilePanel = 'chat' | 'preview' | 'projects';
const prompts = [
  { icon: '◈', name: '专注计时器', text: '创建一个精美的番茄钟应用，支持 25 分钟专注、5 分钟休息，能暂停、重置，并持久保存今日完成次数。使用温暖的奶油色和橙色，带清晰的大数字计时器。' },
  { icon: '▦', name: '任务看板', text: '创建一个任务看板，有待办、进行中、已完成三列。支持新增任务、编辑标题、删除、切换任务状态，刷新后保留任务数据。设计简洁现代，使用淡紫色点缀。' },
  { icon: '＋', name: '智能计算器', text: '创建一个实用的计算器，支持四则运算、清空、退格和键盘输入。正确处理除以零等非法运算并给出提示。保存最近 10 条有效计算历史，刷新后保留。使用深色主题和绿色强调色。' },
];
const statusLabels: Record<string, string> = { generating: '正在编写应用', validating: '正在检查代码', previewing: '正在运行验证', repairing: '正在自动修复', ready: '应用已就绪', failed: '生成未完成', cancelled: '已取消' };

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(typeof payload.error === 'string' ? payload.error : payload.error?.message || `请求失败（${response.status}）`, response.status, typeof payload.code === 'string' ? payload.code : undefined);
  return payload as T;
}
function formatDate(date: string) {
  return new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function errorText(error: unknown) { return error instanceof Error ? error.message : '发生了意外错误，请重试。'; }
function AtomMark({ small = false }: { small?: boolean }) {
  return <span className={`atom-mark${small ? ' atom-small' : ''}`} aria-hidden="true"><span /><span /><span /></span>;
}

export default function Workspace() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectLoading, setProjectLoading] = useState(false);
  const [operation, setOperation] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');
  const [pendingRun, setPendingRun] = useState<{ projectId: string; runId: string; status: string } | null>(null);
  const [panel, setPanel] = useState<Panel>('preview');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [storageConflict, setStorageConflict] = useState(false);
  const [previewReloadError, setPreviewReloadError] = useState<string | null>(null);
  const [reloadingPreview, setReloadingPreview] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const previewEpoch = useRef(0);
  const storageBlocked = useRef(false);
  const reloadInFlight = useRef(false);
  const projectRef = useRef<Project | null>(null);
  const bootRequest = useRef<Promise<[AppConfig, { projects: ProjectSummary[] }]> | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const streamProject = useRef<string | null>(null);
  const validations = useRef(new Set<string>());
  const stateQueue = useRef<Promise<void>>(Promise.resolve());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const chatBottom = useRef<HTMLDivElement>(null);

  const updateProject = useCallback((next: Project) => {
    setProjects(previous => [summary(next), ...previous.filter(p => p.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    if (selectedIdRef.current !== next.id) return;
    projectRef.current = next;
    setProject(next);
  }, []);

  const selectProject = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current;
    selectedIdRef.current = id;
    setRefreshKey(++previewEpoch.current);
    storageBlocked.current = true;
    reloadInFlight.current = false;
    setStorageConflict(false);
    setPreviewReloadError(null);
    setReloadingPreview(false);
    projectRef.current = null;
    setProject(null);
    setProjectLoading(true);
    setSelectedVersionId(null);
    setStatusText('');
    setPendingRun(null);
    setError(null);
    setSaveError(false);
    setSaving(false);
    setOperation(false);
    setPrompt('');
    setMobilePanel('chat');
    setPanel('preview');
    try {
      const data = await jsonRequest<{ project: Project }>(`/api/projects/${id}`);
      if (sequence !== loadSequence.current) return;
      updateProject(data.project);
      storageBlocked.current = false;
      localStorage.setItem('atoms:last-project', id);
    } catch (err) { if (sequence === loadSequence.current) setError(errorText(err)); }
    finally { if (sequence === loadSequence.current) setProjectLoading(false); }
  }, [updateProject]);

  useEffect(() => {
    let disposed = false;
    async function initialize() {
      try {
        // Reuse the in-flight bootstrap during React StrictMode's effect replay.
        // Only one anonymous session may be established before its cookie exists.
        bootRequest.current ??= Promise.all([
          jsonRequest<AppConfig>('/api/config'),
          navigator.locks?.request
            ? navigator.locks.request('atoms-session-bootstrap', () => jsonRequest<{ projects: ProjectSummary[] }>('/api/projects'))
            : jsonRequest<{ projects: ProjectSummary[] }>('/api/projects'),
        ]);
        const [configResult, projectsResult] = await bootRequest.current;
        if (disposed) return;
        setConfig(configResult);
        setProjects(projectsResult.projects);
        const remembered = localStorage.getItem('atoms:last-project');
        const next = projectsResult.projects.find(p => p.id === remembered) || projectsResult.projects[0];
        if (next) await selectProject(next.id);
      } catch (err) { if (!disposed) setError(errorText(err)); }
      finally { if (!disposed) setLoading(false); }
    }
    void initialize();
    return () => { disposed = true; };
  }, [selectProject]);

  const run = project ? activeRun(project) : undefined;
  const livePendingRun = pendingRun?.projectId === project?.id ? pendingRun : null;
  const busy = operation || !!run || !!livePendingRun || reloadingPreview;
  const candidate = run?.candidateVersionId ? project?.versions.find(v => v.id === run.candidateVersionId && v.status === 'candidate') : undefined;
  const shownVersion = candidate || project?.versions.find(v => v.id === (selectedVersionId || project.currentVersionId)) || null;
  const isHistorical = !!shownVersion && !candidate && shownVersion.id !== project?.currentVersionId;
  const readyVersions = project?.versions.filter(v => v.status === 'ready') || [];
  const visibleProjects = projects.filter(p => p.title.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => { chatBottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [project?.messages.length, busy, statusText]);
  useEffect(() => {
    if (!run || !project) return;
    const id = project.id;
    const timer = setInterval(() => {
      if (streamProject.current === id || selectedIdRef.current !== id) return;
      void jsonRequest<{ project: Project }>(`/api/projects/${id}`).then(data => {
        if (selectedIdRef.current === id && data.project.revision >= (projectRef.current?.revision || 0)) updateProject(data.project);
      }).catch(() => { /* The next scheduled poll can recover a transient read failure. */ });
    }, 2500);
    return () => clearInterval(timer);
  }, [project?.id, run?.id, updateProject]);

  async function createProject() {
    if (loading || projectLoading || operation) return null;
    setOperation(true);
    setError(null);
    try {
      const data = await jsonRequest<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ title: '未命名应用' }) });
      ++loadSequence.current;
      selectedIdRef.current = data.project.id;
      setRefreshKey(++previewEpoch.current);
      storageBlocked.current = false;
      reloadInFlight.current = false;
      setStorageConflict(false);
      setPreviewReloadError(null);
      setReloadingPreview(false);
      setSaveError(false);
      setSaving(false);
      updateProject(data.project);
      setSelectedVersionId(null);
      setPrompt('');
      setStatusText('');
      setPendingRun(null);
      setPanel('preview');
      setMobilePanel('chat');
      setProjectLoading(false);
      localStorage.setItem('atoms:last-project', data.project.id);
      textarea.current?.focus();
      return data.project;
    } catch (err) { setError(errorText(err)); return null; }
    finally { setOperation(false); }
  }

  async function consumeRun(url: string, body: Record<string, unknown>, projectId: string) {
    streamProject.current = projectId;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `请求失败（${response.status}）`);
      }
      if (!response.body) throw new Error('连接中断，未收到服务端结果。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      function handle(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as RunEvent;
        if (event.type === 'candidate' || event.type === 'complete') {
          updateProject(event.project);
          if (selectedIdRef.current === projectId) { setSelectedVersionId(null); setStatusText(''); setPendingRun(null); }
        } else if (event.type === 'status' && selectedIdRef.current === projectId) {
          setStatusText(event.message || statusLabels[event.status]);
          if (['generating', 'validating', 'previewing', 'repairing'].includes(event.status)) setPendingRun({ projectId, runId: event.runId, status: event.status });
          else setPendingRun(null);
        }
        else if (event.type === 'error') {
          if (event.project) updateProject(event.project);
          if (selectedIdRef.current === projectId) { setError(event.error); setPendingRun(null); }
        }
      }
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(handle);
        if (done) { if (buffer.trim()) handle(buffer); break; }
      }
    } finally { if (streamProject.current === projectId) streamProject.current = null; }
  }

  async function generate() {
    const text = prompt.trim();
    if (!text || busy || !config?.modelConfigured) return;
    let current = projectRef.current;
    if (!current) current = await createProject();
    if (!current) return;
    const id = current.id;
    setOperation(true);
    setError(null);
    setSaveError(false);
    setPrompt('');
    setSelectedVersionId(null);
    setPanel('preview');
    setStatusText('正在准备你的应用…');
    try {
      await consumeRun(`/api/projects/${id}/generate`, { prompt: text, baseVersionId: current.currentVersionId, requestId: crypto.randomUUID() }, id);
    } catch (err) {
      if (selectedIdRef.current === id) { setError(errorText(err)); setPrompt(text); setPendingRun(null); }
      await jsonRequest<{ project: Project }>(`/api/projects/${id}`).then(data => updateProject(data.project)).catch(() => {});
    } finally { if (selectedIdRef.current === id) setOperation(false); }
  }

  async function validateCandidate(result: { ok: boolean; error?: string; stagedState: AppState }) {
    if (!project || !candidate || !run) return;
    const id = project.id;
    const key = `${id}:${run.id}:${candidate.id}`;
    if (validations.current.has(key)) return;
    validations.current.add(key);
    setStatusText(result.ok ? '运行检查通过，正在保存版本…' : '检测到运行问题，正在尝试修复…');
    try {
      await consumeRun(`/api/projects/${id}/runs/${run.id}/validate`, {
        versionId: candidate.id, ok: result.ok, error: result.error,
        stagedState: result.stagedState, expectedDataRevision: run.baseDataRevision,
      }, id);
    } catch (err) {
      if (selectedIdRef.current === id) setError(`验证结果未保存：${errorText(err)}。可取消任务后重试。`);
      await jsonRequest<{ project: Project }>(`/api/projects/${id}`).then(data => updateProject(data.project)).catch(() => {});
    }
  }

  async function cancelRun() {
    const runId = run?.id || livePendingRun?.runId;
    if (!project || !runId) return;
    const id = project.id;
    setOperation(true);
    try {
      const data = await jsonRequest<{ project: Project }>(`/api/projects/${id}/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
      updateProject(data.project);
      setStatusText('');
      setPendingRun(null);
    } catch (err) { if (selectedIdRef.current === id) setError(errorText(err)); }
    finally { if (selectedIdRef.current === id) setOperation(false); }
  }

  function saveState(key: string, value: JsonValue): Promise<void> {
    const id = project?.id;
    const versionId = shownVersion?.id;
    // The callback belongs to this mounted preview. A refresh or conflict
    // invalidates it immediately, including writes already waiting in the queue.
    const epoch = refreshKey;
    const canSave = () => !storageBlocked.current && epoch === previewEpoch.current;
    if (!canSave()) return Promise.reject(new Error('预览数据已过期，请先载入最新数据，再重新操作。'));
    const save = stateQueue.current.catch(() => {}).then(async () => {
      const current = projectRef.current;
      if (!canSave()) throw new Error('预览数据已过期，请先载入最新数据，再重新操作。');
      if (!current || current.id !== id || current.currentVersionId !== versionId || activeRun(current)) throw new Error('应用版本已变更，请在当前版本中重试。');
      setSaving(true);
      try {
        const data = await jsonRequest<{ dataRevision: number }>(`/api/projects/${id}/state`, {
          method: 'POST', body: JSON.stringify({ versionId, expectedDataRevision: current.dataRevision, key, value }),
        });
        const latest = projectRef.current;
        if (latest?.id === id && epoch === previewEpoch.current) {
          const next = { ...latest, dataRevision: data.dataRevision, appState: { ...latest.appState, [key]: value } };
          projectRef.current = next;
          setProject(next);
          setSaveError(false);
        }
      } catch (err) {
        if (selectedIdRef.current === id && epoch === previewEpoch.current) {
          setSaveError(true);
          if (err instanceof RequestError && (err.status === 409 || ['STALE_DATA', 'REVISION_CONFLICT', 'PROJECT_BUSY'].includes(err.code || ''))) {
            storageBlocked.current = true;
            ++previewEpoch.current;
            setStorageConflict(true);
          } else setError(`应用数据未保存：${errorText(err)}`);
        }
        throw err;
      } finally { if (selectedIdRef.current === id) setSaving(false); }
    });
    stateQueue.current = save;
    return save;
  }

  async function reloadPreview() {
    const id = projectRef.current?.id;
    if (!id || busy || reloadInFlight.current) return;
    const sequence = ++loadSequence.current;
    const epoch = ++previewEpoch.current;
    storageBlocked.current = true;
    reloadInFlight.current = true;
    setReloadingPreview(true);
    setPreviewReloadError(null);
    try {
      // An in-flight save may still commit. Read only after it settles, while
      // rejecting queued writes from the obsolete iframe instead of replaying them.
      await stateQueue.current.catch(() => {});
      if (sequence !== loadSequence.current || selectedIdRef.current !== id) return;
      const data = await jsonRequest<{ project: Project }>(`/api/projects/${id}`);
      if (sequence !== loadSequence.current || selectedIdRef.current !== id) return;
      updateProject(data.project);
      setSelectedVersionId(null);
      setRefreshKey(epoch);
      setStorageConflict(false);
      setSaveError(false);
      setError(null);
      storageBlocked.current = false;
    } catch (err) {
      if (sequence === loadSequence.current && selectedIdRef.current === id) {
        setPreviewReloadError(`载入失败：${errorText(err)}。请再次尝试载入最新数据。`);
      }
    } finally {
      if (sequence === loadSequence.current && selectedIdRef.current === id) {
        reloadInFlight.current = false;
        setReloadingPreview(false);
      }
    }
  }

  async function restoreVersion(version: Version) {
    if (!project || busy || version.status !== 'ready') return;
    const id = project.id;
    setOperation(true);
    setError(null);
    try {
      const data = await jsonRequest<{ project: Project }>(`/api/projects/${id}/restore`, { method: 'POST', body: JSON.stringify({ versionId: version.id, requestId: crypto.randomUUID() }) });
      updateProject(data.project);
      setSelectedVersionId(null);
      setPanel('preview');
      setStatusText('正在验证恢复的版本…');
    } catch (err) { if (selectedIdRef.current === id) setError(errorText(err)); }
    finally { if (selectedIdRef.current === id) setOperation(false); }
  }

  async function loadFixture() {
    if (!config?.fixturesEnabled || busy) return;
    const current = projectRef.current || await createProject();
    if (!current) return;
    setOperation(true);
    setError(null);
    try {
      const data = await jsonRequest<{ project: Project }>(`/api/projects/${current.id}/fixture`, { method: 'POST', body: '{}' });
      updateProject(data.project);
      setSelectedVersionId(null);
      setPanel('preview');
      setMobilePanel('preview');
    } catch (err) { setError(errorText(err)); }
    finally { setOperation(false); }
  }

  function downloadSource() {
    if (!shownVersion) return;
    const url = URL.createObjectURL(new Blob([shownVersion.html], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `atoms-${project?.id.slice(0, 8)}-v${shownVersion.number}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function copySource() {
    if (!shownVersion) return;
    try { await navigator.clipboard.writeText(shownVersion.html); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { setError('无法访问剪贴板，请使用下载源码。'); }
  }
  function usePrompt(text: string) { setPrompt(text); textarea.current?.focus(); }

  return <main className={`workspace mobile-${mobilePanel}${fullscreen ? ' preview-fullscreen' : ''}`}>
    <aside className="sidebar" aria-label="项目导航">
      <div className="brand"><AtomMark /><span>atoms<span className="brand-period">.</span></span><span className="demo-tag">DEMO</span></div>
      <button className="new-project" onClick={() => void createProject()} disabled={operation || loading || projectLoading}><Plus size={17} /> 新建应用 <span>＋</span></button>
      <label className="project-search"><Search size={14} /><input aria-label="搜索应用" placeholder="搜索应用…" value={query} onChange={e => setQuery(e.target.value)} /><span>⌕</span></label>
      <div className="nav-section-label">我的工作空间 <span>{projects.length}</span></div>
      <nav className="project-list">
        {loading ? <div className="sidebar-loading"><LoaderCircle size={16} className="spin" /> 正在载入</div> : visibleProjects.map(item => <button key={item.id} className={`project-item${project?.id === item.id ? ' active' : ''}`} onClick={() => void selectProject(item.id)} title={item.title}>
          <span className="project-icon"><Layers3 size={15} /></span><span className="project-item-text"><strong>{item.title}</strong><small>{item.versionCount ? `${item.versionCount} 个版本` : '新的想法'} · {formatDate(item.updatedAt).slice(0, 5)}</small></span>{project?.id === item.id && <span className="project-active-dot" />}
        </button>)}
        {!loading && !visibleProjects.length && <div className="no-projects"><FolderOpen size={25} /><span>{query ? '没有找到应用' : '你的下一个想法\n从这里开始'}</span></div>}
      </nav>
      <div className="sidebar-bottom"><div className="workspace-note"><span className="note-icon"><Sparkles size={16} /></span><strong>小想法，也值得被实现</strong><p>描述、生成、迭代。<br />把创造交给你的想象力。</p><span className="note-lines" /></div>
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /><span>工作空间设置</span><ChevronRight size={14} /></button>
        <div className="profile"><span className="avatar">A</span><div><strong>我的工作空间</strong><small>个人开发空间</small></div><span className="profile-dot" /></div>
      </div>
    </aside>

    <section className="main-area">
      <header className="workspace-header"><div className="breadcrumb"><span className="breadcrumb-icon"><Layers3 size={16} /></span><span className="breadcrumb-root">工作空间</span><ChevronRight size={14} /><strong>{project?.title || '新建应用'}</strong><span className="project-private"><ShieldCheck size={11} /> 私有</span></div>
        <div className="header-actions"><button className={`connection-status ${config?.modelConfigured ? 'connected' : ''}`} onClick={() => setSettingsOpen(true)}><span />{config?.modelConfigured ? 'AI 已配置' : '配置 AI 模型'}<ChevronDown size={12} /></button><span className="header-divider" /><a href="https://deepwisdom.feishu.cn/wiki/BKmew0HXTiWYyLkpf04cP0LXnjc" target="_blank" rel="noreferrer" className="help-link" aria-label="打开实施方案"><CircleHelp size={18} /></a></div>
      </header>
      <div className="mobile-nav"><button className={mobilePanel === 'projects' ? 'active' : ''} onClick={() => setMobilePanel('projects')}><Layers3 size={15} /> 应用</button><button className={mobilePanel === 'chat' ? 'active' : ''} onClick={() => setMobilePanel('chat')}><MessageSquare size={15} /> 构建</button><button className={mobilePanel === 'preview' ? 'active' : ''} onClick={() => setMobilePanel('preview')}><Monitor size={15} /> 预览</button></div>
      <div className="work-panels">
        <section className="conversation" aria-label="AI 构建对话">
          <div className="section-toolbar"><div><Sparkles size={15} /><strong>构建助手</strong><span className="beta-label">AI</span></div><span className="context-label">{project?.currentVersionId ? `已有 ${readyVersions.length} 个版本` : '从想法开始'}</span></div>
          <div className="chat-scroll">
            {(loading || projectLoading) ? <div className="center-loading"><LoaderCircle className="spin" size={24} /><span>正在打开工作空间…</span></div> : !project?.messages.length ? <div className="welcome">
              <div className="welcome-icon"><AtomMark /></div><span className="eyebrow">LET’S BUILD SOMETHING</span><h1>你想创造什么？</h1><p className="welcome-description">把脑海里的想法告诉我，<br />我们一起让它成为真正可用的应用。</p>
              <div className="starter-label">从一个灵感开始 <span /></div><div className="starter-list">{prompts.map(item => <button key={item.name} onClick={() => usePrompt(item.text)}><span className="starter-icon">{item.icon}</span><span>{item.name}</span><ArrowUp size={14} /></button>)}</div>
              <div className="welcome-footnote"><WandSparkles size={13} /> 自然语言构建 · 实时预览 · 持续迭代</div>
            </div> : <div className="messages">{project.messages.map(message => <article key={message.id} className={`message ${message.role}`}>
              <div className="message-label">{message.role === 'assistant' ? <><span className="assistant-avatar"><AtomMark small /></span><strong>Atoms</strong><span>构建助手</span></> : <><span className="user-avatar">你</span><strong>你</strong></>}<time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="message-content">{message.content}</div>
            </article>)}</div>}
            {busy && !reloadingPreview && <div className="run-progress"><span className="progress-orb"><LoaderCircle size={16} className="spin" /></span><div><strong>{statusText || statusLabels[run?.status || livePendingRun?.status || 'generating']}</strong><p>{run?.attempt && run.attempt > 1 ? `第 ${run.attempt} 次构建 · 自动检查并修复` : '编写代码，检查运行结果，保存可用版本'}</p></div>{(run || livePendingRun) && <button onClick={() => void cancelRun()} title="取消生成" aria-label="取消生成"><Square size={12} /></button>}</div>}
            {error && <div className="error-notice" role="alert"><TriangleAlert size={16} /><div><strong>需要留意一下</strong><p>{error}</p></div><button onClick={() => setError(null)} aria-label="关闭错误提示"><X size={14} /></button></div>}
            {!config?.modelConfigured && config && <div className="config-notice"><span><Terminal size={15} /></span><div><strong>连接 AI，开启你的第一次构建</strong><p>模型尚未配置。连接后，即可生成和修改应用。</p><button onClick={() => setSettingsOpen(true)}>查看配置方式 <ArrowRight size={12} /></button></div></div>}
            <div ref={chatBottom} />
          </div>
          <div className="composer-area"><form className={`composer${busy ? ' composer-busy' : ''}`} onSubmit={event => { event.preventDefault(); void generate(); }}>
            <textarea ref={textarea} aria-label="描述你的应用" placeholder={project?.currentVersionId ? '想改些什么？继续描述你的想法…' : '描述你的应用，越具体越好…'} value={prompt} maxLength={config?.limits.maxPromptLength || 6000} onChange={event => setPrompt(event.target.value)} disabled={busy || loading || projectLoading} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void generate(); } }} />
            <div className="composer-actions"><span className="model-label"><span className="model-dot" />{config?.modelConfigured ? config.model || 'AI 模型' : '等待模型连接'}</span><button className="submit-prompt" type="submit" disabled={!prompt.trim() || busy || !config?.modelConfigured || loading || projectLoading} aria-label="生成应用">{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button></div>
          </form><div className="composer-caption"><span>Enter 发送<span className="caption-separator">·</span>Shift + Enter 换行</span><span><ShieldCheck size={11} /> 隔离运行</span></div>
          {config?.fixturesEnabled && <button className="fixture-button" onClick={() => void loadFixture()} disabled={busy}>载入开发样例 <span>非 AI 生成，仅用于功能验证</span></button>}</div>
        </section>

        <section className="output-panel" aria-label="应用工作区"><div className="output-toolbar"><div className="output-tabs" role="tablist" aria-label="应用视图"><button role="tab" aria-selected={panel === 'preview'} className={panel === 'preview' ? 'active' : ''} onClick={() => setPanel('preview')}><Monitor size={15} /><span>预览</span></button><button role="tab" aria-selected={panel === 'code'} className={panel === 'code' ? 'active' : ''} onClick={() => setPanel('code')}><Code2 size={15} /><span>源码</span></button><button role="tab" aria-selected={panel === 'versions'} className={panel === 'versions' ? 'active' : ''} onClick={() => setPanel('versions')}><History size={15} /><span>版本</span>{readyVersions.length > 0 && <span className="tab-count">{readyVersions.length}</span>}</button></div><div className="output-actions">{shownVersion && <button onClick={downloadSource} title="下载当前版本源码" aria-label="下载当前版本源码"><ArrowDownToLine size={16} /></button>}<button onClick={() => setFullscreen(!fullscreen)} title={fullscreen ? '退出全屏' : '展开预览'} aria-label={fullscreen ? '退出全屏' : '展开预览'}>{fullscreen ? <X size={16} /> : <Maximize2 size={15} />}</button></div></div>
          {(storageConflict || previewReloadError) && <div className="storage-conflict-banner" role="alert"><TriangleAlert size={18} /><div><strong>{storageConflict ? '数据已在其他页面更新' : '暂时无法载入最新数据'}</strong><p>{storageConflict ? '本次操作未保存。载入最新数据后，请重新操作。' : '当前预览已暂停保存，云端已保存的数据不受影响。'}</p>{previewReloadError && <p>{previewReloadError}</p>}</div><button onClick={() => void reloadPreview()} disabled={busy}>{reloadingPreview ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}载入最新数据</button></div>}
          <div className="preview-area" style={panel === 'preview' ? undefined : { display: 'none' }}><div className="preview-browserbar"><div className="browser-dots"><i /><i /><i /></div><span className="preview-address"><ShieldCheck size={12} />{shownVersion ? `${project?.title} / v${shownVersion.number}` : '你的应用将在这里诞生'}</span><div className="device-switch"><button className={device === 'desktop' ? 'active' : ''} onClick={() => setDevice('desktop')} aria-label="桌面预览"><Monitor size={13} /></button><button className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')} aria-label="手机预览"><Smartphone size={13} /></button><span /><button onClick={() => void reloadPreview()} disabled={!shownVersion || busy} aria-label="重新加载预览"><RefreshCw size={13} /></button></div></div>
            {isHistorical && <div className="historical-banner"><History size={14} /><span>正在查看 v{shownVersion?.number} · 历史版本只读</span><button disabled={busy} onClick={() => shownVersion && void restoreVersion(shownVersion)}>恢复此版本 <ArrowRight size={12} /></button></div>}
            <div className={`preview-stage${shownVersion ? ' has-app' : ''}${device === 'mobile' ? ' device-mobile' : ''}`}>
              {shownVersion && project ? <div className="preview-frame-shell"><PreviewFrame key={`${project.id}:${shownVersion.id}:${candidate ? 'candidate' : 'published'}:${refreshKey}`} html={shownVersion.html} projectId={project.id} versionId={shownVersion.id} initialState={candidate && run ? run.stagedState : project.appState} mode={candidate ? 'candidate' : 'published'} readOnly={candidate ? false : isHistorical || busy || storageConflict || !!previewReloadError} onValidated={validateCandidate} onStore={saveState} onRuntimeError={message => { if (!storageBlocked.current) setError(`应用运行异常：${message}`); }} />{(busy || storageConflict || previewReloadError) && <div className="preview-blocker"><div>{busy ? <LoaderCircle size={15} className="spin" /> : <TriangleAlert size={15} />}<span>{reloadingPreview ? '正在载入最新数据…' : storageConflict || previewReloadError ? '请先载入最新数据，再继续操作' : candidate ? '正在检查应用是否正常运行' : '正在构建新版本，当前预览暂时只读'}</span></div></div>}{isHistorical && <div className="history-readonly-overlay" aria-label="历史版本只读" />}</div> : <div className="empty-preview"><div className="canvas-decoration"><span className="floating-tile tile-top"><Code2 size={18} /></span><span className="floating-tile tile-bottom"><Sparkles size={17} /></span><div className="canvas-window"><div><i /><i /><i /></div><span className="canvas-line long" /><span className="canvas-line short" /><section><b /><b /><b /></section><span className="canvas-line medium" /></div></div><h2>让想法，在这里成形</h2><p>在左侧描述你想做的应用<br />预览会随着你的想法一起更新</p><span className="empty-preview-tag"><span /> READY WHEN YOU ARE</span></div>}
            </div></div>
          {panel === 'code' && <div className="source-panel">{shownVersion ? <><div className="source-toolbar"><span><FileCode2 size={14} /> index.html <small>v{shownVersion.number}</small></span><button onClick={() => void copySource()}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制代码'}</button></div><pre className="source-code"><code>{shownVersion.html.split('\n').map((line, index) => <span key={index} className="code-line"><span className="line-number">{index + 1}</span><span>{line || ' '}</span></span>)}</code></pre></> : <div className="tab-empty"><Code2 size={29} /><h3>每一行代码，都属于你</h3><p>生成应用后，可在这里查看、复制和下载完整源码。</p></div>}</div>}
          {panel === 'versions' && <div className="versions-panel"><div className="versions-intro"><span className="version-header-icon"><History size={20} /></span><div><h2>每一步，都有迹可循</h2><p>查看历史构建，随时恢复一个可用版本。</p></div></div>{project?.versions.length ? <div className="version-list">{[...project.versions].reverse().map(version => <article className={`version-card${version.id === project.currentVersionId ? ' current' : ''}`} key={version.id}><div className="version-timeline-dot" /><div className="version-card-header"><strong>版本 {version.number}</strong>{version.id === project.currentVersionId ? <span className="version-badge current-badge">当前版本</span> : version.status === 'failed' ? <span className="version-badge failed-badge">检查未通过</span> : version.status === 'candidate' ? <span className="version-badge">验证中</span> : <span className="version-badge">可恢复</span>}<time>{formatDate(version.createdAt)}</time></div><h3>{version.title}</h3><p>{version.summary}</p><div className="version-card-footer"><span>{version.source === 'restore' ? <><History size={12} /> 版本恢复</> : version.source === 'fixture' ? <><Code2 size={12} /> 开发样例 · 非 AI</> : <><Sparkles size={12} /> AI 构建</>}</span><div><button disabled={version.status === 'candidate' || busy} onClick={() => { setSelectedVersionId(version.id); setPanel('preview'); }}>查看</button>{version.status === 'ready' && version.id !== project.currentVersionId && <button className="restore-button" disabled={busy} onClick={() => void restoreVersion(version)}><History size={12} /> 恢复</button>}</div></div>{version.validationErrors.length > 0 && <details className="validation-errors"><summary>查看检查详情</summary><p>{version.validationErrors.join('\n')}</p></details>}</article>)}</div> : <div className="tab-empty"><Layers3 size={29} /><h3>好作品来自不断迭代</h3><p>每次构建成功后，会在这里留下一个新版本。</p></div>}</div>}
          <footer className="preview-statusbar"><span><span className={`status-dot${saveError ? ' status-error' : busy ? ' status-working' : ''}`} />{reloadingPreview ? '正在载入最新数据…' : storageConflict || previewReloadError ? '等待载入最新数据' : saveError ? '数据保存失败' : saving ? '正在保存应用数据…' : candidate ? '验证候选版本中' : shownVersion ? isHistorical ? '历史版本 · 只读' : '应用已就绪' : '等待你的第一个想法'}</span><span className="storage-status"><Database size={11} />{config?.storageMode === 'supabase' ? '云端存储' : '本地持久存储'}{shownVersion && <><span className="statusbar-divider" />v{shownVersion.number}</>}</span></footer>
        </section>
      </div>
    </section>
    {settingsOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><span className="eyebrow">WORKSPACE SETTINGS</span><h2 id="settings-title">连接你的创造力</h2></div><button onClick={() => setSettingsOpen(false)} aria-label="关闭设置"><X size={19} /></button></div><div className="setting-row"><span className="setting-icon"><Sparkles size={19} /></span><div><strong>AI 模型</strong><p>{config?.modelConfigured ? config.model : '尚未连接模型服务'}</p></div><span className={`setting-badge${config?.modelConfigured ? ' configured' : ''}`}>{config?.modelConfigured ? '已配置' : '待配置'}</span></div>{!config?.modelConfigured && <div className="setup-guide"><p>在项目的 <code>.env.local</code> 配置模型凭据，然后重启服务。</p><pre>MODEL_API_KEY=你的模型密钥{'\n'}MODEL_NAME=你的模型名称</pre><p>使用兼容服务时，可同时设置 <code>MODEL_BASE_URL</code>。请勿在聊天框输入密钥。</p></div>}<div className="setting-row"><span className="setting-icon"><Database size={19} /></span><div><strong>应用存储</strong><p>{config?.storageMode === 'supabase' ? 'Supabase 云端存储已连接' : '应用与数据保存在当前服务器'}</p></div><span className="setting-badge configured">{config?.storageMode === 'supabase' ? '云端' : '本地'}</span></div><div className="settings-footer"><ShieldCheck size={15} /><p>生成的应用在隔离预览中运行。每次修改都会经过代码与运行检查，通过后保存为新版本。</p></div><button className="modal-done" onClick={() => setSettingsOpen(false)}>开始创造 <ArrowRight size={15} /></button></section></div>}
  </main>;
}
