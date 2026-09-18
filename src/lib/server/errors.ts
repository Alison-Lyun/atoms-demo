export class AppError extends Error {
  constructor(message:string, public status=400, public code='BAD_REQUEST'){ super(message); this.name='AppError'; }
}
export function publicError(error:unknown):{error:string;code:string;status:number} {
  if(error instanceof AppError)return {error:error.message,code:error.code,status:error.status};
  if(error && typeof error==='object' && 'status' in error && 'code' in error && error instanceof Error){
    const e=error as Error & {status:number;code:string};
    return {error:e.message,code:e.code,status:e.status};
  }
  return {error:'操作暂时未完成，请重试。原有版本已保留。',code:'INTERNAL_ERROR',status:500};
}
