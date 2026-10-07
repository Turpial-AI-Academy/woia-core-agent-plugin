import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createDueWork, claimDueWork, attachDueWorkTask, releaseDueWork, resumeDueWork, completeDueWork
} from "../skills/project-runtime/scripts/due-work-state.mjs";
import {
  createDelivery, claimDelivery, markSubmitted, markTransportUnknown, markDelivered,
  reconcileNotDelivered, markActivated, markActivationUnavailable, recoverBlockedDelivery,
  acceptDelivery, rejectDelivery, returnDeliveryResult, completeDelivery, createDeliveryResponse
} from "../skills/project-runtime/scripts/cross-department-delivery-state.mjs";
import {resolveProjectResources, resolveProjectResourcesFromFile} from "../skills/project-runtime/scripts/resolve-project-resources.mjs";
import {createOrchestratorCompositionSnapshot, createOrchestratorCompositionSnapshotFromFile} from "../skills/project-improvement/scripts/create-orchestrator-composition-snapshot.mjs";

const t0="2026-10-06T12:00:00Z", t1="2026-10-06T12:01:00Z", t2="2026-10-06T12:02:00Z", t3="2026-10-06T12:03:00Z";

test("Due Work uses dedupe identity and fencing so stale workers cannot complete",()=>{
  let d=createDueWork({
    id:"due:services:1",organizationRef:"org:agency",department:"asset-management",projectRef:"project:pm",
    rule:{id:"property-services.round",version:"1"},subjectRef:{type:"PropertyServiceCycle",id:"cycle:1"},
    dedupeKey:"property-services|account:1|2026-10|round:1",dueAt:t0,timezone:"America/Argentina/Cordoba",now:t0
  });
  d=claimDueWork(d,{workerId:"worker:a",token:"claim:a",now:t0,expiresAt:t2});
  const fenceA=d.fence;
  assert.equal(d.attempt,1);
  d=attachDueWorkTask(d,{token:"claim:a",fence:fenceA,taskRef:{kind:"Task",id:"task:pm",revision:1},now:t1});
  assert.equal(d.task_ref.id,"task:pm");
  assert.throws(()=>completeDueWork(d,{token:"bad",fence:fenceA,now:t2}),/stale/);
  d=releaseDueWork(d,{token:"claim:a",fence:fenceA,now:t1,blocker:{id:"source-down",type:"source",summary:"Provider unavailable"}});
  assert.equal(d.state,"blocked");
  assert.equal(d.task_ref.id,"task:pm");
  d=resumeDueWork(d,{now:t2,dueAt:t3});
  d=claimDueWork(d,{workerId:"worker:b",token:"claim:b",now:t3,expiresAt:"2026-10-06T12:10:00Z"});
  assert.ok(d.fence>fenceA);
  d=completeDueWork(d,{token:"claim:b",fence:d.fence,now:"2026-10-06T12:04:00Z",resultRef:{type:"Observation",id:"obs:1"}});
  assert.equal(d.state,"completed");
});

