import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {instant as parseInstant, requireObject, requireResourceRef, requireStrings, requireText} from "./b4-contract.mjs";
import {persistImmutableSnapshot} from "./immutable-snapshot.mjs";
function fail(message){throw new Error(message);}
function canonical(value){if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";return JSON.stringify(value);}
function instant(value,label){return value===null||value===undefined?null:parseInstant(value,label);}
function validateBinding(binding){
  requireObject(binding,["id","resource_type","capability_plugin","system_of_record","classification","contract","binding_ref","source_authority_map_ref","effective_from","effective_until","access"],"organization binding");
  for(const field of ["id","resource_type","capability_plugin","system_of_record","binding_ref"])requireText(binding[field],"binding."+field);
  if(!["public","internal","confidential","restricted"].includes(binding.classification))fail("invalid binding classification");
  requireObject(binding.contract,["id","version","digest"],"binding contract");
  requireText(binding.contract.id,"contract.id");requireText(binding.contract.version,"contract.version");
  if(binding.contract.digest!=null&&!/^sha256:[0-9a-f]{64}$/.test(binding.contract.digest))fail("invalid contract digest");
  if(binding.source_authority_map_ref!=null)requireResourceRef(binding.source_authority_map_ref,"source authority map ref");
  if(!Array.isArray(binding.access)||!binding.access.length)fail("binding access must be a non-empty array");
  for(const access of binding.access){
    requireObject(access,["department","purposes","operations","minimum_fields"],"binding access");
    requireText(access.department,"access.department");
    requireStrings(access.purposes,"access.purposes",{nonEmpty:true});
    requireStrings(access.operations,"access.operations",{nonEmpty:true});
    requireStrings(access.minimum_fields,"access.minimum_fields");
  }
}
function active(binding,at){const t=instant(at,"resolvedAt");const from=instant(binding.effective_from,`${binding.id}.effective_from`);const until=instant(binding.effective_until,`${binding.id}.effective_until`);if(from!==null&&until!==null&&from>=until)fail(`${binding.id}: effective interval must be non-empty`);if(from!==null&&from>t)return false;if(until!==null&&until<=t)return false;return true;}
export function resolveProjectResources({bindingSet,organizationRef,projectRef,department,purpose,resolvedAt}){
  if(bindingSet?.schema!=="dev.woia.organization-resource-binding-set/v1")fail("unsupported organization resource binding schema");
  requireObject(bindingSet,["schema","id","revision","organization_ref","bindings","updated_at"],"binding set");
  requireText(bindingSet.id,"binding set id");
  if(!Number.isInteger(bindingSet.revision)||bindingSet.revision<1)fail("binding set revision must be positive");
  if(!Array.isArray(bindingSet.bindings))fail("bindings must be an array");
  parseInstant(bindingSet.updated_at,"binding set updated_at");
  if(!organizationRef||!projectRef||!department||!purpose)fail("organizationRef, projectRef, department and purpose are required");
  if(bindingSet.organization_ref!==organizationRef)fail("organization resource binding does not match requested organization");
  parseInstant(resolvedAt,"resolvedAt");
  const resources=[];const seenBindingIds=new Set();
  for(const binding of bindingSet.bindings??[]){
    validateBinding(binding);
    if(!binding?.id)fail("organization resource binding id is required");
    if(seenBindingIds.has(binding.id))fail(`duplicate organization resource binding id: ${binding.id}`);
    seenBindingIds.add(binding.id);
    if(!active(binding,resolvedAt))continue;
    const entries=(binding.access??[]).filter(a=>a.department===department&&a.purposes.includes(purpose));
    if(!entries.length)continue;
    const operations=[...new Set(entries.flatMap(a=>a.operations))].sort();
    const minimumFields=[...new Set(entries.flatMap(a=>a.minimum_fields))].sort();
    resources.push({
      binding_id:binding.id,resource_type:binding.resource_type,capability_plugin:binding.capability_plugin,
      system_of_record:binding.system_of_record,classification:binding.classification,contract:structuredClone(binding.contract),
      binding_ref:binding.binding_ref,source_authority_map_ref:binding.source_authority_map_ref?structuredClone(binding.source_authority_map_ref):null,
      operations,minimum_fields:minimumFields
    });
  }
  resources.sort((a,b)=>a.binding_id.localeCompare(b.binding_id));
  const identity={project_ref:projectRef,organization_ref:bindingSet.organization_ref,organization_binding_id:bindingSet.id,organization_revision:bindingSet.revision,department,purpose,resources};
  const digest="sha256:"+createHash("sha256").update(canonical(identity)).digest("hex");
  return {schema:"dev.woia.project-resource-resolution/v1",id:"resource-resolution:"+digest.slice(7,19),...identity,composed_digest:digest,resolved_at:resolvedAt};
}
export async function resolveProjectResourcesFromFile({bindingSetFile,organizationRef,projectRef,department,purpose,resolvedAt,output}){
  const bindingSet=JSON.parse(await readFile(bindingSetFile,"utf8"));const doc=resolveProjectResources({bindingSet,organizationRef,projectRef,department,purpose,resolvedAt});
  if(output)return (await persistImmutableSnapshot(path.resolve(output),doc,"resolved_at")).snapshot;return doc;
}
