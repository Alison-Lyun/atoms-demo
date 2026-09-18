import type { AppState,JsonValue,Project,RunEvent } from '@/lib/types';
import { activeRun,activeStatuses } from '@/lib/types';
import { validateArtifact } from '@/lib/validation';
import type { Repository } from './repository';
import { AppError,publicError } from './errors';
import { LIMITS,appConfig } from './config';
import { generateArtifact } from './model';
import { assertState,expireRuns,failActiveRun,makeVersion,newRun,promoteCandidate,requireActive,validKey } from './lifecycle';
import { TODO_FIXTURE } from './fixture';
type Emit=(event:RunEvent)=>void;
const globals=globalThis as typeof globalThis & {__atomsAborts?:Map<string,AbortController>};
const aborts=globals.__atomsAborts??=new Map<string,AbortController>();
const MAX_REVISION_RETRIES=3;
function isRevisionConflict(error:unknown){return !!error&&typeof error==='object'&&'code'in error&&error.code==='REVISION_CONFLICT';}
// A callback may discover that another request already did its work. Throwing
// this internal signal aborts the repository write, so revision stays intact.
class ReadOnlyProject extends Error {constructor(readonly project:Project){super('Project already reflects this operation');}}
async function retryRevisionConflicts<T>(operation:()=>Promise<T>):Promise<T>{
  for(let retries=0;;retries++){
    try{return await operation();}
    catch(error){if(!isRevisionConflict(error)||retries>=MAX_REVISION_RETRIES)throw error;}
  }
}
async function readProject(repo:Repository,id:string){
  const project=await repo.getProject(id);
  if(!project)throw new AppError('项目不存在或当前会话无权访问。',404,'PROJECT_NOT_FOUND');
  return project;
}
async function mutateWithRetry(repo:Repository,id:string,mutation:(project:Project)=>void){
  return retryRevisionConflicts(async()=>{
    // Repository.mutateProject reads a fresh snapshot on every invocation.
    // Keep callback effects inside that draft; discarded CAS attempts must not
    // increment counters or dispatch work outside the transaction.
    try{return await repo.mutateProject(id,mutation);}
    catch(error){if(error instanceof ReadOnlyProject)return structuredClone(error.project);throw error;}
  });
}