test("cross-department delivery distinguishes submission, unknown transport, delivery, activation, acceptance and result",()=>{
  let d=createDelivery({
    id:"delivery:req:1",organizationRef:"org:agency",requestRef:{type:"CrossDepartmentRequest",id:"req:1"},
    requestId:"req:1",correlationId:"corr:1",
    origin:{department:"sales",project_ref:"project:sales",task_ref:{kind:"Task",id:"task:sales",revision:2}},
    target:{department:"customer-service",project_ref:"project:cs"},
    requestDigest:"sha256:"+"a".repeat(64),now:t0
  });
  d=claimDelivery(d,{workerId:"transport:1",token:"claim:1",now:t0,expiresAt:t2});
  const fence=d.fence;
  d=markSubmitted(d,{token:"claim:1",fence,transportRef:{type:"TransportAttempt",id:"attempt:1"},now:t1});
  d=markTransportUnknown(d,{now:t2,blocker:{id:"unknown",type:"transport",summary:"No ack"}});
  assert.throws(()=>claimDelivery(d,{workerId:"transport:2",token:"claim:2",now:t2,expiresAt:t3}),/cannot be claimed/);
  d=markDelivered(d,{now:t3,transportRef:{type:"TransportReceipt",id:"receipt:1"}});
  d=markActivated(d,{now:"2026-10-06T12:04:00Z",activationRef:{type:"Activation",id:"activation:1"}});
  assert.throws(()=>acceptDelivery(d,{now:"2026-10-06T12:05:00Z",receiverTaskRef:{kind:"Task",id:"task:sales",revision:2},acceptanceResponseRef:{type:"CrossDepartmentResponse",id:"resp:bad"}}),/distinct Task/);
  d=acceptDelivery(d,{now:"2026-10-06T12:05:00Z",receiverTaskRef:{kind:"Task",id:"task:cs",revision:1},acceptanceResponseRef:{type:"CrossDepartmentResponse",id:"resp:accepted"},acceptanceResponse:createDeliveryResponse(d,{receiverTaskRef:{kind:"Task",id:"task:cs",revision:1},status:"accepted"})});
  assert.equal(d.acceptance_response_ref.id,"resp:accepted");
  assert.throws(()=>returnDeliveryResult(d,{now:"2026-10-06T12:05:30Z",responseRef:{type:"CrossDepartmentResponse",id:"resp:not-terminal"},responseStatus:"accepted"}),/terminal/);
  d=returnDeliveryResult(d,{now:"2026-10-06T12:06:00Z",responseRef:{type:"CrossDepartmentResponse",id:"resp:1"},responseStatus:"completed",response:createDeliveryResponse(d,{receiverTaskRef:d.receiver_task_ref,status:"completed"})});
  d=completeDelivery(d,{now:"2026-10-06T12:07:00Z"});
  assert.equal(d.state,"completed");
  assert.equal(d.receiver_task_ref.id,"task:cs");
});

function dueFixture(){return createDueWork({id:"due:1",organizationRef:"org:1",department:"sales",projectRef:"project:sales",rule:{id:"rule:1",version:"1"},subjectRef:{type:"Subject",id:"subject:1"},dedupeKey:"rule:1|subject:1|occurrence:1",dueAt:t0,timezone:"UTC",now:t0});}
function deliveryFixture(){return createDelivery({id:"delivery:1",organizationRef:"org:1",requestRef:{type:"CrossDepartmentRequest",id:"request:1"},requestId:"request:1",correlationId:"correlation:1",origin:{department:"sales",project_ref:"project:sales",task_ref:{kind:"Task",id:"task:sender",revision:1}},target:{department:"customer-service",project_ref:"project:receiver"},requestDigest:"sha256:"+"a".repeat(64),now:t0});}
function activatedFixture(){let d=claimDelivery(deliveryFixture(),{workerId:"worker:1",token:"claim:1",now:t0,expiresAt:t2});d=markSubmitted(d,{token:"claim:1",fence:d.fence,transportRef:{type:"Attempt",id:"attempt:1"},now:t1});return markActivated(markDelivered(d,{now:t2}),{now:t3,activationRef:{type:"Activation",id:"activation:1"}});}
const receiverTask={kind:"Task",id:"task:receiver",revision:1};
function acceptanceArgs(d){return {now:t3,receiverTaskRef:receiverTask,acceptanceResponseRef:{type:"CrossDepartmentResponse",id:"response:accepted"},acceptanceResponse:createDeliveryResponse(d,{receiverTaskRef:receiverTask,status:"accepted"})};}
function bindingFixture(){return {schema:"dev.woia.organization-resource-binding-set/v1",id:"bindings:1",revision:1,organization_ref:"org:1",updated_at:t0,bindings:[{id:"resource:1",resource_type:"domain-contract",capability_plugin:"provider:1",system_of_record:"organization-config",classification:"internal",contract:{id:"contract:1",version:"1"},binding_ref:"woia://org/1/resources/1",source_authority_map_ref:{type:"SourceAuthorityMap",id:"map:1",version:"1"},effective_from:null,effective_until:null,access:[{department:"sales",purposes:["commercial"],operations:["read"],minimum_fields:["contract"]},{department:"data",purposes:["governance"],operations:["read","update"],minimum_fields:["contract","writer"]}]}]};}
function resolutionArgs(bindingSet=bindingFixture()){return {bindingSet,organizationRef:"org:1",projectRef:"project:sales",department:"sales",purpose:"commercial",resolvedAt:t1};}
function compositionFixture(){const declaration={schema:"dev.woia.orchestrator-specialization/v1",id:"composition:1",department:"supply-acquisition",status:"qualified",generic_base:{plugin:"woia-supply-acquisition",version_range:{min_inclusive:"0.5.0",max_exclusive:"0.6.0"}},delta:{plugin:"woia-re-property-acquisition"},allowed_operations:["ADD","SPECIALIZE","NARROW"],exported_slots:["intake"],required_gates:["base-conformance"],evaluated_pairs:[{base_version:"0.5.1",delta_version:"0.5.0",status:"passed",provider_closure:[{plugin:"provider:1",version:"0.5.0"}],evidence:["evaluation:1"]}]};return {declaration,taskRef:{kind:"Task",id:"task:acquisition",revision:1},projectRef:"project:acquisition",department:"supply-acquisition",baseVersion:"0.5.1",baseSelector:"v0.5.1",deltaVersion:"0.5.0",deltaSelector:"v0.5.0",providers:[{plugin:"provider:1",version:"0.5.0",selector:"v0.5.0"}],createdAt:t0};}

