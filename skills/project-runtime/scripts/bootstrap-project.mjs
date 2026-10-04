import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const THIS=fileURLToPath(import.meta.url);
const TEMPLATE=path.resolve(path.dirname(THIS),"../../../assets/templates/AGENTS.woia-block.md.template");
const CORE_VERSION=JSON.parse(await readFile(path.resolve(path.dirname(THIS),"../../../plugin.json"),"utf8")).version;
const COMPATIBLE_CORE=/^0\.5\.(0|[1-9][0-9]*)$/;
const BEGIN="<!-- WOIA_PROJECT_OPERATING_CONTRACT:BEGIN -->";
const END="<!-- WOIA_PROJECT_OPERATING_CONTRACT:END -->";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function fail(message){throw new Error(message)}
function parse(argv){const values=new Map();for(let i=0;i<argv.length;i++){const t=argv[i];if(!t.startsWith("--"))fail("unexpected argument: "+t);const v=argv[++i];if(v===undefined)fail("missing value for "+t);values.set(t,v)}for(const k of ["--root","--project-id","--department","--orchestrator"])if(!values.get(k))fail(k+" is required");return{root:path.resolve(values.get("--root")),projectId:values.get("--project-id"),department:values.get("--department"),orchestrator:values.get("--orchestrator"),organizationRef:values.get("--organization-ref")??null}}
function assertId(value,label){if(!ID.test(value))fail(label+" is invalid: "+value)}
async function readMaybe(file){try{return await readFile(file,"utf8")}catch(e){if(e.code==="ENOENT")return null;throw e}}
async function atomicWrite(file,content){await mkdir(path.dirname(file),{recursive:true});const temp=file+".tmp-"+process.pid+"-"+Date.now();await writeFile(temp,content,"utf8");await rename(temp,file)}
function mergeManagedBlock(existing,block){const beginCount=existing.split(BEGIN).length-1,endCount=existing.split(END).length-1;if(beginCount>1||endCount>1)fail("AGENTS.md has duplicate WOIA managed blocks; preserve content and reconcile explicitly");const hasBegin=beginCount===1,hasEnd=endCount===1;if(hasBegin!==hasEnd)fail("AGENTS.md has an incomplete WOIA managed block");if(hasBegin){const start=existing.indexOf(BEGIN),end=existing.indexOf(END,start);if(end<start)fail("AGENTS.md WOIA managed block markers are out of order");return existing.slice(0,start)+block.trimEnd()+existing.slice(end+END.length)}if(!existing.trim())return block;return existing.replace(/\s*$/u,"")+"\n\n"+block}
function initialState({projectId,department,orchestrator,organizationRef,now}){return{schema:"dev.woia.core-project-state/v1",core_version:CORE_VERSION,project:{id:projectId,department,orchestrator,organization_ref:organizationRef},root_agent_binding:{status:"bound",instructions_file:"AGENTS.md",managed_block_id:"WOIA_PROJECT_OPERATING_CONTRACT",last_reconciled_at:now},provider_resolution:{installation_policy:"ask_once",installation_authorization:"pending",status:"pending",providers:[],install_plan:[],install_plan_id:null,authorized_plan_id:null},custom_agents:{status:"not_materialized",materialized_generation:0,loaded_generation:null,roles:[]},orchestration:{status:"initializing",runtime_restart_required:false,current_task_id:null,current_run_id:null},storage:{tasks:".woia/tasks",receipts:".woia/receipts",overlays:".woia/overlays",snapshots:".woia/snapshots",effects:".woia/effects",checkpoints:".woia/checkpoints"},updated_at:now}}
export async function bootstrapProject(args){
  assertId(args.projectId,"project id");assertId(args.department,"department");assertId(args.orchestrator,"orchestrator");
  const root=path.resolve(args.root),woia=path.join(root,".woia");
  const block=await readFile(TEMPLATE,"utf8"),agentsPath=path.join(root,"AGENTS.md"),currentAgents=await readMaybe(agentsPath)??"",merged=mergeManagedBlock(currentAgents,block);
  const projectPath=path.join(woia,"project.json"),now=new Date().toISOString(),existingRaw=await readMaybe(projectPath);
  let state,result;
  if(existingRaw===null){state=initialState({...args,now});result="CREATED"}
  else{
    state=JSON.parse(existingRaw);
    if(state.schema!=="dev.woia.core-project-state/v1"||!COMPATIBLE_CORE.test(state.core_version))fail("existing .woia/project.json is not compatible with WOIA Core 0.5.x");
    for(const [key,value] of Object.entries({id:args.projectId,department:args.department,orchestrator:args.orchestrator}))if(state.project?.[key]!==value)fail("existing Project identity conflict for "+key);
    if(args.organizationRef!==null&&state.project.organization_ref!==null&&state.project.organization_ref!==args.organizationRef)fail("existing organization_ref conflicts with requested organization_ref");
    if(state.project.organization_ref===null&&args.organizationRef!==null)state.project.organization_ref=args.organizationRef;
    if(state.core_version!==CORE_VERSION){
      state.custom_agents.materialized_generation++;
      state.custom_agents.status="materialized_pending_reload";
      state.orchestration.runtime_restart_required=true;
      state.orchestration.status="runtime_restart_required";
    }
    state.core_version=CORE_VERSION;
    state.root_agent_binding={status:"bound",instructions_file:"AGENTS.md",managed_block_id:"WOIA_PROJECT_OPERATING_CONTRACT",last_reconciled_at:now};
    state.updated_at=now;result="RECONCILED";
  }
  for(const dir of ["tasks","task-cells","agents","bindings","receipts","effects","checkpoints","improvements","overlays","snapshots"])await mkdir(path.join(woia,dir),{recursive:true});
  if(merged!==currentAgents)await atomicWrite(agentsPath,merged.endsWith("\n")?merged:merged+"\n");
  await atomicWrite(projectPath,JSON.stringify(state,null,2)+"\n");
  return{result,root,project_file:projectPath,agents_file:agentsPath,state};
}
const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(THIS);if(isMain){try{console.log(JSON.stringify(await bootstrapProject(parse(process.argv.slice(2))),null,2))}catch(e){console.error("woia:bootstrap-project: FAIL: "+e.message);process.exitCode=1}}
