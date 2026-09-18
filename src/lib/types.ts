export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AppState = Record<string, JsonValue>;
export type RunStatus = 'generating'|'validating'|'previewing'|'repairing'|'ready'|'failed'|'cancelled';
export interface Message { id:string; role:'user'|'assistant'; content:string; createdAt:string; runId?:string; }
export interface Version { id:string; number:number; parentVersionId:string|null; html:string; title:string; summary:string; createdAt:string; status:'candidate'|'ready'|'failed'; source:'generate'|'restore'|'fixture'; validationErrors:string[]; }
export interface Run { id:string; requestId:string; baseVersionId:string|null; baseDataRevision:number; status:RunStatus; prompt:string; attempt:number; candidateVersionId:string|null; createdAt:string; deadlineAt:string; finishedAt:string|null; error:string|null; source:'generate'|'restore'|'fixture'; stagedState:AppState; model?:string; inputTokens?:number; outputTokens?:number; }
export interface Project { id:string; title:string; createdAt:string; updatedAt:string; revision:number; dataRevision:number; currentVersionId:string|null; messages:Message[]; versions:Version[]; runs:Run[]; appState:AppState; }
export interface ProjectSummary { id:string; title:string; createdAt:string; updatedAt:string; currentVersionId:string|null; versionCount:number; }
export interface AppConfig { modelConfigured:boolean; model:string|null; storageMode:'local'|'supabase'; cloudConfigured:boolean; fixturesEnabled:boolean; limits:{maxRepairAttempts:number;runTimeoutSeconds:number;maxPromptLength:number}; }
export type RunEvent = {type:'status';status:RunStatus;message:string;runId:string} | {type:'candidate'|'complete';project:Project} | {type:'error';error:string;code?:string;project?:Project};
export const activeStatuses:RunStatus[]=['generating','validating','previewing','repairing'];
export function activeRun(project:Project):Run|undefined{return [...project.runs].reverse().find(r=>activeStatuses.includes(r.status));}
export function summary(project:Project):ProjectSummary{return {id:project.id,title:project.title,createdAt:project.createdAt,updatedAt:project.updatedAt,currentVersionId:project.currentVersionId,versionCount:project.versions.filter(v=>v.status==='ready').length};}