test("expired Due Work claims cannot mutate, takeover increments fencing and retry preserves occurrence and Task",()=>{
  const original=dueFixture();let d=claimDueWork(original,{workerId:"a",token:"a",now:t0,expiresAt:t2});
  d=attachDueWorkTask(d,{token:"a",fence:d.fence,taskRef:{kind:"Task",id:"task:existing",revision:1},now:t1});
  for(const transition of [completeDueWork,releaseDueWork])assert.throws(()=>transition(d,{token:"a",fence:d.fence,now:t2}),/expired/);
  assert.throws(()=>attachDueWorkTask(d,{token:"a",fence:d.fence,taskRef:{kind:"Task",id:"task:new"},now:t2}),/expired/);
  const oldFence=d.fence;d=claimDueWork(d,{workerId:"b",token:"b",now:t2,expiresAt:t3});
  assert.equal(d.fence,oldFence+1);assert.throws(()=>completeDueWork(d,{token:"a",fence:oldFence,now:t2}),/stale/);
  assert.throws(()=>attachDueWorkTask(d,{token:"b",fence:d.fence,taskRef:{kind:"Task",id:"task:new"},now:t2}),/Task must be preserved/);
  d=releaseDueWork(d,{token:"b",fence:d.fence,now:t2,blocker:{id:"blocked",type:"source",summary:"unavailable"}});
  d=resumeDueWork(d,{now:t3});d=claimDueWork(d,{workerId:"c",token:"c",now:t3,expiresAt:"2026-10-06T12:10:00Z"});
  assert.equal(d.id,original.id);assert.equal(d.dedupe_key,original.dedupe_key);assert.equal(d.task_ref.id,"task:existing");
  assert.equal(original.state,"pending");assert.equal(d.attempt,3);
});

test("expired delivery claims cannot submit and stale fences remain invalid after takeover",()=>{
  const d=claimDelivery(deliveryFixture(),{workerId:"a",token:"a",now:t0,expiresAt:t2});
  const args={token:"a",fence:d.fence,transportRef:{type:"Attempt",id:"attempt:1"},now:t2};
  assert.throws(()=>markSubmitted(d,args),/expired/);
  const next=claimDelivery(d,{workerId:"b",token:"b",now:t2,expiresAt:t3});
  assert.equal(next.fence,d.fence+1);assert.throws(()=>markSubmitted(next,args),/stale/);
});

test("acceptance requires a typed correlated response from the receiver and never completes delivery",()=>{
  const d=activatedFixture(),args=acceptanceArgs(d);
  for(const edit of [r=>{r.request_id="other";},r=>{r.correlation_id="other";},r=>{r.receiver.department="sales";},r=>{r.receiver.project_ref="other";},r=>{r.receiver.task_ref.id="other";},r=>{r.status="completed";}]){
    const response=structuredClone(args.acceptanceResponse);edit(response);assert.throws(()=>acceptDelivery(d,{...args,acceptanceResponse:response}),/mismatch|target Project|expected typed status/);
  }
  assert.throws(()=>acceptDelivery(d,{...args,acceptanceResponseRef:{type:"Observation",id:"fake"}}),/CrossDepartmentResponse/);
  assert.throws(()=>acceptDelivery(d,{...args,acceptanceResponse:{...args.acceptanceResponse,blockers:[null]}}),/blocker/);
  const accepted=acceptDelivery(d,args);assert.equal(accepted.state,"accepted");assert.equal(accepted.response_ref,null);
  assert.throws(()=>completeDelivery(accepted,{now:t3}),/result must be returned/);
  assert.equal("authority" in args.acceptanceResponse.receiver,false);assert.equal("origin" in args.acceptanceResponse,false);
});

