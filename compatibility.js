// Conservative offline checks. Unknown contracts are reported, never guessed.
const WorkflowCompatibility = (() => {
 const clone = value => JSON.parse(JSON.stringify(value));
 const object = value => value && typeof value === 'object' && !Array.isArray(value);
 const own = (value,key) => object(value) || Array.isArray(value) ? Object.hasOwn(value,key) : false;
 const normalize = value => String(value).replace(/\\/g,'/').replace(/^\.\//,'').toLowerCase();
 const basename = value => normalize(value).split('/').pop();
 const extension = value => basename(value).split('.').pop();
 const modelField = (name,slot,role) => ({name,slot,role});
 const schemas = {
  UnetLoaderGGUF:[modelField('unet_name',0,'diffusion')],
  UnetLoaderGGUFAdvanced:[modelField('unet_name',0,'diffusion')],
  UNETLoader:[modelField('unet_name',0,'diffusion')],
  CLIPLoader:[modelField('clip_name',0,'encoder')],
  CLIPLoaderGGUF:[modelField('clip_name',0,'encoder')],
  DualCLIPLoader:[modelField('clip_name1',0,'encoder'),modelField('clip_name2',1,'encoder')],
  DualCLIPLoaderGGUF:[modelField('clip_name1',0,'encoder'),modelField('clip_name2',1,'encoder')],
  TripleCLIPLoader:[modelField('clip_name1',0,'encoder'),modelField('clip_name2',1,'encoder'),modelField('clip_name3',2,'encoder')],
  VAELoader:[modelField('vae_name',0,'vae')],
  CheckpointLoaderSimple:[modelField('ckpt_name',0,'checkpoint')],
  LoraLoader:[modelField('lora_name',0,'lora')],
  LoraLoaderModelOnly:[modelField('lora_name',0,'lora')],
  LMStudioPromptEnhancer:[modelField('model',5,'language')]
 };
 function family(value) {
  const name=basename(value);
  if (name==='qwen_image_2.1_vae_bf16.safetensors') return 'qwen-image-2.1-vae';
  if (!name.includes('vae')&&/^qwen[-_]image[-_]2[._]1[-_].+\.(gguf|safetensors)$/.test(name)) return 'qwen-image-2.1';
  if (/^qwen3vl_8b_(bf16|fp16|fp8_scaled|int8_convrot)\.safetensors$/.test(name)) return 'qwen3vl-8b';
  return null;
 }
 function apparentRole(value) {
  if (/(^|[/_-])(llama|gemma)[-_0-9]/i.test(value) || /^(llama|gemma)/i.test(value)) return 'language';
  if (family(value)==='qwen3vl-8b') return 'encoder';
  if (family(value)==='qwen-image-2.1-vae') return 'vae';
  if (family(value)==='qwen-image-2.1') return 'diffusion';
  return null;
 }
 function collect(document) {
  const result=[],seen=new WeakSet(),subgraphIds=new Set();let truncated=false;
  function graph(value,path,scope,ownerId,depth=0,instances=[]) {
   if(!object(value)||seen.has(value))return;seen.add(value);
   if(depth>20||result.length>=20000){truncated=true;return;}
   if(Array.isArray(value.nodes)) {
    const definitions=Array.isArray(value.definitions?.subgraphs)?value.definitions.subgraphs:[];
    const ids=new Set(definitions.map(s=>s?.id));
    ids.forEach(id=>subgraphIds.add(id));
    value.nodes.forEach((node,index)=>{
     if(!object(node)||typeof node.type!=='string')return;
     result.push({node,path:[...path,'nodes',index],scope,ownerId:ownerId??String(node.id),id:String(node.id),type:node.type,format:'ui',subgraph:ids.has(node.type),graph:value,instances});
    });
    definitions.forEach((sub,index)=>{
     const owner=value.nodes.find(node=>node.type===sub?.id);
     const parents=value.nodes.map((node,index)=>({node,path:[...path,'nodes',index],ownerId:ownerId??String(node.id)})).filter(parent=>parent.node.type===sub?.id);
     graph(sub,[...path,'definitions','subgraphs',index],`${scope} / ${sub?.name||sub?.id||'子图'}`,ownerId??(owner?String(owner.id):null),depth+1,parents);
    });
   }
  }
  if(Array.isArray(document.nodes))graph(document,[],'主画布',null);
  else {
   const wrapped=object(document.prompt),prompt=wrapped?document.prompt:document;
   Object.entries(prompt).forEach(([id,node])=>{if(object(node)&&typeof node.class_type==='string')result.push({node,path:wrapped?['prompt',id]:[id],scope:'API 工作流',ownerId:id,id,type:node.class_type,format:'api'});});
  }
  result.forEach(entry=>{if(subgraphIds.has(entry.type))entry.subgraph=true;});
  return {nodes:result,truncated};
 }
 function readField(entry,field) {
  const {node,path,format}=entry;
  if(format==='api'){
   const value=node.inputs?.[field.name];
   return {value,path:[...path,'inputs',field.name],linked:Array.isArray(value),found:own(node.inputs,field.name)};
  }
  const input=node.inputs?.find(i=>i.name===field.name);
  if(input?.link!==undefined&&input.link!==null)return {linked:true,found:true};
  if(object(node.widgets_values))return {value:node.widgets_values[field.name],path:[...path,'widgets_values',field.name],found:own(node.widgets_values,field.name)};
  const widgets=node.inputs?.filter(i=>i.widget)||[];
  if(Array.isArray(node.widgets_values)&&widgets.length===node.widgets_values.length){
   const index=widgets.findIndex(i=>i.name===field.name);
   if(index>=0)return {value:node.widgets_values[index],path:[...path,'widgets_values',index],found:true};
  }
  // Converted widget sockets can shift serialized positions. Do not patch an
  // array slot when any model/configuration widget has become a linked input.
  if(node.inputs?.some(i=>i.widget&&i.link!==null&&i.link!==undefined))return {ambiguous:true,found:true};
  if(Array.isArray(node.widgets_values)&&field.slot<node.widgets_values.length)return {value:node.widgets_values[field.slot],path:[...path,'widgets_values',field.slot],found:true};
  return {found:false};
 }
 function modelReferences(entry,field){
  const ref=readField(entry,field);
  if(!ref.linked||entry.format!=='ui'||!entry.instances?.length)return [ref];
  const socket=entry.node.inputs?.find(input=>input.name===field.name);
  const link=entry.graph.links?.find(link=>!Array.isArray(link)&&link.id===socket?.link);
  if(!link||link.origin_id!==entry.graph.inputNode?.id)return [ref];
  const graphInput=entry.graph.inputs?.[link.origin_slot];
  if(!graphInput?.linkIds?.includes(link.id))return [ref];
  return entry.instances.map(instance=>{
   const input=instance.node.inputs?.find(input=>input.name===graphInput.name);
   const common={scope:`${entry.scope}（实例 #${instance.node.id}）`,ownerId:instance.ownerId};
   if(!input||input.link!==null&&input.link!==undefined)return {...ref,...common};
   if(object(instance.node.widgets_values)&&own(instance.node.widgets_values,graphInput.name))return {...common,found:true,value:instance.node.widgets_values[graphInput.name],path:[...instance.path,'widgets_values',graphInput.name]};
   const widgets=instance.node.inputs.filter(input=>input.widget),index=widgets.findIndex(input=>input.name===graphInput.name);
   // Promoted subgraph widgets have explicit names and a one-to-one mapping.
   // Extra control widgets / ambiguous layouts remain dynamic and unmodified.
   if(index<0||!Array.isArray(instance.node.widgets_values)||widgets.length!==instance.node.widgets_values.length||new Set(widgets.map(input=>input.name)).size!==widgets.length)return {...ref,...common};
   return {...common,found:true,value:instance.node.widgets_values[index],path:[...instance.path,'widgets_values',index]};
  });
 }
 const readValue = (entry,name,slot) => readField(entry,{name,slot}).value;
 function allowedFormat(type,role,format) {
  if(role==='language')return true;
  if(type==='UnetLoaderGGUF'||type==='UnetLoaderGGUFAdvanced')return format==='gguf';
  if(role==='encoder'&&type.includes('GGUF'))return format==='gguf'||format==='safetensors';
  return format!=='gguf';
 }
 function pointer(path) {return '/'+path.map(part=>String(part).replace(/~/g,'~0').replace(/\//g,'~1')).join('/');}
 function analyse(document,catalog) {
  const graph=collect(document),knownTypes=new Set(catalog.nodeTypes),issues=[];let checkedModels=0;
  function add(entry,details) {
   const issue={key:`${pointer(entry.path)}:${details.field||'node'}:${details.code}:${pointer(details.path||[])}`,nodeId:entry.id,nodeType:entry.type,nodeTitle:entry.node.title||entry.node._meta?.title||entry.type,scope:entry.scope,ownerId:entry.ownerId,nodePath:entry.path,candidates:[],...details};
   issues.push(issue);return issue;
  }
  for(const entry of graph.nodes) {
   if(entry.subgraph)continue;
   if(!knownTypes.has(entry.type)){
    const issue=add(entry,{code:'unknown-node',severity:'review',title:'节点安装状态待核实',reason:'本机节点定义快照中未识别此类型；也可能来自动态注册或尚未适配的插件。',advice:'在 ComfyUI 检查缺失节点提示或插件版本。节点接口未确认前，不自动更换节点。'});
    if(/llama|ollama|llm|lmstudio/i.test(entry.type))issue.candidates=catalog.models.filter(m=>m.role==='language').map(m=>({id:m.id,value:m.value,folder:m.folder,canApply:false,label:'需要调整节点与接口',reason:'如用于提示词润色，可考虑已有 LMStudioPromptEnhancer 与此模型；先核对输入输出、服务地址、看图需求和连线，不能直接改文件名。',evidence:m.evidence}));
   }
   const fields=schemas[entry.type];
   if(!fields){
    if(/loader|llama|ollama|llm|lmstudio|model/i.test(entry.type)&&knownTypes.has(entry.type))add(entry,{code:'unadapted',severity:'review',title:'此节点的模型字段尚未适配',reason:'找到了节点定义，但尚无可靠的模型参数映射。',advice:'根据节点说明核对模型和运行后端；不会猜测 widgets_values 的位置。'});
    continue;
   }
   for(const field of fields) {
    for(const ref of modelReferences(entry,field)){
    if(entry.type==='LMStudioPromptEnhancer'&&readValue(entry,'enable_llm',8)===false)continue;
    if(ref.linked||ref.ambiguous){add(entry,{code:'dynamic',severity:'review',field:field.name,role:field.role,title:'模型由连线或动态参数提供',reason:'静态 JSON 不能可靠确定最终模型值。',advice:'检查上游节点的输出；保留现有连线，不改写隐藏的旧参数。'});continue;}
    if(!ref.found||typeof ref.value!=='string'||!ref.value.trim()){
     add(entry,{code:'missing-field',severity:'review',field:field.name,role:field.role,title:'无法读取模型参数',reason:'参数为空、缺失或与已适配格式不一致。',advice:'先核对插件版本及该节点的模型选择框。'});continue;
    }
    const value=ref.value;checkedModels++;
    const common={field:field.name,role:field.role,value,path:ref.path,scope:ref.scope||entry.scope,ownerId:ref.ownerId||entry.ownerId};
    if(field.role==='language'){
     const url=readValue(entry,'lmstudio_base_url',3);
     let local=false;try{const parsed=new URL(url);local=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&parsed.port==='1234'&&parsed.pathname.replace(/\/$/,'')==='/v1';}catch{}
     if(!local){add(entry,{...common,code:'remote-service',severity:'review',title:'该语言模型服务未检查',reason:'此节点未指向已登记的本机 LM Studio 地址。',advice:'先核对服务地址与服务端模型列表；不会请求 JSON 中提供的地址或用本机模型覆盖远端配置。'});continue;}
     if(['auto','default'].includes(value.toLowerCase())){add(entry,{...common,code:'auto-model',severity:'review',title:'语言模型由服务自动选择',reason:'最终加载的模型取决于服务状态。',advice:'需要固定模型时，在 LM Studio 核对 API 标识并填写 model。'});continue;}
    }
    const pool=catalog.models.filter(model=>model.role===field.role);
    const exact=pool.find(model=>field.role==='language'?model.value===value:normalize(model.value)===normalize(value));
    const actual=exact||catalog.models.find(model=>normalize(model.value)===normalize(value)||model.filename&&basename(model.filename)===basename(value));
    // Architecture names alone are insufficient for encoders: LLaMA/Gemma
    // can legitimately be encoders for other image architectures.
    const inferred=apparentRole(value);
    if((actual&&actual.role!==field.role)||(field.role==='diffusion'&&inferred==='language')){
     add(entry,{...common,code:'wrong-role',severity:'error',title:'模型用途与节点不匹配',reason:`此节点需要${roleLabel(field.role)}，引用的资源属于${roleLabel(actual?.role||inferred)}。GGUF 只是文件格式。`,advice:'语言 GGUF 应交给相应语言模型后端；图像主模型、文本编码器、VAE 和 LoRA 不互相替换。'});continue;
    }
    const ext=extension(value);
    if(field.role!=='language'&&!allowedFormat(entry.type,field.role,ext)){
     add(entry,{...common,code:'loader-format',severity:'error',title:'模型格式与加载节点不匹配',reason:`${entry.type} 与所选 ${ext.toUpperCase()} 文件的加载方式不匹配。`,advice:ext==='gguf'?`需要核对 ${field.role==='diffusion'?'UnetLoaderGGUF':'CLIPLoaderGGUF'} 及其支持的模型架构，并调整节点参数和连线；不能只改文件扩展名。`:'请核对对应格式的加载器与模型架构，不能只改文件扩展名。'});continue;
    }
    if(field.role==='encoder'&&family(value)==='qwen3vl-8b'){
     const type=readValue(entry,'type',fields.length);
     if(type!=='qwen_image'){
      add(entry,{...common,code:'encoder-type',severity:'review',title:'文本编码类型需要核对',reason:`当前编码类型为 ${String(type??'未读取')}，本机替换规则仅覆盖 Qwen Image 的 qwen_image 配置。`,advice:'先确认目标图像模型的编码要求；保留其它架构配置，不自动改成 qwen_image。'});continue;
     }
    }
    if(field.role==='encoder'&&entry.type.includes('GGUF')&&/int8_convrot|fp8_scaled/i.test(value)){
     add(entry,{...common,code:'quantized-encoder-loader',severity:'review',title:'特殊量化编码器与加载器组合待核实',reason:'扩展名相同不代表量化加载方式相同；此 GGUF 加载器组合没有已验证的替换规则。',advice:'核对插件的量化支持。本机 Qwen INT8 编码器的已有配置使用 CLIPLoader，调整节点前先检查其接口。'});continue;
    }
    if(exact)continue;
    const issue=add(entry,{...common,code:'not-in-catalog',severity:'error',title:field.role==='language'?'未找到匹配的本机模型标识':'模型引用未在本机清单中找到',reason:'可能未下载、文件名或相对目录不同，或模型位于未登记的位置。',advice:field.role==='lora'?'核对 LoRA 的底模架构与版本，不能随意换成其它 LoRA。':'核对文件位置、模型架构与插件版本；下方只列出有匹配依据的候选。'});
    issue.candidates=pool.filter(model=>field.role==='language'||(family(value)&&family(value)===family(model.value))||basename(value)===basename(model.value)).map(model=>{
     const formatOK=allowedFormat(entry.type,field.role,model.format)&&!(field.role==='encoder'&&entry.type.includes('GGUF')&&/int8_convrot|fp8_scaled/i.test(model.value)),knownNode=knownTypes.has(entry.type);
     const sameFile=basename(value)===basename(model.value);
     const review=field.role==='language';
     return {id:model.id,value:model.value,folder:model.folder,canApply:formatOK&&knownNode,label:!formatOK?'需要核对加载器':review?'同用途候选 · 需确认':sameFile?'同名文件 · 修正引用':'同架构候选 · 核对后替换',reason:!formatOK?'该候选需要核对或调整加载器及量化支持，当前不提供直接替换。':review?'可用于同一润色接口，但不保证输出等价；检查提示词、上下文、看图能力和 LM Studio 实际 API 标识。':sameFile?'本机有同名文件，检查相对目录是否正确。':'型号规则匹配；量化或精度不同可能改变画质、显存和速度，运行兼容性仍需验证。',evidence:model.evidence};
    });
    }
   }
  }
  if(graph.truncated)issues.push({key:'limit',code:'limit',severity:'review',title:'工作流超过静态检查上限',reason:'部分深层子图未检查。',scope:'工作流',candidates:[]});
  return {issues,checkedModels,nodeCount:graph.nodes.length,errors:issues.filter(i=>i.severity==='error').length,reviews:issues.filter(i=>i.severity==='review').length};
 }
 function roleLabel(role) {return {diffusion:'图像主模型',encoder:'文本编码器',vae:'VAE',lora:'LoRA',checkpoint:'整合检查点',language:'语言模型'}[role]||'未知用途';}
 function at(document,path) {
  let value=document;
  for(const key of path){if(['__proto__','prototype','constructor'].includes(String(key))||!own(value,key))throw new Error('参数路径已失效，请重新检查。');value=value[key];}
  return value;
 }
 function patch(document,path,before,after) {
  if(!Array.isArray(path)||!path.length||at(document,path)!==before)throw new Error('原参数已变化，请重新检查后再应用。');
  const result=clone(document),parent=at(result,path.slice(0,-1));parent[path.at(-1)]=after;return result;
 }
 function plan(document,catalog,issueKey,candidateId) {
  const issue=analyse(document,catalog).issues.find(i=>i.key===issueKey),candidate=issue?.candidates.find(c=>c.id===candidateId);
  if(!issue||!candidate?.canApply||!issue.path)throw new Error('此建议需要手动调整，或检查结果已变化。');
  return {path:issue.path,before:issue.value,after:candidate.value,nodeId:issue.nodeId,scope:issue.scope,field:issue.field,reason:candidate.reason};
 }
 return {analyse,collect,plan,patch,pointer,roleLabel,at};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WorkflowCompatibility;
