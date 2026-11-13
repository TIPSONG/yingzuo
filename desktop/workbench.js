'use strict';
const api=window.yingzuoDesktop;
const $=selector=>document.querySelector(selector);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let current={tabs:[],activeId:null,connected:false,currentView:'editor'}, snapshot=null, busy=false;
let fieldRefs=[], contextVersion=0;
function status(message,error=false){$('#status').textContent=message;$('#status').classList.toggle('error',error);reportBounds();}
function reportBounds(){const rect=$('#editor-portal').getBoundingClientRect();api.setBounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height});}
function renderState(){
 const tab=current.tabs.find(t=>t.id===current.activeId);
 $('#tabs').innerHTML=current.tabs.map(t=>`<div class="tab ${t.id===current.activeId?'active':''}"><button role="tab" aria-selected="${t.id===current.activeId}" data-tab="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</button><button data-close="${t.id}" aria-label="关闭 ${escapeHtml(t.title)}">×</button></div>`).join('');
 $('#connection').textContent=current.connected?(current.transportConnected===false?'编辑器已载入 · 服务断线':'ComfyUI 已连接'):'ComfyUI 未连接';
 $('#endpoint').textContent=current.comfyUrl||'本机绘图环境';
 $('#connect').textContent=current.connected?'检查连接':'连接已有服务';
 $('#parameters').hidden=current.currentView!=='editor'||tab?.mode!=='parameters'||!current.connected;
 $('#empty').hidden=!!tab&&current.connected||current.currentView==='preview';
 document.querySelectorAll('[data-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.mode===tab?.mode&&current.currentView==='editor');button.disabled=!tab||!current.connected||busy;});
 $('#save').disabled=!tab||busy;$('#export').disabled=!tab||busy;$('#duplicate').disabled=!tab||busy;
 $('#fields').inert=busy;
 $('#tabs').inert=busy;$('#templates').inert=busy;
 for(const id of ['connect','import','blank','preview','editor-home'])$('#'+id).disabled=busy;
 $('#refresh-fields').disabled=!tab||!current.connected||busy;
 $('#save-state').textContent=current.savedPath?`草稿：${current.savedPath}`:'独立工作副本 · 本机保存';
 if(current.currentView==='preview')$('#graph-info').textContent='A 测界面 · 保留原型预览';
 else if(snapshot&&tab)$('#graph-info').textContent=`${snapshot.graph?.nodes?.length||0} 个顶层节点 · ${snapshot.nodes?.length||0} 个已读取节点（含子图）`;
 else $('#graph-info').textContent='打开一个工作流开始验证';
 $('#transport').textContent=current.transportConnected?'WebSocket 已连接':'WebSocket 未连接';
 reportBounds();
}
function accept(result,fields=true){
 const previousId=current.activeId, previousConnection=current.connected, previousView=current.currentView;
 if(result.state)current={...current,...result.state};
 const changed=previousId!==current.activeId||previousConnection!==current.connected||previousView!==current.currentView;
 if(changed){contextVersion++;formPanel=null;Promise.resolve().then(loadFormPanel);}
 else if(formStale())Promise.resolve().then(loadFormPanel); // C06：同一标签保存新表单/重绑/图变化后失效缓存并重新映射
 const invalid=!current.connected||!current.tabs.some(tab=>tab.id===current.activeId);
 if(Object.hasOwn(result,'snapshot')){
  const next=invalid?null:result.snapshot;
  if(snapshot&&!next)contextVersion++;
  snapshot=next;
  if(fields||!snapshot||changed)renderFields();
 }else if(previousId!==current.activeId||invalid){snapshot=null;renderFields();}
 renderState();
 if(!result.ok)throw new Error(result.error||'操作未完成。');
 return result;
}
async function run(operation,message,fields=true,isCurrent=()=>true){
 if(busy)return;busy=true;renderState();status('正在处理，请稍候…');
 let responseIsCurrent=false;
 try{const response=await operation();if(!isCurrent())return;responseIsCurrent=true;const result=accept(response,fields);status(result.cancelled?'已取消操作。':result.message||message||'已完成。');return result;}
 catch(error){if(responseIsCurrent||isCurrent()){if(fields)renderFields();status(error.message,true);}}
 finally{busy=false;renderState();}
}
async function requireConnection(){if(!current.connected)accept(await api.connect());}
// S07：模板保存了自定义表单时，左侧正式参数面板按表单显示（中文名、分组、顺序），修改经同一桥接写回 UI 根图。
// C06：面板缓存身份 {tabId, revision, templateId, templateVersionId}；任一变化即失效，只接受所属标签与版本的异步响应。
let formPanel=null,formSeq=0,formKey=null;
const keyOf=tab=>tab?`${tab.id}|${tab.revision??0}|${tab.templateId??''}|${tab.templateVersionId??''}`:null;
function formStale(){const tab=(current.tabs||[]).find(t=>t.id===current.activeId);return !!tab?.templateId&&current.connected&&keyOf(tab)!==formKey;}
async function loadFormPanel(){
 const tabId=current.activeId,seq=++formSeq,tab=(current.tabs||[]).find(t=>t.id===tabId),key=keyOf(tab);
 const had=!!formPanel;formPanel=null;formKey=key;
 if(!tab?.templateId||!current.connected||!window.yingzuo?.tasks?.form){if(had)renderFields();return;}
 try{const r=await window.yingzuo.tasks.form(tabId);const now=(current.tabs||[]).find(t=>t.id===tabId);if(seq!==formSeq||current.activeId!==tabId||keyOf(now)!==key)return;formPanel=r?.ok&&r.data?.fields?r.data:null;}catch{formPanel=null;}
 renderFields();
}
function widgetFor(target){
 const node=(snapshot?.nodes||[]).find(n=>String(n.nodeId)===String(target.nodeId)&&(target.graphId==null?!(n.path||[]).length:String(n.graphId)===String(target.graphId)));
 return node&&node.widgets.find(w=>w.name===target.widgetName);
}
function renderFormPanel(){
 const groups=[...new Set(formPanel.fields.map(f=>f.group||'参数'))];
 return groups.map(g=>`<section class="node-fields"><h3>${escapeHtml(g)}</h3>${formPanel.fields.filter(f=>(f.group||'参数')===g).map(f=>{
  const label=f.label||f.fieldName,w=f.target&&widgetFor(f.target);
  if(!w||!w.editable)return `<label class="field"><span>${escapeHtml(label)}</span><span class="err">${escapeHtml(f.reason||f.panelReason||(w?'该参数已连线或只读，请在画布中编辑。':'未在当前画布中找到该参数，请刷新。'))}</span></label>`;
  const index=fieldRefs.push({nodeId:f.target.nodeId,graphId:f.target.graphId,widgetName:f.target.widgetName,type:typeof w.value,value:w.value,form:{index:f.index,revision:formPanel.revision,versionId:formPanel.versionId??null,constraints:f.constraints||{},widgetType:f.widgetType,label}})-1;
  const attrs=`data-field="${index}" aria-label="${escapeHtml(label)}"`,c=f.constraints||{};
  let input;
  if(typeof w.value==='boolean')input=`<input type="checkbox" ${attrs} ${w.value?'checked':''}>`;
  else if(Array.isArray(w.options?.values)&&w.options.values.length)input=`<select ${attrs}>${w.options.values.map(v=>`<option value="${escapeHtml(v)}" ${String(v)===String(w.value)?'selected':''}>${escapeHtml(v)}</option>`).join('')}</select>`;
  else if(Array.isArray(c.values)&&c.values.length)input=`<select ${attrs}>${c.values.map(v=>`<option value="${escapeHtml(v)}" ${String(v)===String(w.value)?'selected':''}>${escapeHtml(v)}</option>`).join('')}</select>`;
  else if(typeof w.value==='number')input=`<input type="number" step="${escapeHtml(c.step??w.options?.step??'any')}" ${c.min!==undefined?`min="${escapeHtml(c.min)}"`:''} ${c.max!==undefined?`max="${escapeHtml(c.max)}"`:''} ${attrs} value="${w.value}">`;
  else if(f.widgetType==='text'||c.multiline||w.options?.multiline||String(w.value).length>100)input=`<textarea ${attrs}>${escapeHtml(w.value)}</textarea>`;
  else input=`<input type="text" ${attrs} value="${escapeHtml(w.value)}">`;
  return `<label class="field"><span>${escapeHtml(label)}</span>${input}${f.help?`<small class="muted">${escapeHtml(f.help)}</small>`:''}</label>`;
 }).join('')}</section>`).join('')+`<p class="muted">按模板表单显示${formPanel.pinned?'（固定到该标签打开时的模板版本）':''}；修改直接写入画布，运行、快捷键、批量与润色使用同一份内容。</p>`;
}
function renderFields(){
 fieldRefs=[];
 if(formPanel&&formPanel.tabId===current.activeId&&snapshot){$('#fields').innerHTML=renderFormPanel();return;}
 const nodes=(snapshot?.nodes||[]).filter(node=>node.widgets.some(widget=>widget.editable));
 $('#fields').innerHTML=nodes.map(node=>{
  const fields=node.widgets.filter(widget=>widget.editable).map(widget=>{
   const index=fieldRefs.push({nodeId:node.nodeId,graphId:node.graphId,widgetName:widget.name,type:typeof widget.value,value:widget.value})-1;
   const label=`${node.title||node.type} / ${widget.name}`;
   const attrs=`data-field="${index}" aria-label="${escapeHtml(label)}"`;
   let input;
   if(typeof widget.value==='boolean')input=`<input type="checkbox" ${attrs} ${widget.value?'checked':''}>`;
   else if(Array.isArray(widget.options?.values)&&widget.options.values.length)input=`<select ${attrs}>${widget.options.values.map(value=>`<option value="${escapeHtml(value)}" ${String(value)===String(widget.value)?'selected':''}>${escapeHtml(value)}</option>`).join('')}</select>`;
   else if(typeof widget.value==='number')input=`<input type="number" step="any" ${attrs} value="${widget.value}">`;
   else if(widget.options?.multiline||['customtext','text'].includes(widget.type)||String(widget.value).length>100)input=`<textarea ${attrs}>${escapeHtml(widget.value)}</textarea>`;
   else input=`<input type="text" ${attrs} value="${escapeHtml(widget.value)}">`;
   return `<label class="field"><span>${escapeHtml(widget.name)}</span>${input}</label>`;
  }).join('');
  return `<section class="node-fields"><h3>${escapeHtml(node.title||node.type)}</h3><div class="node-path">节点 #${escapeHtml(node.nodeId)} · ${node.path?.length?'子图':'主画布'} · ${escapeHtml(node.type)}</div>${fields}</section>`;
 }).join('')||'<p>当前图没有可直接映射的基础参数，请在节点画布中编辑。</p>';
}
$('#templates').addEventListener('click',event=>{const button=event.target.closest('[data-template]');if(button)run(async()=>{await requireConnection();return api.openTemplate(button.dataset.template);},'已打开真实工作流。');});
$('#tabs').addEventListener('click',event=>{
 const tab=event.target.closest('[data-tab]'),close=event.target.closest('[data-close]');
 if(tab)run(()=>api.activateTab(tab.dataset.tab),'工作副本已切换。');
 if(close)run(()=>api.closeTab(close.dataset.close),'标签已关闭；副本保留在本机恢复目录。');
});
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>run(()=>api.setMode(button.dataset.mode),'编辑模式已切换。')));
$('#connect').addEventListener('click',()=>run(()=>api.connect(),'真实 ComfyUI 已连接。'));
$('#save').addEventListener('click',()=>run(()=>api.save(),'当前工作区已保存。',false));
$('#export').addEventListener('click',()=>run(()=>api.exportWorkflow(),'JSON 副本已导出。',false));
$('#import').addEventListener('click',()=>run(async()=>{await requireConnection();return api.importWorkflow();},'已导入工作流。'));
$('#blank').addEventListener('click',()=>run(async()=>{await requireConnection();return api.newBlank();},'已创建零节点工作副本。'));
$('#duplicate').addEventListener('click',()=>{const from=current.activeId;run(async()=>{const r=await api.duplicateTab();const to=r?.state?.activeId;if(from&&to&&to!==from)await window.yingzuo?.tasks?.copyRefs(from,to);return r;},'已创建独立副本（含参考图选择）。');});
$('#preview').addEventListener('click',()=>run(()=>api.showPreview(),'当前是 A 测界面，点击“创作工作区”返回真实编辑器。',false));
$('#editor-home').addEventListener('click',()=>run(()=>api.showEditor(),'已返回桌面创作工作区。'));
$('#refresh-fields').addEventListener('click',()=>run(()=>api.snapshot(),'已从真实画布读取参数。').then(loadFormPanel));
$('#fields').addEventListener('change',async event=>{
 const input=event.target.closest('[data-field]');if(!input)return;
 const ref=fieldRefs[Number(input.dataset.field)];if(!ref||busy)return;
 const originTabId=current.activeId, originVersion=contextVersion;
 const value=ref.type==='boolean'?input.checked:ref.type==='number'?Number(input.value):input.value;
 if(ref.type==='number'&&(!input.value.trim()||!Number.isFinite(value))){input.value=String(ref.value);status('请输入有效数字。',true);return;}
 const tabRevision=(current.tabs||[]).find(t=>t.id===originTabId)?.revision;
 if(ref.form){
  // C06：表单字段经主进程入口写回（版本、映射、约束在主进程再次校验）；前端只做即时提示
  const c=ref.form.constraints;if(typeof value==='number'&&((c.min!==undefined&&value<c.min)||(c.max!==undefined&&value>c.max)||(['int','seed'].includes(ref.form.widgetType)&&!Number.isInteger(value)))){input.value=String(ref.value);status(`“${ref.form.label}”超出允许范围或不是整数。`,true);return;}
  return run(async()=>{const r=await window.yingzuo.tasks.applyFormField(originTabId,{index:ref.form.index,value,expectedRevision:ref.form.revision,versionId:ref.form.versionId});if(!r?.ok)throw new Error(r?.error?.message||'表单写入被拒绝，请刷新表单。');return api.snapshot();},
   '参数已按表单写入画布，草稿已保存。',true,()=>current.activeId===originTabId&&current.connected&&contextVersion===originVersion).finally(loadFormPanel);
 }
 return run(()=>api.applyParameters([{nodeId:ref.nodeId,graphId:ref.graphId,widgetName:ref.widgetName,value}],originTabId,tabRevision),
  '参数已同步到真实画布，草稿已保存。',true,
  ()=>current.activeId===originTabId&&current.connected&&contextVersion===originVersion);
});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();run(()=>api.save(),'当前工作区已保存。',false);}});
new ResizeObserver(reportBounds).observe($('#editor-portal'));
api.onStatus(data=>{accept({ok:true,state:data,...(Object.hasOwn(data,'snapshot')?{snapshot:data.snapshot}:{})},false);if(data.error)status(data.error,true);else if(data.message)status(data.message);});
api.boot().then(result=>{
 accept(result);
 $('#templates').innerHTML=result.templates.map(template=>`<button data-template="${template.id}" ${template.available?'':'disabled'}>${escapeHtml(template.name)}${template.available?'':' · 未找到'}</button>`).join('');
 if(current.startupError)status(`旧草稿读取失败，原文件已保留：${current.startupError}`,true);
}).catch(error=>status(error.message,true));