test("completed, blocked and rejected results are separate correlated terminal responses",()=>{
  for(const status of ["completed","blocked","rejected"]){
    const d=acceptDelivery(activatedFixture(),acceptanceArgs(activatedFixture()));
    const response=createDeliveryResponse(d,{receiverTaskRef:receiverTask,status});
    const args={now:t3,responseRef:{type:"CrossDepartmentResponse",id:"response:"+status},responseStatus:status,response};
    assert.throws(()=>returnDeliveryResult(d,{...args,response:{...response,correlation_id:"other"}}),/correlation mismatch/);
    assert.throws(()=>returnDeliveryResult(d,{...args,response:{...response,status:"accepted"}}),/expected typed status/);
    assert.throws(()=>returnDeliveryResult(d,{...args,responseRef:d.acceptance_response_ref}),/distinct/);
    const result=returnDeliveryResult(d,args);assert.equal(result.state,"result-returned");
    assert.equal(result.acceptance_response_ref.id,"response:accepted");assert.equal(result.response_status,status);
    assert.equal(completeDelivery(result,{now:t3}).state,"completed");
  }
  const d=activatedFixture(),response=createDeliveryResponse(d,{receiverTaskRef:receiverTask,status:"rejected"});
  assert.equal(completeDelivery(rejectDelivery(d,{now:t3,responseRef:{type:"CrossDepartmentResponse",id:"response:rejected"},response}),{now:t3}).state,"completed");
});

test("activation recovery retains confirmed transport and cannot dispatch another message",()=>{
  let d=claimDelivery(deliveryFixture(),{workerId:"a",token:"a",now:t0,expiresAt:t2});
  d=markSubmitted(d,{token:"a",fence:d.fence,transportRef:{type:"Receipt",id:"confirmed:1"},now:t1});
  d=markActivationUnavailable(markDelivered(d,{now:t2}),{now:t3,blocker:{id:"activation-down",type:"activation",summary:"unavailable"}});
  assert.throws(()=>claimDelivery(d,{workerId:"b",token:"b",now:t3,expiresAt:"2026-10-06T12:10:00Z"}),/explicit recovery/);
  d=recoverBlockedDelivery(d,{now:t3});assert.equal(d.transport_ref.id,"confirmed:1");assert.equal(d.attempt,1);
  assert.throws(()=>claimDelivery(d,{workerId:"b",token:"b",now:t3,expiresAt:"2026-10-06T12:10:00Z"}),/cannot be claimed/);
  assert.equal(markActivated(d,{now:t3}).state,"activated");
});

test("organization effective intervals fail closed for invalid dates, types and nonpositive intervals",()=>{
  for(const value of ["not-a-date","2026","2026-02-30T12:00:00Z",0])for(const field of ["effective_from","effective_until"]){
    const set=bindingFixture();set.bindings[0][field]=value;assert.throws(()=>resolveProjectResources(resolutionArgs(set)),/ISO date-time/);
  }
  for(const end of [t0,"2026-10-05T12:00:00Z"]){const set=bindingFixture();set.bindings[0].effective_from=t0;set.bindings[0].effective_until=end;assert.throws(()=>resolveProjectResources(resolutionArgs(set)),/effective interval/);}
  const set=bindingFixture();set.bindings[0].effective_from=t2;assert.equal(resolveProjectResources(resolutionArgs(set)).resources.length,0);
  set.bindings[0].effective_from=t0;set.bindings[0].effective_until=t1;assert.equal(resolveProjectResources(resolutionArgs(set)).resources.length,0);
});

