import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

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
