// Start pages are ordinary workspace tabs; completing one replaces only that tab.
const workflowStartDrafts = new Map();
const workflowReadTokens = new Map();
let workspaceStorageWarning = false;
function isCustomWorkspaceTab(tab) {return ['starter','imported','blank'].includes(tab?.kind);}
function validWorkspaceTab(tab) {
 if (!tab || typeof tab.id !== 'string' || !tab.draft || typeof tab.draft !== 'object') return false;
 if (workflows.some(w => w.id === tab.workflow)) return true;
 if (tab.workflow !== 'custom' || !isCustomWorkspaceTab(tab)) return false;
 if (tab.kind !== 'imported') return true;
 try {WorkflowImport.describe(tab.graph);return true;} catch {return false;}
}
function newWorkflowTab() {
 captureTabState();
 const tab = makeWorkspaceTab('text');
 Object.assign(tab,{workflow:'custom',kind:'starter',title:'新建工作流',mode:'form',draft:{},refs:[],lastResult:null});
 workspaceTabs.push(tab);activateWorkspaceTab(tab.id);
}
function finishWorkflowStart(id, replacement) {
 const tab = workspaceTabs.find(t => t.id === id && t.kind === 'starter');
 if (!tab) return false;
 // Capture the old screen before replacing the active tab's state.
 captureTabState();
 Object.assign(tab,replacement,{id});
 workflowStartDrafts.delete(id);workflowReadTokens.delete(id);
 if (currentTabId === id) {
  restoreTabState();state.page=tab.mode==='canvas'?'canvas':'create';history.replaceState(null,'',`#${state.page}`);
  closeOverlay({restoreFocus:false});render();
 } else {persistWorkspace();render();}
 return true;
}
function startFromTemplate(workflow, targetId) {
 const fresh = makeWorkspaceTab(workflow);
 fresh.draft = cloneDraft(defaultWorkflowDraft(workflow));
 fresh.mode='form';fresh.kind='template';
 finishWorkflowStart(targetId,fresh);
}
function startBlankCanvas() {
 finishWorkflowStart(currentTabId,{kind:'blank',title:'空白工作流',mode:'canvas',graph:{version:0.4,nodes:[],links:[],groups:[],config:{},extra:{}},draft:{},zoom:1});
}
function setWorkflowImportError(id, message) {
 const draft = workflowStartDrafts.get(id) || {};
 workflowStartDrafts.set(id,{...draft,error:message});
 if (currentTabId === id) {
  const error=$('#workflow-import-error');if(error){error.textContent=message;error.hidden=!message;}
 }
}
function importWorkflowText(text, name, targetId=currentTabId) {
 try {
  const result=WorkflowImport.parse(text);
  const title=(name || '导入的工作流').replace(/\.json$/i,'').slice(0,100) || '导入的工作流';
  if (finishWorkflowStart(targetId,{kind:'imported',title,mode:'canvas',graph:result.document,draft:{},zoom:1,compatOpen:true,repairHistory:[]})) toast(`已导入 ${result.nodes.length} 个顶层节点，并完成静态引用检查。`);
 } catch (error) {setWorkflowImportError(targetId,error.message);}
}
async function importWorkflowFiles(files, targetId=currentTabId) {
 if (!workspaceTabs.some(t=>t.id===targetId && t.kind==='starter') || !files.length) return;
 if (files.length !== 1) {setWorkflowImportError(targetId,'每个标签请导入一个 JSON 文件；多个工作流可以分别新建标签。');return;}
 const file=files[0];
 if (!/\.json$/i.test(file.name)) {setWorkflowImportError(targetId,'请选择 .json 工作流文件。');return;}
 if (file.size > WorkflowImport.MAX_BYTES) {setWorkflowImportError(targetId,'A 测版支持 2 MB 以内的 JSON 文件。');return;}
 const token=Symbol();workflowReadTokens.set(targetId,token);setWorkflowImportError(targetId,'正在读取文件…');
 try {
  const text=await file.text();
  if (workflowReadTokens.get(targetId)===token) importWorkflowText(text,file.name,targetId);
 } catch {if(workflowReadTokens.get(targetId)===token)setWorkflowImportError(targetId,'文件读取失败，请重新选择文件。');}
}
function showWorkflowTemplates() {
 if (currentTab()?.kind!=='starter') newWorkflowTab();
 const id=currentTabId;
 modal('选择已有模板',`<p>选一个起点，在当前新标签中创建独立工作副本。</p><div class="workspace-picker-list">${workflows.map(w=>`<button class="workspace-picker-item" data-start-template="${w.id}" data-start-tab="${id}"><span class="strip-icon">${icon(w.icon)}</span><span><strong>${w.name}</strong><small>${w.desc}</small></span>${icon('arrow')}</button>`).join('')}</div>`);
}
function renderWorkflowStart() {
 const draft=workflowStartDrafts.get(currentTabId) || {};
 return `<section class="workflow-start" aria-label="新建工作流"><div class="start-intro"><span class="eyebrow">A NEW WORKFLOW</span><h1>从这里，开始新的创作。</h1><p>带来你的工作流，选一个熟悉的模板，或从空白画布开始。</p></div><div class="start-options"><section class="json-dropzone" id="workflow-dropzone" aria-label="JSON 导入区域"><div class="start-option-label"><span>01</span> 导入工作流</div><div class="dropzone-symbol">${icon('upload')}</div><h2>把 JSON 文件拖到这里</h2><p>也可以选择文件，或直接粘贴 JSON 内容。</p><div class="start-import-actions">${button('选择 JSON 文件','choose-workflow-file','primary','folder')}${button('粘贴 JSON','show-json-paste','','code')}</div><div class="json-paste" id="json-paste-panel" ${draft.open?'':'hidden'}><label class="field-label" for="workflow-json">JSON 内容</label><textarea id="workflow-json" spellcheck="false" placeholder='在这里粘贴完整的工作流 JSON…'>${esc(draft.text || '')}</textarea><div class="json-paste-footer"><small>Ctrl / ⌘ + Enter 导入</small>${button('导入此 JSON','import-json-text','small primary','arrow')}</div></div><p class="workflow-import-error" id="workflow-import-error" role="alert" ${draft.error?'':'hidden'}>${esc(draft.error || '')}</p><small class="dropzone-footnote">.json · 最大 2 MB · 仅在本机浏览器读取</small></section><div class="start-secondary-options"><button class="start-option-card" data-action="start-template-picker"><span class="start-option-label"><span>02</span> 使用模板</span><span class="start-card-icon">${icon('workflow')}</span><strong>选择已有模板</strong><span class="start-card-description">文生图、多图参考、Gemma 润色<br>从已准备好的工作流继续。</span><span class="start-card-link">浏览 ${workflows.length} 个模板 ${icon('arrow')}</span></button><button class="start-option-card" data-action="start-blank-canvas"><span class="start-option-label"><span>03</span> 从零开始</span><span class="start-card-icon">${icon('plus')}</span><strong>新建空白节点画布</strong><span class="start-card-description">不预设节点，留一张空画布<br>给下一个想法。</span><span class="start-card-link">打开空白画布 ${icon('arrow')}</span></button></div></div><p class="start-footer">${icon('info')} 每个工作流在独立标签中打开，随时切换继续创作。</p></section>`;
}
function renderCustomWorkflow() {
 const tab=currentTab();
 if (tab.kind==='starter') return renderWorkflowStart();
 let viewedGraph=tab.graph;
 try{if(tab.graphViewPath?.length)viewedGraph=WorkflowCompatibility.at(tab.graph,tab.graphViewPath);}catch{tab.graphViewPath=[];}
 const graph=WorkflowImport.describe(viewedGraph);
 const count=graph.nodes.length;
 const scopeLabel=tab.graphViewPath?.length?`<div class="subgraph-breadcrumb"><span>子图 · ${esc(viewedGraph.name||viewedGraph.id||'未命名')}</span>${button('返回主画布','compat-root-canvas','small','arrow')}</div>`:'';
 const header=renderWorkspaceHeader({id:'custom',name:tab.title,icon:'workflow'})+renderCompatibilityPanel(tab)+scopeLabel;
 if (state.mode==='form') return `${header}<div class="empty-state custom-form-empty">${icon('sliders')}<h3>这个工作流还没有简洁表单</h3><p>先在节点画布中查看结构；自定义表单参数将在后续接入。</p>${button('前往节点画布','view-canvas','primary','workflow')}</div>`;
 const previewStart=tab.graphPreviewStart||0;
 const shown=graph.nodes.slice(previewStart,previewStart+120);
 const positions=new Map(shown.map((node,i)=>[node.id,{x:24+(i%3)*300,y:30+Math.floor(i/3)*150}]));
 const paths=graph.links.filter(link=>positions.has(link.from)&&positions.has(link.to)).slice(0,400).map(link=>{
  const a=positions.get(link.from),b=positions.get(link.to);
  return `<path d="M${a.x+246} ${a.y+52} C${a.x+276} ${a.y+52},${b.x-30} ${b.y+52},${b.x} ${b.y+52}"/>`;
 }).join('');
 const empty=`<div class="blank-canvas-message">${icon('workflow')}<h3>一张空白画布</h3><p>0 个节点 · 从这里构建你的工作流</p><small>A 测版展示空画布，添加节点与连线将在 ComfyUI 接入后开放。</small></div>`;
 return `${header}<div class="canvas-board imported-canvas ${count?'':'blank-canvas'}"><div class="canvas-header"><span>${tab.kind==='blank'?'空白工作流':esc(graph.format)} · ${count} 个顶层节点</span><span>${count?'结构预览 · 自动排布':'尚未添加节点'}</span></div>${count?'':empty}<div class="graph-inner" style="width:900px;height:${count?Math.ceil(shown.length/3)*150+30:240}px"><svg class="imported-connections" aria-hidden="true">${paths}</svg>${shown.map(node=>{const p=positions.get(node.id);const flagged=compatibilityReport(tab)?.issues.some(issue=>issue.nodeId===node.id && WorkflowCompatibility.pointer(issue.nodePath?.slice(0,-2)||[])===WorkflowCompatibility.pointer(tab.graphViewPath||[]));return `<article data-import-node="${esc(node.id)}" class="graph-node imported-node ${flagged?'has-compat-issue':''} ${tab.focusNodeId===node.id?'focused-compat-issue':''}" style="left:${p.x}px;top:${p.y}px"><h3 title="${esc(node.title)}">${icon('workflow')}<span>${esc(node.title)}</span></h3><div class="graph-node-content"><span class="node-id"># ${esc(node.id)}</span><span class="node-type" title="${esc(node.type)}">${esc(node.type)}</span></div></article>`;}).join('')}</div></div><p class="canvas-notice">${icon('info')} ${count?'已保留完整 JSON（含子图定义）；当前可预览节点结构并定位子图；完整编辑和运行将在 ComfyUI 接入后开放。':'空白工作流已建立，保存在当前标签。'}${count>120?` 大型工作流当前显示第 ${previewStart+1}–${Math.min(count,previewStart+120)} 个节点；可从问题清单定位其它节点。`:''}${graph.skippedLinks?' 部分连线端点未在顶层找到，原数据已保留。':''}</p>`;
}
function showJsonPaste() {
 const draft=workflowStartDrafts.get(currentTabId) || {};
 draft.open=true;workflowStartDrafts.set(currentTabId,draft);
 $('#json-paste-panel').hidden=false;$('#workflow-json').focus();
}
function bindWorkflowStartActions() {
 Object.assign(actions,{
  'new-create':newWorkflowTab,'open-tab-picker':newWorkflowTab,'new-template':newWorkflowTab,
  'import-workflow':newWorkflowTab,'start-template-picker':showWorkflowTemplates,'start-blank-canvas':startBlankCanvas,
  'show-json-paste':showJsonPaste,
  'choose-workflow-file':()=>{const input=$('#workflow-file');input.dataset.targetTab=currentTabId;input.value='';input.click();},
  'import-json-text':()=>importWorkflowText($('#workflow-json').value),
  'duplicate-workspace-tab':()=>{const source=currentTab();if(!source)return;captureTabState();const tab=makeWorkspaceTab('text',source);workspaceTabs.push(tab);activateWorkspaceTab(tab.id);}
 });
 document.addEventListener('click',event=>{
  const choice=event.target.closest('[data-start-template]');
  if(choice)startFromTemplate(choice.dataset.startTemplate,choice.dataset.startTab);
 });
 document.addEventListener('input',event=>{
  if(event.target.id==='workflow-json'){const draft=workflowStartDrafts.get(currentTabId)||{};workflowStartDrafts.set(currentTabId,{...draft,text:event.target.value,open:true});setWorkflowImportError(currentTabId,'');}
 });
 $('#workflow-file').addEventListener('change',event=>importWorkflowFiles([...event.target.files],event.target.dataset.targetTab));
 document.addEventListener('paste',event=>{
  if(!isEditorPage()||currentTab()?.kind!=='starter'||$('#overlay-root').childElementCount||event.target.closest('input,textarea,[contenteditable="true"]'))return;
  const text=event.clipboardData?.getData('text/plain');if(!text?.trim())return;
  event.preventDefault();showJsonPaste();$('#workflow-json').value=text;
  workflowStartDrafts.set(currentTabId,{text,open:true});setWorkflowImportError(currentTabId,'');
 });
 // Prevent dropped files navigating away from the workspace. Only the start page accepts them.
 document.addEventListener('dragover',event=>{
  if(!isEditorPage()||!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
  event.preventDefault();const zone=event.target.closest('#workflow-dropzone');
  event.dataTransfer.dropEffect=zone?'copy':'none';$('#workflow-dropzone')?.classList.toggle('drag-over',!!zone);
 });
 document.addEventListener('dragleave',event=>{if(event.target.id==='workflow-dropzone'&&!event.target.contains(event.relatedTarget))event.target.classList.remove('drag-over');});
 document.addEventListener('drop',event=>{
  if(!isEditorPage()||!event.dataTransfer?.files.length)return;
  event.preventDefault();$('#workflow-dropzone')?.classList.remove('drag-over');
  if(event.target.closest('#workflow-dropzone'))importWorkflowFiles([...event.dataTransfer.files]);
  else toast('请先新建工作流，把 JSON 拖入导入区域。');
 });
}