test("purpose-scoped resolution never copies secret/master fields or shares mutable organization references",()=>{
  const set=bindingFixture(),doc=resolveProjectResources(resolutionArgs(set));
  assert.deepEqual(doc.resources[0].operations,["read"]);assert.deepEqual(doc.resources[0].minimum_fields,["contract"]);
  assert.equal(resolveProjectResources({...resolutionArgs(set),purpose:"governance"}).resources.length,0);
  set.bindings[0].source_authority_map_ref.id="changed";assert.equal(doc.resources[0].source_authority_map_ref.id,"map:1");
  for(const location of [s=>s,s=>s.bindings[0],s=>s.bindings[0].contract,s=>s.bindings[0].source_authority_map_ref]){
    const bad=bindingFixture();location(bad).credentials="SECRET_SENTINEL";assert.throws(()=>resolveProjectResources(resolutionArgs(bad)),/invalid fields/);
  }
  const malformed=bindingFixture();malformed.bindings[0].access[0].purposes="commercial";
  assert.throws(()=>resolveProjectResources(resolutionArgs(malformed)),/must be an array/);
});

test("file resource resolution requires the authenticated expected organization",async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-b4-resources-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const bindingSetFile=path.join(root,"bindings.json"),output=path.join(root,"resolution.json");await writeFile(bindingSetFile,JSON.stringify(bindingFixture()));
  const {bindingSet,...args}=resolutionArgs();
  await assert.rejects(()=>resolveProjectResourcesFromFile({...args,bindingSetFile,organizationRef:"org:other",output}),/does not match requested organization/);
  await assert.rejects(()=>resolveProjectResourcesFromFile({...args,bindingSetFile,organizationRef:undefined,output}),/are required/);
  assert.equal((await resolveProjectResourcesFromFile({...args,bindingSetFile,output})).organization_ref,"org:1");
});

test("resource snapshots preserve versioned resolution under sequential and concurrent writes",async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-b4-resource-pin-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const bindingSetFile=path.join(root,"bindings.json"),changedFile=path.join(root,"changed.json"),output=path.join(root,"resolution.json");
  const set=bindingFixture(),changed=structuredClone(set);changed.revision=2;changed.bindings[0].access[0].operations=["write"];
  await writeFile(bindingSetFile,JSON.stringify(set));await writeFile(changedFile,JSON.stringify(changed));
  const {bindingSet,...args}=resolutionArgs();
  const first=await resolveProjectResourcesFromFile({...args,bindingSetFile,output});
  assert.deepEqual(await resolveProjectResourcesFromFile({...args,bindingSetFile,output,resolvedAt:t2}),first);
  await assert.rejects(()=>resolveProjectResourcesFromFile({...args,bindingSetFile:changedFile,output}),/immutable/);
  assert.deepEqual(JSON.parse(await readFile(output,"utf8")),first);
  const raceOutput=path.join(root,"race.json"),results=await Promise.allSettled([bindingSetFile,changedFile].map(file=>resolveProjectResourcesFromFile({...args,bindingSetFile:file,output:raceOutput})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.match(results.find(r=>r.status==="rejected").reason.message,/immutable/);
  assert.deepEqual(JSON.parse(await readFile(raceOutput,"utf8")),results.find(r=>r.status==="fulfilled").value);
});

test("composition requires exact evaluated pair and immutable version-matching selectors",()=>{
  const args=compositionFixture();assert.throws(()=>createOrchestratorCompositionSnapshot({...args,baseVersion:"0.5.2",baseSelector:"v0.5.2"}),/no passed evaluation/);
  const failed=structuredClone(args);failed.declaration.evaluated_pairs[0].status="failed";assert.throws(()=>createOrchestratorCompositionSnapshot(failed),/no passed evaluation/);
  for(const field of ["baseSelector","deltaSelector"])for(const selector of ["main","v9.0.0"])assert.throws(()=>createOrchestratorCompositionSnapshot({...args,[field]:selector}),/immutable/);
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,providers:[{...args.providers[0],selector:"main"}]}),/immutable/);
  assert.ok(createOrchestratorCompositionSnapshot({...args,baseSelector:"a".repeat(40)}));
});

