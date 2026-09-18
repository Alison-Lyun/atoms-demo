import type { AppState,Project,Run,Version } from '@/lib/types';
import { activeRun,activeStatuses } from '@/lib/types';
import { AppError } from './errors';
import { LIMITS } from './config';
export function expireRuns(project:Project,now=Date.now()){
  for(const run of project.runs){if(activeStatuses.includes(run.status)&&Date.parse(run.deadlineAt)<=now){run.status='failed';run.error='任务已超时或预览回报中断，请重试。';run.finishedAt=new Date(now).toISOString();const v=project.versions.find(v=>v.id===run.candidateVersionId);if(v&&v.status==='candidate')v.status='failed';}}
}
export function requireActive(project:Project,runId:string):Run{
  const run=project.runs.find(r=>r.id===runId);if(!run)throw new AppError('任务不存在。',404,'RUN_NOT_FOUND');
  if(!activeStatuses.includes(run.status)||Date.parse(run.deadlineAt)<=Date.now())throw new AppError('任务已结束或过期，未覆盖当前版本。',409,'RUN_INACTIVE');
  if(run.baseVersionId!==project.currentVersionId)throw new AppError('项目版本已变化，请基于最新版本重试。',409,'STALE_VERSION');
  return run;
}
export function assertState(state:unknown):asserts state is AppState {
  if(!state||typeof state!=='object'||Array.isArray(state))throw new AppError('应用数据格式无效。');
  const keys=Object.keys(state);if(keys.length>LIMITS.maxStateKeys||keys.some(k=>!validKey(k)))throw new AppError('应用数据键名或数量超出限制。');
  let text:string;try{text=JSON.stringify(state);}catch{throw new AppError('应用数据无法序列化。');}
  if(Buffer.byteLength(text)>LIMITS.maxStateBytes)throw new AppError('应用数据超过 64 KiB 限制。',413,'STATE_TOO_LARGE');
  const visit=(v:unknown,depth:number):boolean=>depth<=20&&(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(Array.isArray(v)?v.every(x=>visit(x,depth+1)):typeof v==='object'&&v!==null&&Object.entries(v).every(([k,x])=>!['__proto__','constructor','prototype'].includes(k)&&visit(x,depth+1))));
  if(!visit(state,0))throw new AppError('应用数据必须是有限、有效的 JSON。');
}
export function validKey(key:string){return /^[a-zA-Z0-9_-]{1,64}$/.test(key)&&!['__proto__','constructor','prototype'].includes(key);}
export function promoteCandidate(project:Project,input:{runId:string;versionId:string;state:AppState;expectedDataRevision:number}){
  const run=requireActive(project,input.runId);
  if(run.status!=='previewing'||run.candidateVersionId!==input.versionId)throw new AppError('候选版本已变化，请刷新预览。',409,'STALE_CANDIDATE');
  if(project.dataRevision!==run.baseDataRevision||input.expectedDataRevision!==run.baseDataRevision)throw new AppError('应用数据已变化，此候选没有覆盖原数据。',409,'STALE_DATA');
  assertState(input.state);
  const version=project.versions.find(v=>v.id===input.versionId);
  if(!version||version.status!=='candidate')throw new AppError('候选版本不存在。',409);
  version.status='ready';project.currentVersionId=version.id;project.title=version.title;project.appState=structuredClone(input.state);project.dataRevision++;
  run.stagedState={};run.status='ready';run.finishedAt=new Date().toISOString();
  project.messages.push({id:crypto.randomUUID(),role:'assistant',content:version.summary,createdAt:new Date().toISOString(),runId:run.id});
}
export function failActiveRun(project:Project,runId:string,error:string){
  const run=project.runs.find(r=>r.id===runId);if(!run||!activeStatuses.includes(run.status))return;
  run.status='failed';run.error=error;run.finishedAt=new Date().toISOString();run.stagedState={};
  const version=project.versions.find(v=>v.id===run.candidateVersionId);if(version&&version.status==='candidate'){version.status='failed';version.validationErrors=[error];}
}
export function makeVersion(project:Project,run:Run,input:{html:string;title:string;summary:string}):Version{
  return {id:crypto.randomUUID(),number:project.versions.length+1,parentVersionId:run.baseVersionId,html:input.html,title:input.title,summary:input.summary,createdAt:new Date().toISOString(),status:'candidate',source:run.source,validationErrors:[]};
}
export function newRun(project:Project,prompt:string,requestId:string,source:Run['source'],baseVersionId:string|null):Run{
  expireRuns(project);
  if(activeRun(project))throw new AppError('该项目已有任务在运行，请等待或取消。',409,'PROJECT_BUSY');
  if(baseVersionId!==project.currentVersionId)throw new AppError('版本已变化，请刷新后重新提交。',409,'STALE_VERSION');
  const limit=Math.max(1,Math.min(100,Number(process.env.MAX_GENERATIONS_PER_HOUR)||20));
  if(source==='generate'&&project.runs.filter(r=>r.source==='generate'&&Date.parse(r.createdAt)>Date.now()-3600000).length>=limit)throw new AppError('该项目本小时生成次数已达上限，请稍后再试。',429,'PROJECT_RATE_LIMIT');
  const run:Run={id:crypto.randomUUID(),requestId,baseVersionId,baseDataRevision:project.dataRevision,status:source==='generate'?'generating':'previewing',prompt,attempt:0,candidateVersionId:null,createdAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+LIMITS.runTimeoutSeconds*1000).toISOString(),finishedAt:null,error:null,source,stagedState:structuredClone(project.appState)};
  project.runs.push(run);project.messages.push({id:crypto.randomUUID(),role:'user',content:prompt,createdAt:run.createdAt,runId:run.id});return run;
}
