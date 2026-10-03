import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { bootstrapProject } from "../skills/project-runtime/scripts/bootstrap-project.mjs";
import { updateOverlayCompatibility } from "../skills/project-improvement/scripts/set-overlay-compatibility.mjs";
import { createCapabilitySnapshot } from "../skills/project-improvement/scripts/create-capability-snapshot.mjs";

const ROOT=path.resolve(".");
const SCHEMA_DIR=path.join(ROOT,"dev.woia","schemas");
const PROFILE_DIR=path.join(ROOT,"dev.woia","workflow-profiles");

async function loadSchemas(){
  const files=(await readdir(SCHEMA_DIR)).filter((name)=>name.endsWith(".schema.json"));
  const schemas=[];
  for(const file of files) schemas.push(JSON.parse(await readFile(path.join(SCHEMA_DIR,file),"utf8")));
  return schemas;
}

test("core schemas compile as one closed contract graph", async()=>{
  const ajv=new Ajv2020({strict:false,allErrors:true,formats:{"date-time":true}});
  const schemas=await loadSchemas();
  for(const schema of schemas) ajv.addSchema(schema);
  for(const schema of schemas) assert.ok(ajv.getSchema(schema.$id),schema.$id);
});

test("five proportional non-software OPEA-H profiles validate", async()=>{
  const ajv=new Ajv2020({strict:false,allErrors:true,formats:{"date-time":true}});
  for(const schema of await loadSchemas()) ajv.addSchema(schema);
  const validate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/workflow-profile.schema.json");
  const files=(await readdir(PROFILE_DIR)).filter((name)=>name.endsWith(".json")).sort();
  assert.deepEqual(files,[
    "audited-execution.json","direct-service.json","opea-h-full.json","planned-execution.json","task-execution.json"
  ]);
  for(const file of files){
    const profile=JSON.parse(await readFile(path.join(PROFILE_DIR,file),"utf8"));
    assert.equal(validate(profile),true,JSON.stringify(validate.errors));
    assert.equal(profile.applies_to,"non-software");
  }
});

test("Project and overlay examples validate and overlays contain no source patch path", async()=>{
  const ajv=new Ajv2020({strict:false,allErrors:true,formats:{"date-time":true}});
  for(const schema of await loadSchemas()) ajv.addSchema(schema);
  const project=JSON.parse(await readFile(path.join(ROOT,"assets","examples","project-state.json"),"utf8"));
  const overlay=JSON.parse(await readFile(path.join(ROOT,"assets","examples","project-overlay.json"),"utf8"));
  const projectValidate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/project-state.schema.json");
  const overlayValidate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/overlay.schema.json");
  assert.equal(projectValidate(project),true,JSON.stringify(projectValidate.errors));
  assert.equal(overlayValidate(overlay),true,JSON.stringify(overlayValidate.errors));
  assert.equal("patch_path" in overlay,false);
  assert.equal("source_file" in overlay,false);
});


test("bootstrap preserves unrelated instructions and is idempotent", async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-bootstrap-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,"AGENTS.md"),"# Existing\n\nKeep this line.\n");
  const args={root,projectId:"project-1",department:"marketing",orchestrator:"woia-marketing",organizationRef:"org:example"};
  assert.equal((await bootstrapProject(args)).result,"CREATED");
  assert.equal((await bootstrapProject(args)).result,"RECONCILED");
  const agents=await readFile(path.join(root,"AGENTS.md"),"utf8");
  assert.ok(agents.includes("Keep this line."));
  assert.equal((agents.match(/WOIA_PROJECT_OPERATING_CONTRACT:BEGIN/g)??[]).length,1);
  const state=JSON.parse(await readFile(path.join(root,".woia","project.json"),"utf8"));
  assert.equal(state.project.department,"marketing");
  for(const dir of ["tasks","task-cells","agents","bindings","receipts","effects","checkpoints","improvements","overlays","snapshots"]) await readdir(path.join(root,".woia",dir));
  await assert.rejects(()=>bootstrapProject({...args,department:"sales"}),/identity conflict/);
});

test("overlay compatibility updates preserve customization", async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-overlay-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,"overlay.json");
  const doc={schema:"dev.woia.plugin-overlay/v1",id:"brand-overlay",revision:1,plugin:"woia-marketing-content-copy",scope:"project",directives:{instructions:["Keep phrase"],preferences:{tone:"friendly"}},resources:[],compatibility:{last_validated_base:"0.5.0",status:"compatible",conflicts:[]},source_improvement_refs:[]};
  await writeFile(file,JSON.stringify(doc,null,2)+"\n");
  const preserved=JSON.stringify({directives:doc.directives,resources:doc.resources,source_improvement_refs:doc.source_improvement_refs});
  await updateOverlayCompatibility({file,baseVersion:"0.5.1",status:"compatible",conflicts:[]});
  const after=JSON.parse(await readFile(file,"utf8"));
  assert.equal(after.revision,2);
  assert.equal(JSON.stringify({directives:after.directives,resources:after.resources,source_improvement_refs:after.source_improvement_refs}),preserved);
  await updateOverlayCompatibility({file,baseVersion:"0.6.0",status:"conflict",conflicts:["semantic conflict"]});
  const conflict=JSON.parse(await readFile(file,"utf8"));
  assert.equal(conflict.compatibility.status,"conflict");
  assert.equal(JSON.stringify({directives:conflict.directives,resources:conflict.resources,source_improvement_refs:conflict.source_improvement_refs}),preserved);
});

test("capability snapshot digest is stable and incompatible overlays fail closed", async(t)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"woia-snapshot-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const orgFile=path.join(root,"org.json"),projectFile=path.join(root,"project.json");
  const overlay=(id,scope,revision)=>({schema:"dev.woia.plugin-overlay/v1",id,revision,plugin:"woia-marketing-content-copy",scope,directives:{instructions:[id],preferences:{}},resources:[],compatibility:{last_validated_base:"0.5.0",status:"compatible",conflicts:[]},source_improvement_refs:[]});
  await writeFile(orgFile,JSON.stringify(overlay("org-overlay","organization",2)));
  await writeFile(projectFile,JSON.stringify(overlay("project-overlay","project",4)));
  const common={taskId:"task-1",capability:"marketing.content-copy",plugin:"woia-marketing-content-copy",version:"0.5.0",selector:"v0.5.0",overlays:[projectFile,orgFile],organizationRevision:3,departmentRevision:7};
  const a=await createCapabilitySnapshot({...common,output:path.join(root,"a.json")});
  const b=await createCapabilitySnapshot({...common,output:path.join(root,"b.json")});
  assert.equal(a.snapshot.composed_digest,b.snapshot.composed_digest);
  assert.deepEqual(a.composition.overlays.map(x=>x.id),["org-overlay","project-overlay"]);
  const ajv=new Ajv2020({strict:false,allErrors:true,formats:{"date-time":true}});for(const schema of await loadSchemas())ajv.addSchema(schema);
  const validate=ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/effective-capability-snapshot.schema.json");
  assert.equal(validate(a.snapshot),true,JSON.stringify(validate.errors));
  const bad=overlay("project-overlay","project",5);bad.compatibility.status="unverified";await writeFile(projectFile,JSON.stringify(bad));
  await assert.rejects(()=>createCapabilitySnapshot({...common,output:path.join(root,"c.json")}),/not compatible/);
});