test("composition rejects malformed semantic arrays and pins every declaration change",()=>{
  const args=compositionFixture(),snapshot=createOrchestratorCompositionSnapshot(args);
  for(const field of ["exported_slots","required_gates","allowed_operations"])for(const value of [[],[""],[null],["duplicate","duplicate"]]){
    const changed=structuredClone(args);changed.declaration[field]=value;assert.throws(()=>createOrchestratorCompositionSnapshot(changed));
  }
  for(const evidence of [[],[""],[null]]){const changed=structuredClone(args);changed.declaration.evaluated_pairs[0].evidence=evidence;assert.throws(()=>createOrchestratorCompositionSnapshot(changed),/evidence/);}
  for(const field of ["exported_slots","required_gates"]){const changed=structuredClone(args);changed.declaration[field].push("new");assert.notEqual(createOrchestratorCompositionSnapshot(changed).composed_digest,snapshot.composed_digest);}
  const changed=structuredClone(args);changed.declaration.allowed_operations=["NARROW"];assert.notEqual(createOrchestratorCompositionSnapshot(changed).composed_digest,snapshot.composed_digest);
  for(const field of ["organizationRevision","departmentRevision"])for(const value of [0,-1,1.5,"1"])assert.throws(()=>createOrchestratorCompositionSnapshot({...args,[field]:value}),/positive integer/);
});

