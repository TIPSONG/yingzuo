const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const C=require('../compatibility.js');
const catalog=require('../compatibility-catalog.js');
const model=catalog.models.find(m=>m.role==='diffusion');
const encoder=catalog.models.find(m=>m.role==='encoder');
const language=catalog.models.find(m=>m.role==='language');
const doc=(type,widgets_values)=>({version:0.4,nodes:[{id:1,type,widgets_values}],links:[]});
const issue=d=>C.analyse(d,catalog).issues[0];
test('missing image quantization can be replaced without changing other fields',()=>{
 const source=doc('UnetLoaderGGUF',['qwen-image-2.1-Q8_0.gguf']);source.extra={keep:'yes'};
 const before=JSON.stringify(source),found=issue(source);
 assert.equal(found.candidates[0].value,model.value);
 const plan=C.plan(source,catalog,found.key,model.id);
 const fixed=C.patch(source,plan.path,plan.before,plan.after);
 assert.equal(JSON.stringify(source),before);
 assert.equal(fixed.extra.keep,'yes');assert.deepEqual(fixed.links,source.links);
 assert.equal(C.analyse(fixed,catalog).errors,0);
 assert.deepEqual(C.patch(fixed,plan.path,plan.after,plan.before),source);
});
test('Qwen encoder precision candidate requires qwen_image type',()=>{
 assert.equal(issue(doc('CLIPLoader',['qwen3vl_8b_bf16.safetensors','qwen_image','default'])).candidates[0].value,encoder.value);
 const invalid=issue(doc('CLIPLoader',['qwen3vl_8b_bf16.safetensors','stable_diffusion','default']));
 assert.equal(invalid.code,'encoder-type');assert.equal(invalid.candidates.length,0);
});
test('special encoder quantization is not assumed compatible with a GGUF loader',()=>{
 assert.equal(issue(doc('CLIPLoaderGGUF',[encoder.value,'qwen_image'])).code,'quantized-encoder-loader');
 assert.equal(issue(doc('CLIPLoaderGGUF',['qwen3vl_8b_bf16.safetensors','qwen_image'])).candidates[0].canApply,false);
});
test('GGUF language models are not interchangeable with diffusion models',()=>{
 for(const name of [language.filename,'llama-3.2-3b-Q4_K_M.gguf']){
  const found=issue(doc('UnetLoaderGGUF',[name]));assert.equal(found.code,'wrong-role');assert.equal(found.candidates.length,0);
 }
});
test('format migration is a manual suggestion, never a filename-only repair',()=>{
 const found=issue(doc('UNETLoader',['qwen-image-2.1-fp16.safetensors','default']));
 assert.equal(found.candidates[0].canApply,false);
 assert.throws(()=>C.plan(doc('UNETLoader',['qwen-image-2.1-fp16.safetensors','default']),catalog,found.key,model.id));
 assert.equal(issue(doc('UNETLoader',[model.value,'default'])).code,'loader-format');
});
test('LM Studio LLaMA can suggest the configured Gemma identifier, not its GGUF filename',()=>{
 const source=doc('LMStudioPromptEnhancer',['Image generation prompt','Keep intent','minimal enhancement','http://127.0.0.1:1234/v1','','llama-3.2-3b-imagegen',0.3,700,true,0]);
 assert.equal(issue(source).candidates[0].value,language.value);
 source.nodes[0].widgets_values[3]='https://example.com/v1';
 assert.equal(issue(source).code,'remote-service');assert.equal(issue(source).candidates.length,0);
});
test('unknown LLaMA plugins receive migration guidance but cannot be patched',()=>{
 const found=issue(doc('UnknownLlamaLoader',['any.gguf']));assert.equal(found.code,'unknown-node');
 assert.ok(found.candidates.length);assert.ok(found.candidates.every(c=>!c.canApply));
});
test('API format uses named inputs and preserves unrelated prompts',()=>{
 const source={prompt:{one:{class_type:'UnetLoaderGGUF',inputs:{unet_name:'qwen-image-2.1-Q8_0.gguf'}},two:{class_type:'CLIPTextEncode',inputs:{text:'llama.gguf is ordinary prompt text'}}},extra:{client:'keep'}};
 const report=C.analyse(source,catalog);assert.equal(report.issues.length,1);
 const plan=C.plan(source,catalog,report.issues[0].key,model.id),fixed=C.patch(source,plan.path,plan.before,plan.after);
 assert.equal(fixed.prompt.two.inputs.text,source.prompt.two.inputs.text);assert.equal(fixed.extra.client,'keep');
});
test('linked model values are not overwritten with stale widget values',()=>{
 const source=doc('UnetLoaderGGUF',['qwen-image-2.1-Q8_0.gguf']);source.nodes[0].inputs=[{name:'unet_name',link:42,widget:{name:'unet_name'}}];
 assert.equal(issue(source).code,'dynamic');assert.equal(issue(source).candidates.length,0);
 const api={'1':{class_type:'UnetLoaderGGUF',inputs:{unet_name:['2',0]}}};assert.equal(issue(api).code,'dynamic');
});
function promoted(){return {nodes:[{id:9,type:'sub',inputs:[{name:'unet_name',widget:{name:'unet_name'},link:null}],widgets_values:['qwen-image-2.1-Q8_0.gguf']}],links:[],definitions:{subgraphs:[{id:'sub',name:'Image model',inputNode:{id:-10},inputs:[{name:'unet_name',linkIds:[5]}],nodes:[{id:1,type:'UnetLoaderGGUF',inputs:[{name:'unet_name',widget:{name:'unet_name'},link:5}],widgets_values:[model.value]}],links:[{id:5,origin_id:-10,origin_slot:0,target_id:1,target_slot:0}]}]}};}
test('promoted model fields resolve to the instance value and patch only that instance',()=>{
 const source=promoted();source.nodes.push({...structuredClone(source.nodes[0]),id:10});
 const report=C.analyse(source,catalog);assert.equal(report.errors,2);assert.notEqual(report.issues[0].key,report.issues[1].key);
 const plan=C.plan(source,catalog,report.issues[1].key,model.id);
 assert.deepEqual(plan.path,['nodes',1,'widgets_values',0]);
 const fixed=C.patch(source,plan.path,plan.before,plan.after);
 assert.equal(fixed.nodes[0].widgets_values[0],'qwen-image-2.1-Q8_0.gguf');assert.equal(fixed.nodes[1].widgets_values[0],model.value);
 assert.deepEqual(fixed.definitions,source.definitions);assert.equal(C.analyse(fixed,catalog).errors,1);
});
test('ambiguous promoted widget ordering stays unresolved',()=>{
 const source=promoted();source.nodes[0].widgets_values.push('extra-control');
 assert.equal(issue(source).code,'dynamic');
});
test('LoRA and unrelated model families do not get irrelevant alternatives',()=>{
 for(const source of [doc('LoraLoader',['character.safetensors',1,1]),doc('UnetLoaderGGUF',['flux1-Q4_K_M.gguf'])])assert.equal(issue(source).candidates.length,0);
});
test('stale repairs and prototype paths are rejected',()=>{
 assert.throws(()=>C.patch({a:2},['a'],1,3));
 assert.throws(()=>C.patch(JSON.parse('{"__proto__":{"x":1}}'),['__proto__','x'],1,2));
 assert.equal({}.x,undefined);
});
test('existing local workflows have their actual model values checked, including promoted subgraphs',{skip:!process.env.COMFYUI_WORKFLOWS_DIR},()=>{
 const root=process.env.COMFYUI_WORKFLOWS_DIR;
 assert.ok(fs.existsSync(root),'COMFYUI_WORKFLOWS_DIR must point to an existing directory');
 for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.json'))){
  const source=JSON.parse(fs.readFileSync(`${root}/${name}`,'utf8').replace(/^\uFEFF/,''));
  const report=C.analyse(source,catalog);assert.equal(report.issues.length,0,name);assert.ok(report.checkedModels>0,name);
 }
});
