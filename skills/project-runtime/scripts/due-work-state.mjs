function fail(message){throw new Error(message);}
function iso(value,label){const ms=Date.parse(value);if(!Number.isFinite(ms))fail(label+" must be ISO date-time");return ms;}
function copy(value){return structuredClone(value);}
function requireClaim(record,{token,fence}){
  if(record.state!=="claimed"||!record.claim)fail("due work is not actively claimed");
  if(record.claim.token!==token||record.claim.fence!==fence||record.fence!==fence)fail("stale due-work claim");
}
export function createDueWork({id,organizationRef,department,projectRef,rule,subjectRef,dedupeKey,dueAt,timezone,now}){
  if(!id||!organizationRef||!department||!projectRef||!rule?.id||!rule?.version||!subjectRef||!dedupeKey||!timezone)fail("missing due-work identity");
  iso(dueAt,"dueAt");iso(now,"now");
  return {schema:"dev.woia.due-work/v1",id,revision:1,organization_ref:organizationRef,department,project_ref:projectRef,rule:copy(rule),subject_ref:copy(subjectRef),dedupe_key:dedupeKey,due_at:dueAt,timezone,state:"pending",attempt:0,fence:0,claim:null,task_ref:null,last_result_ref:null,blockers:[],created_at:now,updated_at:now};
}
export function claimDueWork(record,{workerId,token,now,expiresAt}){
  const next=copy(record);const nowMs=iso(now,"now"),expMs=iso(expiresAt,"expiresAt");if(expMs<=nowMs)fail("claim expiry must be after now");
  if(!workerId||!token)fail("workerId and token are required");
  if(["completed","cancelled"].includes(next.state))fail("terminal due work cannot be claimed");
  if(next.state==="blocked")fail("blocked due work must be resumed explicitly");
  if(next.state==="claimed"&&next.claim&&iso(next.claim.expires_at,"existing claim expiry")>nowMs)fail("due work already has an active claim");
  const fence=(next.fence??0)+1;
  next.state="claimed";next.attempt=(next.attempt??0)+1;next.fence=fence;next.claim={token,worker_id:workerId,fence,claimed_at:now,expires_at:expiresAt};next.revision+=1;next.updated_at=now;
  return next;
}
export function releaseDueWork(record,{token,fence,now,nextDueAt=null,blocker=null}){
  const next=copy(record);requireClaim(next,{token,fence});iso(now,"now");
  if(nextDueAt)iso(nextDueAt,"nextDueAt");
  next.claim=null;next.task_ref=null;
  if(blocker){next.state="blocked";next.blockers=[copy(blocker)];}
  else{next.state="pending";next.blockers=[];if(nextDueAt)next.due_at=nextDueAt;}
  next.revision+=1;next.updated_at=now;return next;
}
export function resumeDueWork(record,{now,dueAt=null}){
  const next=copy(record);iso(now,"now");if(next.state!=="blocked")fail("only blocked due work can be resumed");if(dueAt)iso(dueAt,"dueAt");
  next.state="pending";next.blockers=[];next.claim=null;if(dueAt)next.due_at=dueAt;next.revision+=1;next.updated_at=now;return next;
}
export function attachDueWorkTask(record,{token,fence,taskRef,now}){
  const next=copy(record);requireClaim(next,{token,fence});iso(now,"now");if(!taskRef?.kind||!taskRef?.id)fail("taskRef is required");
  next.task_ref=copy(taskRef);next.revision+=1;next.updated_at=now;return next;
}
export function completeDueWork(record,{token,fence,now,resultRef=null}){
  const next=copy(record);requireClaim(next,{token,fence});iso(now,"now");
  next.state="completed";next.claim=null;next.blockers=[];next.last_result_ref=resultRef?copy(resultRef):null;next.revision+=1;next.updated_at=now;return next;
}
export function cancelDueWork(record,{now}){
  const next=copy(record);iso(now,"now");if(["completed","cancelled"].includes(next.state))fail("due work already terminal");
  next.state="cancelled";next.claim=null;next.blockers=[];next.revision+=1;next.updated_at=now;return next;
}
