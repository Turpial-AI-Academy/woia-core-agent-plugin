import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {instant, requireStrings, requireTaskRef, requireSelector} from "../../project-runtime/scripts/b4-contract.mjs";
import {persistImmutableSnapshot} from "../../project-runtime/scripts/immutable-snapshot.mjs";
const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function fail(message){throw new Error(message);}
function parse(v){if(!SEMVER.test(v))fail("invalid stable SemVer: "+v);return v.split(".").map(Number);}
function cmp(a,b){const x=parse(a),y=parse(b);for(let i=0;i<3;i++){if(x[i]<y[i])return-1;if(x[i]>y[i])return 1;}return 0;}
function inRange(v,r){return cmp(v,r.min_inclusive)>=0&&cmp(v,r.max_exclusive)<0;}
function canonical(value){if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";return JSON.stringify(value);}
function normalizeProviders(items){if(!Array.isArray(items))fail("provider closure must be an array");const out=items.map(x=>({plugin:x?.plugin,version:x?.version,selector:x?.selector}));const seen=new Set();for(const p of out){if(!p.plugin)fail("provider plugin is required");parse(p.version);if(p.selector!==undefined)requireSelector(p.selector,p.version);const k=p.plugin+"@"+p.version;if(seen.has(k))fail("duplicate provider closure entry: "+k);seen.add(k);}return out.sort((a,b)=>a.plugin.localeCompare(b.plugin)||a.version.localeCompare(b.version));}
export function createOrchestratorCompositionSnapshot({declaration,taskRef,projectRef,department,baseVersion,baseSelector,deltaVersion,deltaSelector,coreVersion=null,coreSelector=null,providers=[],organizationRevision=null,departmentRevision=null,createdAt}){
  if(declaration?.schema!=="dev.woia.orchestrator-specialization/v1")fail("unsupported specialization declaration");
  if(declaration.status!=="qualified")fail("composition declaration is not qualified");
  if(!declaration.generic_base?.plugin||!declaration.delta?.plugin||declaration.generic_base.plugin===declaration.delta.plugin)fail("composition base/delta identity is invalid");
  if(!department||declaration.department!==department)fail("composition declaration does not match requested department");
  for(const field of ["allowed_operations","exported_slots","required_gates"])requireStrings(declaration[field],field,{nonEmpty:true,unique:true});
  const allowed=[...declaration.allowed_operations];const slots=[...declaration.exported_slots];const gates=[...declaration.required_gates];
  if(!allowed.length||allowed.some(x=>!["ADD","SPECIALIZE","NARROW"].includes(x))||new Set(allowed).size!==allowed.length)fail("composition allowed operations are invalid");
  if(!slots.length||new Set(slots).size!==slots.length)fail("composition exported slots are required and unique");
  if(!gates.length||new Set(gates).size!==gates.length)fail("composition required gates are required and unique");
  if(!inRange(baseVersion,declaration.generic_base.version_range))fail("base version outside compatible range");
  parse(deltaVersion);
  requireSelector(baseSelector,baseVersion);requireSelector(deltaSelector,deltaVersion);
  for(const provider of providers)requireSelector(provider?.selector,provider?.version);
  const normalized=normalizeProviders(providers);
  const pair=(declaration.evaluated_pairs??[]).find(p=>p.base_version===baseVersion&&p.delta_version===deltaVersion&&p.status==="passed");
  if(!pair)fail("exact base/delta pair has no passed evaluation");
  if(coreVersion!==null||coreSelector!==null){parse(coreVersion);requireSelector(coreSelector,coreVersion);if(pair.core_version!==coreVersion)fail("exact Core version has no matching passed composition evaluation");if(pair.core_selector!==undefined&&pair.core_selector!==coreSelector)fail("exact Core selector does not match composition evaluation");}
  else if(pair.core_version!==undefined)fail("evaluated composition requires an exact Core pin");
  if(!Array.isArray(pair.evidence)||!pair.evidence.length)fail("passed exact pair requires evaluation evidence");
  requireStrings(pair.evidence,"evaluation evidence",{nonEmpty:true});
  const expected=normalizeProviders(pair.provider_closure??[]).map(x=>x.plugin+"@"+x.version).sort();
  const actual=normalized.map(x=>x.plugin+"@"+x.version).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))fail("provider closure does not match evaluated pair");
  if(!taskRef?.kind||!taskRef?.id||!projectRef||!baseSelector||!deltaSelector)fail("missing snapshot identity");
  requireTaskRef(taskRef,"taskRef");instant(createdAt,"createdAt");
  for(const [label,value] of [["organizationRevision",organizationRevision],["departmentRevision",departmentRevision]])if(value!=null&&(!Number.isInteger(value)||value<1))fail(label+" must be a positive integer");
  const declarationDigest="sha256:"+createHash("sha256").update(canonical(declaration)).digest("hex");
  const identity={
    task_ref:structuredClone(taskRef),project_ref:projectRef,department,composition_id:declaration.id,declaration_digest:declarationDigest,
    allowed_operations:[...allowed].sort(),exported_slots:[...slots].sort(),required_gates:[...gates].sort(),
    active_root:{plugin:declaration.delta.plugin,version:deltaVersion,selector:deltaSelector},
    generic_base:{plugin:declaration.generic_base.plugin,version:baseVersion,selector:baseSelector},
    delta:{plugin:declaration.delta.plugin,version:deltaVersion,selector:deltaSelector},
    provider_closure:normalized,evaluation_evidence:[...pair.evidence].sort(),
    organization_profile_revision:organizationRevision??null,department_profile_revision:departmentRevision??null
  };
  if(coreVersion!==null)identity.core={plugin:"woia-core",version:coreVersion,selector:coreSelector};
  const digest="sha256:"+createHash("sha256").update(canonical(identity)).digest("hex");
  return {schema:"dev.woia.orchestrator-composition-snapshot/v1",id:"orchestrator-snapshot:"+taskRef.id+":"+digest.slice(7,19),...identity,composed_digest:digest,created_at:createdAt};
}
export async function createOrchestratorCompositionSnapshotFromFile({declarationFile,output,...args}){
  const declaration=JSON.parse(await readFile(declarationFile,"utf8"));const doc=createOrchestratorCompositionSnapshot({declaration,...args});
  const persisted=await persistImmutableSnapshot(path.resolve(output),doc,"created_at");
  return {result:persisted.created?"CREATED":"UNCHANGED",snapshot:persisted.snapshot};
}
