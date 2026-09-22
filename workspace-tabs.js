// The A-test workspace keeps a separate draft and view for every open tab.
let workspaceTabs = [];
let currentTabId = null;
let closedWorkspaceTabs = [];
const isEditorPage = () => state.page === 'create' || state.page === 'canvas';
const currentTab = () => workspaceTabs.find(tab => tab.id === currentTabId);
const cloneDraft = value => JSON.parse(JSON.stringify(value));
function defaultWorkflowDraft(workflow) {
 return {prompt:workflow.includes('edit')?pictures[2].prompt:workflow==='text'?pictures[0].prompt:pictures[1].prompt,negative:'',ratio:'1:1',steps:25,seed:'随机',autoEnhance:false};
}
function makeWorkspaceTab(workflow, source) {
 const base = workflows.find(w => w.id === workflow);
 const tab = {id:crypto.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,workflow,title:base.name,mode:state.mode==='canvas'?'canvas':'form',draft:cloneDraft(drafts[workflow] || defaultWorkflowDraft(workflow)),refs:[],advanced:false,batch:false,batchCount:1,lastResult:null,zoom:1};
 if(source){Object.assign(tab,cloneDraft(source),{id:tab.id,title:`${source.title} · 副本`,refs:[...source.refs]});}
 return tab;
}
function initializeWorkspace() {
 const saved=load('workspace-tabs',null);
 if(saved && Array.isArray(saved.tabs)){
  workspaceTabs=saved.tabs.filter(validWorkspaceTab);
  currentTabId=workspaceTabs.some(t=>t.id===saved.active)?saved.active:workspaceTabs[0]?.id;
  closedWorkspaceTabs=Array.isArray(saved.closed)?saved.closed.filter(validWorkspaceTab).slice(-12):[];
 }else{
  workspaceTabs=[makeWorkspaceTab(state.workflow),makeWorkspaceTab(state.workflow==='edit'?'gemma-text':'edit')];
  currentTabId=workspaceTabs[0].id;
 }
 restoreTabState();
}
function captureTabState() {
 const tab=currentTab();if(!tab)return;
 const displayedZoom=$('#main')?.dataset.tabId===tab.id?$('.graph-inner')?.dataset.zoom:null;
 Object.assign(tab,{mode:state.mode,refs:[...state.refs],advanced:state.advanced,batch:state.batch,batchCount:state.batchCount,lastResult:state.lastResult,zoom:Number(displayedZoom || tab.zoom || 1)});
}
function restoreTabState() {
 const tab=currentTab();if(!tab)return;
 Object.assign(state,{workflow:tab.workflow,mode:tab.mode==='canvas'?'canvas':'form',refs:[...(tab.refs || [])],advanced:!!tab.advanced,batch:!!tab.batch,batchCount:tab.batchCount || 1,lastResult:tab.lastResult || null});
}
function persistWorkspace() {
 captureTabState();
 // Blob references remain available between tabs but cannot survive a reload.
 const serializable=tab=>({...tab,refs:(tab.refs || []).filter(url=>!url.startsWith('blob:'))});
 const saved=save('workspace-tabs',{active:currentTabId,tabs:workspaceTabs.map(serializable),closed:closedWorkspaceTabs.map(serializable)});
 workspaceStorageWarning=!saved;
 return saved;
}
function activateWorkspaceTab(id) {
 if(!workspaceTabs.some(t=>t.id===id))return;
 captureTabState();currentTabId=id;restoreTabState();
 save('workflow',state.workflow);save('editor-mode',state.mode);persistWorkspace();
 closeOverlay({restoreFocus:false});state.page=state.mode==='canvas'?'canvas':'create';history.replaceState(null,'',`#${state.page}`);render();
 requestAnimationFrame(()=>$('#workspace-tab-'+id)?.scrollIntoView({block:'nearest',inline:'nearest'}));
}
function openWorkspaceWorkflow(workflow, duplicate=false) {
 if(!workflows.some(w=>w.id===workflow))return;
 captureTabState();
 const existing=!duplicate && (currentTab()?.workflow===workflow?currentTab():workspaceTabs.find(t=>t.workflow===workflow));
 if(existing){activateWorkspaceTab(existing.id);return;}
 const tab=makeWorkspaceTab(workflow,duplicate?currentTab():null);workspaceTabs.push(tab);activateWorkspaceTab(tab.id);
}
function closeWorkspaceTab(id) {
 const index=workspaceTabs.findIndex(t=>t.id===id);if(index<0)return;
 captureTabState();const [removed]=workspaceTabs.splice(index,1);
 closedWorkspaceTabs.push(removed);closedWorkspaceTabs=closedWorkspaceTabs.slice(-12);
 if(currentTabId===id){currentTabId=workspaceTabs[Math.min(index,workspaceTabs.length-1)]?.id || null;restoreTabState();}
 persistWorkspace();closeOverlay();
 if(workspaceTabs.length){state.page=state.mode==='canvas'?'canvas':'create';history.replaceState(null,'',`#${state.page}`);}
 render();toast('标签已关闭，草稿可从“工作流 → 重新打开关闭的标签”恢复。');
}
function reopenWorkspaceTab() {
 const tab=closedWorkspaceTabs.pop();if(!tab){toast('没有最近关闭的标签。');return;}
 workspaceTabs.push(tab);activateWorkspaceTab(tab.id);
}
function workspaceMenuItem(label,action,glyph,disabled=false){return `<button role="menuitem" data-action="${action}" ${disabled?'disabled':''}>${glyph?icon(glyph):''}<span>${label}</span></button>`;}
function renderWorkspaceChrome() {
 const active=currentTab();
 return `<section class="workflow-workspace-chrome" aria-label="工作流工作区"><div class="workspace-menubar"><details class="workspace-menu"><summary>${icon('workflow')} 工作流 ${icon('down')}</summary><div class="workspace-menu-popup" role="menu" aria-label="工作流菜单">${workspaceMenuItem('新建工作流…','open-tab-picker','folder')}${workspaceMenuItem('新建当前工作流副本','duplicate-workspace-tab','copy',!active)}${workspaceMenuItem('重命名标签…','rename-workspace-tab','create',!active)}<div class="menu-separator"></div>${workspaceMenuItem('保存预览草稿','save-workspace-draft','check',!active)}${workspaceMenuItem('导入 JSON 工作流…','import-workflow','upload')}<div class="menu-separator"></div>${workspaceMenuItem('关闭当前标签','close-workspace-tab','close',!active)}${workspaceMenuItem('重新打开关闭的标签','reopen-workspace-tab','refresh',!closedWorkspaceTabs.length)}</div></details><details class="workspace-menu"><summary>视图 ${icon('down')}</summary><div class="workspace-menu-popup" role="menu" aria-label="视图菜单">${workspaceMenuItem('简洁表单','view-form','sliders',!active)}${workspaceMenuItem('节点画布','view-canvas','workflow',!active)}${workspaceMenuItem('重置画布缩放','canvas-zoom-reset','expand',state.mode!=='canvas'||!active)}</div></details><span class="workspace-autosave">${icon(workspaceStorageWarning?'info':'check')} ${workspaceStorageWarning?'本地存储不可用 · 最新草稿仅本次会话保留':'每个标签独立保存草稿'}</span><button class="text-button comfy-workspace-link" data-action="comfy-canvas">打开现有 ComfyUI ${icon('arrowUp')}</button></div><div class="workspace-tabs-row"><div class="workspace-tablist" role="tablist" aria-label="已打开的工作流">${workspaceTabs.map(t=>`<div class="workflow-tab ${t.id===currentTabId?'active':''}"><button role="tab" id="workspace-tab-${t.id}" aria-selected="${t.id===currentTabId}" aria-controls="workflow-tab-panel" tabindex="${t.id===currentTabId?'0':'-1'}" data-workspace-tab="${t.id}" title="${esc(t.title)}">${icon(t.mode==='canvas'?'workflow':'sliders')}<span>${esc(t.title)}</span><i class="tab-draft-dot" title="独立工作副本"></i></button><button class="workspace-tab-close" data-close-workspace-tab="${t.id}" aria-label="关闭标签 ${esc(t.title)}">${icon('close')}</button></div>`).join('')}</div><button class="workspace-add-tab" data-action="open-tab-picker" aria-label="新建工作流标签" title="新建工作流">${icon('plus')}</button></div></section>`;
}
function renderWorkspaceHeader(w) {
 const tab=currentTab();
 return `<div class="create-heading"><div class="workflow-picker"><span class="strip-icon">${icon(w.icon)}</span><div><h2>${esc(tab?.title || w.name)}</h2><small>${w.id==='prompt'?'只输出提示词':'独立工作副本'} · 当前标签${state.mode==='canvas'?'节点画布':'简洁表单'}</small></div></div><div class="inline-actions"><div class="tabs" aria-label="创作模式"><button class="tab ${state.mode==='form'?'active':''}" data-mode="form" aria-pressed="${state.mode==='form'}">${icon('sliders')} 简洁表单</button><button class="tab ${state.mode==='canvas'?'active':''}" data-mode="canvas" aria-pressed="${state.mode==='canvas'}">${icon('workflow')} 节点画布</button></div><button class="icon-button outlined" data-action="save-template" aria-label="保存为模板">${icon('more')}</button></div></div>`;
}
function renderEmptyWorkspace(){return `<div class="empty-state">${icon('workflow')}<h3>打开一个工作流，开始创作</h3><p>用上方的 + 导入 JSON、选择模板，或新建空白节点画布。</p>${button('新建工作流','open-tab-picker','primary','plus')}</div>`;}
function renameWorkspaceTab(){
 const tab=currentTab();if(!tab)return;
 modal('重命名工作流标签',`<label class="field-label" for="tab-title">工作副本名称</label><input id="tab-title" class="full-width" maxlength="60" value="${esc(tab.title)}"><p class="subtext spaced">只修改预览中的标签名称，不修改原工作流文件。</p><div class="modal-actions">${button('取消','close')}${button('保存名称','apply-tab-title','primary')}</div>`);
}
function bindWorkspaceActions(){
 Object.assign(actions,{
  'open-tab-picker':newWorkflowTab,
  'duplicate-workspace-tab':()=>{if(currentTab())openWorkspaceWorkflow(state.workflow,true);},
  'close-workspace-tab':()=>{if(currentTab())closeWorkspaceTab(currentTabId);},
  'reopen-workspace-tab':reopenWorkspaceTab,
  'rename-workspace-tab':renameWorkspaceTab,
  'apply-tab-title':()=>{const title=$('#tab-title').value.trim();if(!title){toast('标签名称不能为空。');return;}currentTab().title=title;persistWorkspace();closeOverlay();render();},
  'save-workspace-draft':()=>{toast(persistWorkspace()?'已保存所有打开标签的预览草稿。':'浏览器本地存储不可用或已满，最新草稿仅在本次会话保留。');},
  'view-form':()=>navigate('create'), 'view-canvas':()=>navigate('canvas')
 });
}
document.addEventListener('click',e=>{
 const tab=e.target.closest('[data-workspace-tab]');if(tab){activateWorkspaceTab(tab.dataset.workspaceTab);return;}
 const close=e.target.closest('[data-close-workspace-tab]');if(close){closeWorkspaceTab(close.dataset.closeWorkspaceTab);return;}
 if(!e.target.closest('.workspace-menu summary'))$$('.workspace-menu[open]').forEach(menu=>menu.open=false);
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape')$$('.workspace-menu[open]').forEach(menu=>menu.open=false);
 const target=e.target.closest?.('[role="tab"][data-workspace-tab]');if(!target)return;
 const index=workspaceTabs.findIndex(t=>t.id===target.dataset.workspaceTab);
 let next;
 if(e.key==='ArrowRight')next=(index+1)%workspaceTabs.length;
 if(e.key==='ArrowLeft')next=(index-1+workspaceTabs.length)%workspaceTabs.length;
 if(e.key==='Home')next=0;
 if(e.key==='End')next=workspaceTabs.length-1;
 if(next!==undefined){e.preventDefault();activateWorkspaceTab(workspaceTabs[next].id);$('#workspace-tab-'+currentTabId)?.focus();}
});
window.addEventListener('beforeunload',()=>persistWorkspace());
