import assert from "node:assert/strict";
import test from "node:test";
import {
  createDueWork, claimDueWork, attachDueWorkTask, releaseDueWork, resumeDueWork, completeDueWork
} from "../skills/project-runtime/scripts/due-work-state.mjs";
import {
  createDelivery, claimDelivery, markSubmitted, markTransportUnknown, markDelivered,
  reconcileNotDelivered, markActivated, markActivationUnavailable, recoverBlockedDelivery,
  acceptDelivery, returnDeliveryResult, completeDelivery
} from "../skills/project-runtime/scripts/cross-department-delivery-state.mjs";
import {resolveProjectResources} from "../skills/project-runtime/scripts/resolve-project-resources.mjs";
import {createOrchestratorCompositionSnapshot} from "../skills/project-improvement/scripts/create-orchestrator-composition-snapshot.mjs";

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
  d=releaseDueWork(d,{token:"claim:a",fence:fenceA,now:t2,blocker:{id:"source-down",type:"source",summary:"Provider unavailable"}});
  assert.equal(d.state,"blocked");
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
  assert.throws(()=>acceptDelivery(d,{now:"2026-10-06T12:05:00Z",receiverTaskRef:{kind:"Task",id:"task:sales",revision:2}}),/distinct Task/);
  d=acceptDelivery(d,{now:"2026-10-06T12:05:00Z",receiverTaskRef:{kind:"Task",id:"task:cs",revision:1}});
  d=returnDeliveryResult(d,{now:"2026-10-06T12:06:00Z",responseRef:{type:"CrossDepartmentResponse",id:"resp:1"},responseStatus:"completed"});
  d=completeDelivery(d,{now:"2026-10-06T12:07:00Z"});
  assert.equal(d.state,"completed");
  assert.equal(d.receiver_task_ref.id,"task:cs");
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
  assert.equal(d.state,"queued");
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
  const a=resolveProjectResources({bindingSet,projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1});
  const b=resolveProjectResources({bindingSet,projectRef:"project:data",department:"data",purpose:"governance",resolvedAt:t1});
  assert.equal(a.composed_digest,b.composed_digest);
  assert.deepEqual(a.resources.map(x=>x.binding_id),["finance-source-map","real-estate-contract"]);
  const sales=resolveProjectResources({bindingSet,projectRef:"project:sales",department:"sales",purpose:"commercial",resolvedAt:t1});
  assert.deepEqual(sales.resources.map(x=>x.binding_id),["real-estate-contract"]);
  assert.equal(JSON.stringify(sales).includes("finance-source-map"),false);
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
    declaration,taskRef:{kind:"Task",id:"task:acq",revision:1},projectRef:"project:acq",
    baseVersion:"0.5.1",baseSelector:"v0.5.1",deltaVersion:"0.5.0",deltaSelector:"v0.5.0",
    providers:[{plugin:"woia-re-property-data",version:"0.5.0",selector:"v0.5.0"}],
    organizationRevision:2,departmentRevision:3,createdAt:t0
  };
  const a=createOrchestratorCompositionSnapshot(args), b=createOrchestratorCompositionSnapshot(args);
  assert.equal(a.composed_digest,b.composed_digest);
  assert.equal(a.active_root.plugin,"woia-re-property-acquisition");
  assert.equal(a.generic_base.plugin,"woia-supply-acquisition");
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,baseVersion:"0.6.0"}),/outside compatible range/);
  assert.throws(()=>createOrchestratorCompositionSnapshot({...args,providers:[]}),/provider closure/);
});
