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
 if(changed)contextVersion++;
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
function renderFields(){
 fieldRefs=[];
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
$('#duplicate').addEventListener('click',()=>run(()=>api.duplicateTab(),'已创建独立副本。'));
$('#preview').addEventListener('click',()=>run(()=>api.showPreview(),'当前是 A 测界面，点击“创作工作区”返回真实编辑器。',false));
$('#editor-home').addEventListener('click',()=>run(()=>api.showEditor(),'已返回桌面创作工作区。'));
$('#refresh-fields').addEventListener('click',()=>run(()=>api.snapshot(),'已从真实画布读取参数。'));
$('#fields').addEventListener('change',async event=>{
 const input=event.target.closest('[data-field]');if(!input)return;
 const ref=fieldRefs[Number(input.dataset.field)];if(!ref||busy)return;
 const originTabId=current.activeId, originVersion=contextVersion;
 const value=ref.type==='boolean'?input.checked:ref.type==='number'?Number(input.value):input.value;
 if(ref.type==='number'&&(!input.value.trim()||!Number.isFinite(value))){input.value=String(ref.value);status('请输入有效数字。',true);return;}
 return run(()=>api.applyParameters([{nodeId:ref.nodeId,graphId:ref.graphId,widgetName:ref.widgetName,value}],originTabId),
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