test("in-flight snapshots cannot be replaced sequentially or by concurrent composition writers",async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-b4-composition-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const args=compositionFixture(),declarationFile=path.join(root,"declaration.json"),output=path.join(root,"snapshot.json");
  await writeFile(declarationFile,JSON.stringify(args.declaration));const {declaration,...rest}=args;
  const first=await createOrchestratorCompositionSnapshotFromFile({...rest,declarationFile,output});assert.equal(first.result,"CREATED");
  assert.equal((await createOrchestratorCompositionSnapshotFromFile({...rest,declarationFile,output,createdAt:t1})).result,"UNCHANGED");
  const changed=structuredClone(declaration);changed.required_gates.push("new-gate");const changedFile=path.join(root,"changed.json");await writeFile(changedFile,JSON.stringify(changed));
  await assert.rejects(()=>createOrchestratorCompositionSnapshotFromFile({...rest,declarationFile:changedFile,output}),/immutable/);
  assert.deepEqual(JSON.parse(await readFile(output,"utf8")),first.snapshot);
  const raceOutput=path.join(root,"race.json");const results=await Promise.allSettled([declarationFile,changedFile].map(file=>createOrchestratorCompositionSnapshotFromFile({...rest,declarationFile:file,output:raceOutput})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.match(results.find(r=>r.status==="rejected").reason.message,/immutable/);
  const winner=results.find(r=>r.status==="fulfilled").value.snapshot;assert.deepEqual(JSON.parse(await readFile(raceOutput,"utf8")),winner);
});

test("all five B4 output schemas validate real transitions and reject invalid delivery evidence",async()=>{
  const ajv=new Ajv2020({strict:false,allErrors:true,formats:{"date-time":true}}),dir=path.resolve("dev.woia/schemas");
  for(const file of (await readdir(dir)).filter(f=>f.endsWith(".schema.json")))ajv.addSchema(JSON.parse(await readFile(path.join(dir,file),"utf8")));
  const check=(name,doc)=>{const validate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/"+name+".schema.json");assert.equal(validate(doc),true,JSON.stringify(validate.errors));return validate;};
  const due=claimDueWork(dueFixture(),{workerId:"w",token:"c",now:t0,expiresAt:t2});const dueValidate=check("due-work",due);
  for(const doc of [{...due,claim:null},{...due,state:"pending"},{...due,task_ref:{kind:"Observation",id:"obs:1"}}])assert.equal(dueValidate(doc),false);
  assert.throws(()=>claimDueWork({...due,claim:null},{workerId:"w2",token:"c2",now:t2,expiresAt:t3}),/requires a claim/);
  check("due-work",dueFixture());check("organization-resource-binding-set",bindingFixture());check("project-resource-resolution",resolveProjectResources(resolutionArgs()));check("orchestrator-composition-snapshot",createOrchestratorCompositionSnapshot(compositionFixture()));
  const queued=deliveryFixture(),claimed=claimDelivery(queued,{workerId:"w",token:"c",now:t0,expiresAt:t2});
  const submitted=markSubmitted(claimed,{token:"c",fence:claimed.fence,transportRef:{type:"Attempt",id:"attempt:1"},now:t1});
  const unknown=markTransportUnknown(submitted,{now:t2}),delivered=markDelivered(unknown,{now:t3});
  const activated=markActivated(delivered,{now:t3}),args=acceptanceArgs(activated),accepted=acceptDelivery(activated,args);
  const response=createDeliveryResponse(accepted,{receiverTaskRef:receiverTask,status:"completed"});
  check("cross-department-message",args.acceptanceResponse);check("cross-department-message",response);
  const returned=returnDeliveryResult(accepted,{now:t3,responseRef:{type:"CrossDepartmentResponse",id:"response:terminal"},responseStatus:"completed",response});
  for(const doc of [queued,claimed,submitted,unknown,delivered,activated,accepted,returned,completeDelivery(returned,{now:t3})])check("cross-department-delivery",doc);
  const validate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/cross-department-delivery.schema.json");
  for(const doc of [{...claimed,claim:null},{...accepted,acceptance_response_ref:null},{...accepted,receiver_task_ref:{kind:"Observation",id:"obs:1"}},{...accepted,acceptance_response_ref:{type:"Observation",id:"obs:1"}},{...returned,response_ref:null},{...returned,response_ref:{type:"Observation",id:"obs:1"}},{...returned,response_status:"accepted"},{...queued,private_real_estate_field:"forbidden"}])assert.equal(validate(doc),false);
  assert.throws(()=>claimDelivery({...claimed,claim:null},{workerId:"w2",token:"c2",now:t2,expiresAt:t3}),/requires a claim/);
});

test("unknown delivery may be retried only after proven not delivered, and activation failure has explicit recovery",()=>{
  let d=createDelivery({
    id:"delivery:req:2",organizationRef:"org:agency",requestRef:{type:"CrossDepartmentRequest",id:"req:2"},
    requestId:"req:2",correlationId:"corr:2",
    origin:{department:"finance",project_ref:"project:finance",task_ref:{kind:"Task",id:"task:finance",revision:1}},
    target:{department:"customer-service",project_ref:"project:cs"},
    requestDigest:"sha256:"+"b".repeat(64),now:t0
  });
  d=claimDelivery(d,{workerId:"transport:1",token:"c1",now:t0,expiresAt:t2});
  d=markSubmitted(d,{token:"c1",fence:d.fence,transportRef:{type:"Attempt",id:"a1"},now:t1});
  d=markTransportUnknown(d,{now:t2});
  d=reconcileNotDelivered(d,{now:t3});
  assert.equal(d.state,"queued");
  d=claimDelivery(d,{workerId:"transport:2",token:"c2",now:t3,expiresAt:"2026-10-06T12:10:00Z"});
  d=markSubmitted(d,{token:"c2",fence:d.fence,transportRef:{type:"Attempt",id:"a2"},now:"2026-10-06T12:04:00Z"});
  d=markDelivered(d,{now:"2026-10-06T12:05:00Z"});
  d=markActivationUnavailable(d,{now:"2026-10-06T12:06:00Z",blocker:{id:"receiver-offline",type:"activation",summary:"Host activation unavailable"}});
  assert.equal(d.state,"blocked");
  d=recoverBlockedDelivery(d,{now:"2026-10-06T12:07:00Z"});
  assert.equal(d.state,"delivered");
  assert.equal(d.transport_ref.id,"a2");
});

test("Project resource resolution filters by organization-scoped department purpose and emits stable digest",()=>{
  const bindingSet={
    schema:"dev.woia.organization-resource-binding-set/v1",id:"org-bindings",revision:4,organization_ref:"org:agency",updated_at:t0,
    bindings:[
      {
        id:"real-estate-contract",resource_type:"domain-contract",capability_plugin:"woia-re-domain-contracts",
        system_of_record:"woia-ecosystem",classification:"internal",
        contract:{id:"woia.real-estate.domain/v1",version:"1",digest:null},
        binding_ref:"woia://org/agency/resources/re-domain-v1",source_authority_map_ref:null,effective_from:null,effective_until:null,
        access:[
          {department:"data",purposes:["governance"],operations:["read","validate"],minimum_fields:["contract","version"]},
          {department:"sales",purposes:["commercial"],operations:["read"],minimum_fields:["contract"]}
        ]
      },
      {
        id:"finance-source-map",resource_type:"source-authority-map",capability_plugin:"woia-data-governance",
        system_of_record:"organization-config",classification:"restricted",
        contract:{id:"source-authority-map",version:"7",digest:null},
        binding_ref:"woia://org/agency/resources/source-map",source_authority_map_ref:null,effective_from:null,effective_until:null,
        access:[{department:"data",purposes:["governance"],operations:["read","update"],minimum_fields:["scope","writer"]}]
      }
    ]
  };
  const a=resolveProjectResources({bindingSet,organizationRef:"org:agency",projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1});
  const b=resolveProjectResources({bindingSet,organizationRef:"org:agency",projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1});
  assert.equal(a.composed_digest,b.composed_digest);
  assert.deepEqual(a.resources.map(x=>x.binding_id),["finance-source-map","real-estate-contract"]);
  const sales=resolveProjectResources({bindingSet,organizationRef:"org:agency",projectRef:"project:sales",department:"sales",purpose:"commercial",resolvedAt:t1});
  assert.deepEqual(sales.resources.map(x=>x.binding_id),["real-estate-contract"]);
  assert.equal(JSON.stringify(sales).includes("finance-source-map"),false);
  const duplicate=structuredClone(bindingSet);duplicate.bindings.push(structuredClone(duplicate.bindings[0]));
  assert.throws(()=>resolveProjectResources({bindingSet:duplicate,organizationRef:"org:agency",projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1}),/duplicate organization resource binding id/);
  const badInterval=structuredClone(bindingSet);badInterval.bindings[0].effective_from=t2;badInterval.bindings[0].effective_until=t1;
  assert.throws(()=>resolveProjectResources({bindingSet:badInterval,organizationRef:"org:agency",projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1}),/effective interval/);
  assert.throws(()=>resolveProjectResources({bindingSet,organizationRef:"org:other",projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1}),/does not match requested organization/);
});

test("orchestrator specialization activates only an evaluated exact base/delta/provider closure",()=>{
  const declaration={
    schema:"dev.woia.orchestrator-specialization/v1",id:"property-acquisition-re",department:"supply-acquisition",status:"qualified",
    generic_base:{plugin:"woia-supply-acquisition",version_range:{min_inclusive:"0.5.0",max_exclusive:"0.6.0"}},
    delta:{plugin:"woia-re-property-acquisition"},
    allowed_operations:["ADD","SPECIALIZE","NARROW"],exported_slots:["intake","readiness"],required_gates:["base-conformance","delta-narrowing"],
    evaluated_pairs:[
      {base_version:"0.5.1",delta_version:"0.5.0",status:"passed",provider_closure:[{plugin:"woia-re-property-data",version:"0.5.0"}],evidence:["eval:pair-1"]}
    ]
  };
  const args={
    declaration,taskRef:{kind:"Task",id:"task:acq",revision:1},projectRef:"project:acq",department:"supply-acquisition",
    baseVersion:"0.5.1",baseSelector:"v0.5.1",deltaVersion:"0.5.0",deltaSelector:"v0.5.0",
    providers:[{plugin:"woia-re-property-data",version:"0.5.0",selector:"v0.5.0"}],
    organizationRevision:2,departmentRevision:3,createdAt:t0
  };
  const a=createOrchestratorCompositionSnapshot(args), b=createOrchestratorCompositionSnapshot(args);
  assert.equal(a.composed_digest,b.composed_digest);
  assert.equal(a.active_root.plugin,"woia-re-property-acquisition");
  assert.equal(a.generic_base.plugin,"woia-supply-acquisition");
  assert.match(a.declaration_digest,/^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(a.required_gates,["base-conformance","delta-narrowing"]);
  const changed={...declaration,required_gates:[...declaration.required_gates,"new-gate"]};
  const changedSnapshot=createOrchestratorCompositionSnapshot({...args,declaration:changed});
  assert.notEqual(changedSnapshot.composed_digest,a.composed_digest);
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,department:"marketing"}),/requested department/);
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,baseVersion:"0.6.0"}),/outside compatible range/);
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,providers:[]}),/provider closure/);
  const noEvidence=structuredClone(declaration);noEvidence.evaluated_pairs[0].evidence=[];
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,declaration:noEvidence}),/evaluation evidence/);
});
