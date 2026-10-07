import {instant as iso, requireBlocker, requireObject, requireResourceRef, requireStrings, requireTaskRef} from "./b4-contract.mjs";
function fail(message){throw new Error(message);}
function copy(value){return structuredClone(value);}
function requireClaim(record,{token,fence,now}){
  if(record.state!=="claimed"||!record.claim)fail("delivery is not actively claimed");
  if(record.claim.token!==token||record.claim.fence!==fence||record.fence!==fence)fail("stale delivery claim");
  const at=iso(now,"now");
  if(at<iso(record.claim.claimed_at,"claim start")||at>=iso(record.claim.expires_at,"claim expiry"))fail("expired or not yet valid delivery claim");
}
function requireResponse(record,response,status,taskRef){
  requireObject(response,["schema","request_id","correlation_id","receiver","status","output_refs","evidence","blockers"],"response");
  if(response.schema!=="dev.woia.cross-department-response/v1"||response.status!==status)fail("response must have the expected typed status");
  if(response.request_id!==record.request_id||response.correlation_id!==record.correlation_id)fail("response request/correlation mismatch");
  requireObject(response.receiver,["department","project_ref","task_ref"],"response.receiver");
  requireTaskRef(response.receiver.task_ref,"response.receiver.task_ref");
  if(response.receiver.department!==record.target.department||response.receiver.project_ref!==record.target.project_ref)fail("response receiver does not own the target Project");
  if(response.receiver.task_ref.id===record.origin.task_ref.id)fail("receiver must own a distinct Task");
  if(taskRef&&(response.receiver.task_ref.kind!==taskRef.kind||response.receiver.task_ref.id!==taskRef.id))fail("response receiver Task mismatch");
  if(!Array.isArray(response.output_refs)||!Array.isArray(response.blockers))fail("response outputs and blockers must be arrays");
  for(const ref of response.output_refs)requireResourceRef(ref,"response output");
  for(const blocker of response.blockers)requireBlocker(blocker);
  requireStrings(response.evidence,"response evidence");
}
function requireResponseRef(ref){
  requireResourceRef(ref,"responseRef");
  if(ref.type!=="CrossDepartmentResponse")fail("responseRef must reference a CrossDepartmentResponse");
}
export function createDeliveryResponse(record,{receiverTaskRef,status,outputRefs=[],evidence=[],blockers=[]}){
  if(!["accepted","completed","blocked","rejected"].includes(status))fail("response status is invalid");
  const response={schema:"dev.woia.cross-department-response/v1",request_id:record.request_id,correlation_id:record.correlation_id,
    receiver:{department:record.target.department,project_ref:record.target.project_ref,task_ref:copy(receiverTaskRef)},
    status,output_refs:copy(outputRefs),evidence:copy(evidence),blockers:copy(blockers)};
  requireResponse(record,response,status,record.receiver_task_ref);
  return response;
}
export function createDelivery({id,organizationRef,requestRef,requestId,correlationId,origin,target,requestDigest,now}){
  if(!id||!organizationRef||!requestRef||!requestId||!correlationId||!origin?.department||!origin?.project_ref||!origin?.task_ref||!target?.department||!target?.project_ref||!requestDigest)fail("missing delivery identity");
  iso(now,"now");
  requireResourceRef(requestRef,"requestRef");if(requestRef.type!=="CrossDepartmentRequest")fail("requestRef must reference a CrossDepartmentRequest");
  requireObject(origin,["department","project_ref","task_ref"],"origin");requireObject(target,["department","project_ref"],"target");requireTaskRef(origin.task_ref,"origin.task_ref");
  return {schema:"dev.woia.cross-department-delivery/v1",id,revision:1,organization_ref:organizationRef,request_ref:copy(requestRef),request_id:requestId,correlation_id:correlationId,origin:copy(origin),target:copy(target),request_digest:requestDigest,state:"queued",attempt:0,fence:0,claim:null,transport_ref:null,activation:{state:"not-requested",ref:null},receiver_task_ref:null,acceptance_response_ref:null,response_ref:null,blockers:[],created_at:now,updated_at:now};
}
export function claimDelivery(record,{workerId,token,now,expiresAt}){
  const next=copy(record),nowMs=iso(now,"now"),expMs=iso(expiresAt,"expiresAt");if(expMs<=nowMs)fail("claim expiry must be after now");
  if(!workerId||!token)fail("workerId and token are required");
  if(["completed","accepted","result-returned","activated","delivered","submitted","transport-unknown"].includes(next.state))fail("delivery state cannot be claimed");
  if(next.state==="blocked")fail("blocked delivery requires explicit recovery");
  if(next.state==="claimed"&&!next.claim)fail("claimed delivery requires a claim");
  if(next.state==="claimed"&&next.claim&&iso(next.claim.expires_at,"existing claim expiry")>nowMs)fail("delivery already has an active claim");
  const fence=(next.fence??0)+1;next.state="claimed";next.attempt=(next.attempt??0)+1;next.fence=fence;next.claim={token,worker_id:workerId,fence,claimed_at:now,expires_at:expiresAt};next.revision+=1;next.updated_at=now;return next;
}
export function markSubmitted(record,{token,fence,transportRef,now}){
  const next=copy(record);requireClaim(next,{token,fence,now});requireResourceRef(transportRef,"transportRef");
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
export function acceptDelivery(record,{now,receiverTaskRef,acceptanceResponseRef,acceptanceResponse}){
  const next=copy(record);iso(now,"now");if(next.state!=="activated")fail("delivery must be activated before acceptance");requireTaskRef(receiverTaskRef,"receiverTaskRef");requireResponseRef(acceptanceResponseRef);
  if(receiverTaskRef.id===next.origin.task_ref.id)fail("receiver must own a distinct Task");
  requireResponse(next,acceptanceResponse,"accepted",receiverTaskRef);
  if(receiverTaskRef.id===next.origin.task_ref.id)fail("receiver must own a distinct Task");next.state="accepted";next.receiver_task_ref=copy(receiverTaskRef);next.acceptance_response_ref=copy(acceptanceResponseRef);next.revision+=1;next.updated_at=now;return next;
}
export function rejectDelivery(record,{now,responseRef,response,blocker=null}){
  const next=copy(record);iso(now,"now");if(!["activated","accepted"].includes(next.state))fail("delivery cannot be rejected from current state");requireResponseRef(responseRef);requireResponse(next,response,"rejected",next.receiver_task_ref);
  if(next.acceptance_response_ref?.id===responseRef.id)fail("terminal response must be distinct from acceptance response");
  next.state="result-returned";next.response_ref=copy(responseRef);next.response_status="rejected";next.blockers=blocker?[copy(blocker)]:[];next.revision+=1;next.updated_at=now;return next;
}
export function returnDeliveryResult(record,{now,responseRef,responseStatus,response}){
  const next=copy(record);iso(now,"now");if(next.state!=="accepted")fail("receiver must accept before returning result");requireResponseRef(responseRef);if(!["completed","blocked","rejected"].includes(responseStatus))fail("responseStatus must be terminal");
  requireResponse(next,response,responseStatus,next.receiver_task_ref);
  if(next.acceptance_response_ref?.id===responseRef.id)fail("terminal response must be distinct from acceptance response");
  next.state="result-returned";next.response_ref=copy(responseRef);next.response_status=responseStatus;next.revision+=1;next.updated_at=now;return next;
}
export function completeDelivery(record,{now}){
  const next=copy(record);iso(now,"now");if(next.state!=="result-returned")fail("result must be returned before completion");requireResponseRef(next.response_ref);if(!["completed","blocked","rejected"].includes(next.response_status))fail("responseStatus must be terminal");next.state="completed";next.blockers=[];next.revision+=1;next.updated_at=now;return next;
}
