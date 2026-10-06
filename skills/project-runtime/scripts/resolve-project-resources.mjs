import {createHash} from "node:crypto";
import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import path from "node:path";
function fail(message){throw new Error(message);}
function canonical(value){if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";return JSON.stringify(value);}
async function atomicWrite(file,content){await mkdir(path.dirname(file),{recursive:true});const temp=file+".tmp-"+process.pid+"-"+Date.now();await writeFile(temp,content,"utf8");await rename(temp,file);}
function active(binding,at){const t=Date.parse(at);if(binding.effective_from&&Date.parse(binding.effective_from)>t)return false;if(binding.effective_until&&Date.parse(binding.effective_until)<=t)return false;return true;}
export function resolveProjectResources({bindingSet,projectRef,department,purpose,resolvedAt}){
  if(bindingSet?.schema!=="dev.woia.organization-resource-binding-set/v1")fail("unsupported organization resource binding schema");
  if(!projectRef||!department||!purpose)fail("projectRef, department and purpose are required");
  if(!Number.isFinite(Date.parse(resolvedAt)))fail("resolvedAt must be ISO date-time");
  const resources=[];
  for(const binding of bindingSet.bindings??[]){
    if(!active(binding,resolvedAt))continue;
    const entries=(binding.access??[]).filter(a=>a.department===department&&a.purposes.includes(purpose));
    if(!entries.length)continue;
    const operations=[...new Set(entries.flatMap(a=>a.operations))].sort();
    const minimumFields=[...new Set(entries.flatMap(a=>a.minimum_fields))].sort();
    resources.push({
      binding_id:binding.id,resource_type:binding.resource_type,capability_plugin:binding.capability_plugin,
      system_of_record:binding.system_of_record,classification:binding.classification,contract:structuredClone(binding.contract),
      binding_ref:binding.binding_ref,source_authority_map_ref:binding.source_authority_map_ref??null,
      operations,minimum_fields:minimumFields
    });
  }
  resources.sort((a,b)=>a.binding_id.localeCompare(b.binding_id));
  const identity={project_ref:projectRef,organization_ref:bindingSet.organization_ref,organization_binding_id:bindingSet.id,organization_revision:bindingSet.revision,department,purpose,resources};
  const digest="sha256:"+createHash("sha256").update(canonical(identity)).digest("hex");
  return {schema:"dev.woia.project-resource-resolution/v1",id:"resource-resolution:"+digest.slice(7,19),...identity,composed_digest:digest,resolved_at:resolvedAt};
}
export async function resolveProjectResourcesFromFile({bindingSetFile,projectRef,department,purpose,resolvedAt,output}){
  const bindingSet=JSON.parse(await readFile(bindingSetFile,"utf8"));const doc=resolveProjectResources({bindingSet,projectRef,department,purpose,resolvedAt});
  if(output)await atomicWrite(path.resolve(output),JSON.stringify(doc,null,2)+"\n");return doc;
}
