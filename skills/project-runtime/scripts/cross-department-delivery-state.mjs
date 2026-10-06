function fail(message){throw new Error(message);}
function iso(value,label){const ms=Date.parse(value);if(!Number.isFinite(ms))fail(label+" must be ISO date-time");return ms;}
function copy(value){return structuredClone(value);}
function requireClaim(record,{token,fence}){
  if(record.state!=="claimed"||!record.claim)fail("delivery is not actively claimed");
  if(record.claim.token!==token||record.claim.fence!==fence||record.fence!==fence)fail("stale delivery claim");
}
export function createDelivery({id,organizationRef,requestRef,requestId,correlationId,origin,target,requestDigest,now}){
  if(!id||!organizationRef||!requestRef||!requestId||!correlationId||!origin?.department||!origin?.project_ref||!origin?.task_ref||!target?.department||!target?.project_ref||!requestDigest)fail("missing delivery identity");
  iso(now,"now");
  return {schema:"dev.woia.cross-department-delivery/v1",id,revision:1,organization_ref:organizationRef,request_ref:copy(requestRef),request_id:requestId,correlation_id:correlationId,origin:copy(origin),target:copy(target),request_digest:requestDigest,state:"queued",attempt:0,fence:0,claim:null,transport_ref:null,activation:{state:"not-requested",ref:null},receiver_task_ref:null,response_ref:null,blockers:[],created_at:now,updated_at:now};
}
export function claimDelivery(record,{workerId,token,now,expiresAt}){
  const next=copy(record),nowMs=iso(now,"now"),expMs=iso(expiresAt,"expiresAt");if(expMs<=nowMs)fail("claim expiry must be after now");
  if(!workerId||!token)fail("workerId and token are required");
  if(["completed","rejected","accepted","result-returned","activated","delivered","submitted","transport-unknown"].includes(next.state))fail("delivery state cannot be claimed");
  if(next.state==="blocked")fail("blocked delivery requires explicit recovery");
  if(next.state==="claimed"&&next.claim&&iso(next.claim.expires_at,"existing claim expiry")>nowMs)fail("delivery already has an active claim");
  const fence=(next.fence??0)+1;next.state="claimed";next.attempt=(next.attempt??0)+1;next.fence=fence;next.claim={token,worker_id:workerId,fence,claimed_at:now,expires_at:expiresAt};next.revision+=1;next.updated_at=now;return next;
}
export function markSubmitted(record,{token,fence,transportRef,now}){
  const next=copy(record);requireClaim(next,{token,fence});iso(now,"now");if(!transportRef)fail("transportRef is required");
  next.state="submitted";next.transport_ref=copy(transportRef);next.claim=null;next.revision+=1;next.updated_at=now;return next;
}
export function markTransportUnknown(record,{now,blocker}){
  const next=copy(record);iso(now,"now");if(next.state!=="submitted")fail("only submitted delivery can become transport-unknown");
  next.state="transport-unknown";next.blockers=blocker?[copy(blocker)]:[];next.revision+=1;next.updated_at=now;return next;
}
export function markDelivered(record,{now,transportRef=null}){
  const next=copy(record);iso(now,"now");if(!["submitted","transport-unknown"].includes(next.state))fail("delivery is not awaiting transport outcome");
  next.state="delivered";if(transportRef)next.transport_ref=copy(transportRef);next.blockers=[];next.activation={state:"requested",ref:null};next.revision+=1;next.updated_at=now;return next;
}
export function reconcileNotDelivered(record,{now}){
  const next=copy(record);iso(now,"now");if(next.state!=="transport-unknown")fail("only transport-unknown can be proven not delivered");
  if(next.receiver_task_ref)fail("receiver task exists; do not redeliver");next.state="queued";next.transport_ref=null;next.blockers=[];next.activation={state:"not-requested",ref:null};next.revision+=1;next.updated_at=now;return next;
}
export function markActivated(record,{now,activationRef}){
  const next=copy(record);iso(now,"now");if(next.state!=="delivered")fail("delivery must be delivered before activation");
  next.state="activated";next.activation={state:"active",ref:activationRef?copy(activationRef):null};next.blockers=[];next.revision+=1;next.updated_at=now;return next;
}
export function markActivationUnavailable(record,{now,blocker,activationRef=null}){
  const next=copy(record);iso(now,"now");if(next.state!=="delivered")fail("delivery must be delivered before activation failure");
  next.state="blocked";next.activation={state:"unavailable",ref:activationRef?copy(activationRef):null};next.blockers=blocker?[copy(blocker)]:[];next.revision+=1;next.updated_at=now;return next;
}
export function recoverBlockedDelivery(record,{now}){
  const next=copy(record);iso(now,"now");if(next.state!=="blocked")fail("only blocked delivery can recover");if(next.receiver_task_ref)fail("receiver task exists; recover result, not delivery");
  next.state="delivered";next.activation={state:"requested",ref:null};next.blockers=[];next.revision+=1;next.updated_at=now;return next;
}
export function acceptDelivery(record,{now,receiverTaskRef}){
  const next=copy(record);iso(now,"now");if(next.state!=="activated")fail("delivery must be activated before acceptance");if(!receiverTaskRef?.kind||!receiverTaskRef?.id)fail("receiverTaskRef is required");
  if(receiverTaskRef.id===next.origin.task_ref.id)fail("receiver must own a distinct Task");next.state="accepted";next.receiver_task_ref=copy(receiverTaskRef);next.revision+=1;next.updated_at=now;return next;
}
export function rejectDelivery(record,{now,responseRef,blocker=null}){
  const next=copy(record);iso(now,"now");if(!["activated","accepted"].includes(next.state))fail("delivery cannot be rejected from current state");if(!responseRef)fail("responseRef is required for receiver rejection");
  next.state="result-returned";next.response_ref=copy(responseRef);next.response_status="rejected";next.blockers=blocker?[copy(blocker)]:[];next.revision+=1;next.updated_at=now;return next;
}
export function returnDeliveryResult(record,{now,responseRef,responseStatus}){
  const next=copy(record);iso(now,"now");if(next.state!=="accepted")fail("receiver must accept before returning result");if(!responseRef)fail("responseRef is required");if(!["completed","blocked","rejected","accepted"].includes(responseStatus))fail("invalid responseStatus");
  next.state="result-returned";next.response_ref=copy(responseRef);next.response_status=responseStatus;next.revision+=1;next.updated_at=now;return next;
}
export function completeDelivery(record,{now}){
  const next=copy(record);iso(now,"now");if(next.state!=="result-returned")fail("result must be returned before completion");if(next.response_status==="accepted")fail("accepted is not a terminal receiver result");
  next.state="completed";next.blockers=[];next.revision+=1;next.updated_at=now;return next;
}