export async function loadProject(repo:Repository,id:string){
  let p=await readProject(repo,id);
  if(p.runs.some(r=>activeStatuses.includes(r.status)&&Date.parse(r.deadlineAt)<=Date.now()))p=await mutateWithRetry(repo,id,expireRuns);
  return p;
}
export async function beginGeneration(repo:Repository,id:string,input:{prompt:string;requestId:string;baseVersionId:string|null}){
  return retryRevisionConflicts(async()=>{
    const snapshot=await readProject(repo,id);
    const previous=snapshot.runs.find(r=>r.requestId===input.requestId);
    if(previous)return {project:snapshot,runId:previous.id,started:false};
    if(!appConfig().modelConfigured)throw new AppError('尚未配置模型 API 和模型名称。',503,'MODEL_NOT_CONFIGURED');
    try{
      const project=await repo.mutateProject(id,p=>{
        if(p.runs.some(r=>r.requestId===input.requestId))throw new ReadOnlyProject(p);
        newRun(p,input.prompt,input.requestId,'generate',input.baseVersionId);
      });
      return {project,runId:project.runs.find(r=>r.requestId===input.requestId)!.id,started:true};
    }catch(error){
      if(error instanceof ReadOnlyProject)return {project:error.project,runId:error.project.runs.find(r=>r.requestId===input.requestId)!.id,started:false};
      throw error;
    }
  });
}
export function emitSnapshot(project:Project,runId:string,emit:Emit){
  const run=project.runs.find(r=>r.id===runId);
  if(run?.status==='previewing'&&run.candidateVersionId)emit({type:'candidate',project});
  else if(run?.status==='failed'||run?.status==='cancelled')emit({type:'error',error:run.error||'任务已取消。',code:run.status==='cancelled'?'CANCELLED':'RUN_FAILED',project});
  else emit({type:'complete',project});
}
export async function runGeneration(repo:Repository,id:string,runId:string,emit:Emit,repair?:{html:string;errors:string[]}){
  const controller=new AbortController();aborts.set(runId,controller);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    let project=await loadProject(repo,id);let run=requireActive(project,runId);
    timer=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(run.deadlineAt)-Date.now()));
    let repairHtml=repair?.html,errors=repair?.errors;
    while(true){
      project=await mutateWithRetry(repo,id,p=>{const r=requireActive(p,runId);r.status=r.attempt>0?'repairing':'generating';});
      run=requireActive(project,runId);
      emit({type:'status',runId,status:run.status,message:run.attempt?`正在修复代码（${run.attempt}/${LIMITS.maxRepairAttempts}）`:'模型正在编写应用代码'});
      const current=project.versions.find(v=>v.id===run.baseVersionId);
      const result=await generateArtifact({prompt:run.prompt,currentHtml:current?.html??null,repairHtml,errors,signal:controller.signal});
      project=await mutateWithRetry(repo,id,p=>{const r=requireActive(p,runId);r.status='validating';r.model=result.model;r.inputTokens=(r.inputTokens??0)+result.usage.inputTokens;r.outputTokens=(r.outputTokens??0)+result.usage.outputTokens;});
      emit({type:'status',runId,status:'validating',message:'正在检查 HTML、脚本语法与运行约束'});
      const validation=validateArtifact(result.artifact.html);
      project=await mutateWithRetry(repo,id,p=>{
        const r=requireActive(p,runId),version=makeVersion(p,r,result.artifact);
        version.validationErrors=validation.errors;version.status=validation.valid?'candidate':'failed';p.versions.push(version);r.candidateVersionId=version.id;
        if(validation.valid)r.status='previewing';
        else if(r.attempt<LIMITS.maxRepairAttempts){r.attempt++;r.status='repairing';}
        else failActiveRun(p,runId,'代码检查未通过，已达到两次自动修复上限。原有版本已保留。');
      });
      run=project.runs.find(r=>r.id===runId)!;
      if(validation.valid){emit({type:'candidate',project});return;}
      if(run.status==='failed'){emitSnapshot(project,runId,emit);return;}
      repairHtml=result.artifact.html;errors=validation.errors.slice(0,15).map(e=>e.slice(0,500));
    }
  }catch(error){
    const safe=publicError(error);
    let project:Project|undefined;
    try{
      const latest=await readProject(repo,id),run=latest.runs.find(r=>r.id===runId);
      // Persistent contention is a storage conflict, not a model failure. Do
      // not kill another worker or overwrite a cancellation after retries end.
      if(isRevisionConflict(error)||!run||!activeStatuses.includes(run.status))project=latest;
      else project=await mutateWithRetry(repo,id,p=>{
        const current=p.runs.find(r=>r.id===runId);
        if(!current||!activeStatuses.includes(current.status))throw new ReadOnlyProject(p);
        failActiveRun(p,runId,safe.error);
      });
    }catch{}
    const finalRun=project?.runs.find(r=>r.id===runId);
    if(project&&(finalRun?.status==='cancelled'||finalRun?.status==='ready')){emitSnapshot(project,runId,emit);return;}
    emit({type:'error',error:safe.error,code:safe.code,project});
  }finally{if(timer)clearTimeout(timer);if(aborts.get(runId)===controller)aborts.delete(runId);}
}
export async function reportPreview(repo:Repository,id:string,runId:string,input:{versionId:string;ok:boolean;error?:string;stagedState:AppState;expectedDataRevision:number}){
  return retryRevisionConflicts(async()=>{
    const snapshot=await readProject(repo,id),existing=snapshot.runs.find(r=>r.id===runId);
    if(existing?.status==='ready'&&existing.candidateVersionId===input.versionId)return {project:snapshot,repair:undefined};
    try{
      const project=await repo.mutateProject(id,p=>{
        const previous=p.runs.find(r=>r.id===runId);
        if(previous?.status==='ready'&&previous.candidateVersionId===input.versionId)throw new ReadOnlyProject(p);
        const run=requireActive(p,runId);
        if(run.status!=='previewing'||run.candidateVersionId!==input.versionId)throw new AppError('候选预览已变化，旧回报没有生效。',409,'STALE_CANDIDATE');
        if(input.ok){promoteCandidate(p,{runId,versionId:input.versionId,state:input.stagedState,expectedDataRevision:input.expectedDataRevision});return;}
        const version=p.versions.find(v=>v.id===input.versionId)!;
        const error=(input.error||'应用初始化失败。').slice(0,2000);version.status='failed';version.validationErrors=[error];
        if(run.source==='generate'&&run.attempt<LIMITS.maxRepairAttempts){run.attempt++;run.status='repairing';}
        else failActiveRun(p,runId,'应用预览启动失败，原有版本与数据已保留。'+error);
      });
      const run=project.runs.find(r=>r.id===runId),version=project.versions.find(v=>v.id===input.versionId);
      // Dispatch repair only from the committed snapshot, never from a
      // callback whose CAS failed and may be reapplied.
      const repair=run?.status==='repairing'&&version?{html:version.html,errors:version.validationErrors}:undefined;
      return {project,repair};
    }catch(error){if(error instanceof ReadOnlyProject)return {project:error.project,repair:undefined};throw error;}
  });
}
export async function cancelRun(repo:Repository,id:string,runId:string){
  const snapshot=await readProject(repo,id),existing=snapshot.runs.find(r=>r.id===runId);
  if(!existing)throw new AppError('任务不存在。',404);
  if(!activeStatuses.includes(existing.status)){aborts.get(runId)?.abort();return snapshot;}
  const project=await mutateWithRetry(repo,id,p=>{
    const run=p.runs.find(r=>r.id===runId);if(!run)throw new AppError('任务不存在。',404);
    if(!activeStatuses.includes(run.status))throw new ReadOnlyProject(p);
    run.status='cancelled';run.error='任务已取消，原有版本与数据已保留。';run.finishedAt=new Date().toISOString();run.stagedState={};
    const version=p.versions.find(v=>v.id===run.candidateVersionId);if(version?.status==='candidate')version.status='failed';
  });
  aborts.get(runId)?.abort();return project;
}
export async function restoreVersion(repo:Repository,id:string,input:{versionId:string;requestId:string}){
  const snapshot=await readProject(repo,id);
  if(snapshot.runs.some(r=>r.requestId===input.requestId))return snapshot;
  return mutateWithRetry(repo,id,p=>{
    if(p.runs.some(r=>r.requestId===input.requestId))throw new ReadOnlyProject(p);
    const target=p.versions.find(v=>v.id===input.versionId&&v.status==='ready');if(!target)throw new AppError('只能恢复已成功运行的版本。',400);
    const run=newRun(p,`恢复到版本 ${target.number}，保留现有应用数据。`,input.requestId,'restore',p.currentVersionId);
    const version=makeVersion(p,run,{html:target.html,title:target.title,summary:`已恢复版本 ${target.number} 的代码，并保留当前数据。`});
    p.versions.push(version);run.candidateVersionId=version.id;
  });
}
export async function saveState(repo:Repository,id:string,input:{versionId:string;expectedDataRevision:number;key:string;value:JsonValue}){
  if(!validKey(input.key))throw new AppError('应用存储键名无效。');
  const project=await repo.mutateProject(id,p=>{
    expireRuns(p);if(activeRun(p))throw new AppError('生成期间应用数据暂时锁定，请在生成结束后重试。',409,'PROJECT_BUSY');
    if(p.currentVersionId!==input.versionId||p.dataRevision!==input.expectedDataRevision)throw new AppError('应用版本或数据已变化，请刷新预览。',409,'STALE_DATA');
    const state={...p.appState,[input.key]:input.value};assertState(state);p.appState=state;p.dataRevision++;
  });return {dataRevision:project.dataRevision};
}
export async function createFixture(repo:Repository,id:string){
  if(!appConfig().fixturesEnabled)throw new AppError('此功能只在显式开启的本地开发环境可用。',404);
  return repo.mutateProject(id,p=>{const run=newRun(p,'载入开发示例（非模型生成）',crypto.randomUUID(),'fixture',p.currentVersionId);const version=makeVersion(p,run,{html:TODO_FIXTURE,title:'开发示例 · 待办清单',summary:'已载入开发示例，用于验证预览和持久化；此示例不是模型生成结果。'});p.versions.push(version);run.candidateVersionId=version.id;});
}
