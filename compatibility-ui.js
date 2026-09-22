let pendingCompatibilityRepair=null;
let pendingWorkflowExport=null;
const compatibilityReports=new WeakMap();
function compatibilityReport(tab=currentTab()){
 if(!tab?.graph)return null;
 if(!compatibilityReports.has(tab.graph))compatibilityReports.set(tab.graph,WorkflowCompatibility.analyse(tab.graph,CompatibilityCatalog));
 return compatibilityReports.get(tab.graph);
}
function renderCompatibilityPanel(tab){
 if(tab.kind!=='imported')return '';
 const report=compatibilityReport(tab),query=(tab.compatSearch||'').trim().toLowerCase();
 const filtered=report.issues.filter(issue=>(tab.compatFilter!=='error'||issue.severity==='error')&&(!query||[issue.title,issue.value,issue.nodeId,issue.nodeType,issue.scope,issue.field].join(' ').toLowerCase().includes(query)));
 const stamp=new Date(CompatibilityCatalog.checkedAt).toLocaleString('zh-CN',{hour12:false});
 return `<details class="compatibility-panel" id="compatibility-panel" ${tab.compatOpen===false?'':'open'}><summary><span class="compat-title">${icon(report.issues.length?'info':'check')} 导入检查</span><span class="compat-count ${report.errors?'has-errors':''}">${report.errors} 项待修正</span><span class="compat-count">${report.reviews} 项待核实</span>${icon('down')}</summary><div class="compatibility-body"><div class="compat-overview"><p>已检查 ${report.nodeCount} 个节点、${report.checkedModels} 处模型引用（含子图）。</p><div class="inline-actions">${button('重新检查引用','recheck-compatibility','small','refresh')}${tab.repairHistory?.length?button('撤销上次修复','undo-model-repair','small','refresh'):''}${button('导出 JSON 副本','export-workflow-json','small','download')}</div></div><p class="compat-source">${icon('clock')} 本机清单快照 · ${esc(stamp)} · 未验证服务加载、显存和实际运行</p>${tab.repairHistory?.length?`<p class="compat-applied">${icon('check')} 已在当前工作副本应用 ${tab.repairHistory.length} 次修复，原文件保持不变。</p>`:''}${report.issues.length?`<div class="compat-filters"><label class="search-field">${icon('search')}<input id="compat-search" aria-label="搜索导入问题" placeholder="搜索节点、模型名称…" value="${esc(tab.compatSearch||'')}"></label><button class="chip ${tab.compatFilter!=='error'?'active':''}" data-compat-filter="all">全部</button><button class="chip ${tab.compatFilter==='error'?'active':''}" data-compat-filter="error">待修正</button><small>${filtered.length} 项</small></div><div class="compat-issues">${filtered.slice(0,60).map(issue=>renderCompatibilityIssue(issue,report.issues.indexOf(issue))).join('')}${!filtered.length?'<p class="compat-empty">没有匹配的问题，试试其它名称或切换筛选。</p>':''}${filtered.length>60?'<p class="compat-empty">当前显示前 60 项，请搜索节点或模型缩小范围。</p>':''}</div>`:`<div class="compat-clear">${icon('check')} 静态检查未发现已知问题。${report.checkedModels?'仍需在 ComfyUI 中验证实际运行。':'此工作流没有识别到需要检查的模型引用。'}</div>`}</div></details>`;
}
function renderCompatibilityIssue(issue,index){
 return `<article class="compat-issue ${issue.severity==='error'?'error':'review'}"><div class="compat-issue-head"><span class="compat-severity">${issue.severity==='error'?'待修正':'待核实'}</span><h3>${esc(issue.title)}</h3>${issue.nodePath?`<button class="text-button" data-locate-issue="${index}">${icon('search')} 定位节点</button>`:''}</div><p class="compat-location">${esc(issue.scope)}${issue.nodeId?` · 节点 #${esc(issue.nodeId)} · ${esc(issue.nodeType)}`:''}${issue.field?` · ${esc(issue.field)}`:''}</p>${issue.value?`<code class="compat-model-value">${esc(issue.value)}</code>`:''}<p>${esc(issue.reason)}</p><p class="compat-advice">${esc(issue.advice||'')}</p>${issue.candidates.length?`<div class="compat-candidates">${issue.candidates.map((candidate,candidateIndex)=>`<div class="compat-candidate"><div><span class="mini-pill">${esc(candidate.label)}</span><strong>${esc(candidate.value)}</strong><small>${esc(candidate.folder)} · ${esc(candidate.evidence)}</small><p>${esc(candidate.reason)}</p></div>${candidate.canApply?`<button class="btn small" data-repair-issue="${index}" data-repair-candidate="${candidateIndex}">预览替换 ${icon('arrow')}</button>`:'<span class="compat-manual">需手动调整</span>'}</div>`).join('')}</div>`:`<p class="compat-no-match">未找到可以可靠直接替换的本机选项。</p>`}<div class="compat-issue-foot">${issue.path?`<code title="JSON 参数路径">${esc(WorkflowCompatibility.pointer(issue.path))}</code>`:'<span>需核对节点接口与依赖</span>'}<button class="text-button" data-compat-resources="${index}">查看本地资源 ${icon('arrow')}</button></div></article>`;
}
function previewCompatibilityRepair(issueIndex,candidateIndex){
 const tab=currentTab(),issue=compatibilityReport(tab)?.issues[issueIndex],candidate=issue?.candidates[candidateIndex];
 if(!candidate)return;
 try{
  const plan=WorkflowCompatibility.plan(tab.graph,CompatibilityCatalog,issue.key,candidate.id);
  pendingCompatibilityRepair={tabId:tab.id,issueKey:issue.key,candidateId:candidate.id,plan};
  modal('替换模型引用',`<p>${esc(plan.scope)} · 节点 #${esc(plan.nodeId)} · ${esc(plan.field)}</p><div class="repair-diff"><div><small>当前引用</small><code>${esc(plan.before)}</code></div><span>${icon('arrow')}</span><div><small>替换为</small><code>${esc(plan.after)}</code></div></div><p>${esc(plan.reason)}</p><p class="subtext spaced">只修改当前工作副本的这一处引用，保留连线、提示词和其它参数。应用后可撤销。</p><div class="modal-actions">${button('取消','close')}${button('应用到当前副本','apply-model-repair','primary','check')}</div>`);
 }catch(error){toast(error.message);}
}
function applyCompatibilityRepair(){
 const pending=pendingCompatibilityRepair,tab=workspaceTabs.find(t=>t.id===pending?.tabId);
 if(!tab||tab.id!==currentTabId){toast('工作副本已切换，请重新选择替换项。');return;}
 try{
  const plan=WorkflowCompatibility.plan(tab.graph,CompatibilityCatalog,pending.issueKey,pending.candidateId);
  if(plan.before!==pending.plan.before||plan.after!==pending.plan.after)throw new Error('建议已变化，请重新预览替换。');
  tab.graph=WorkflowCompatibility.patch(tab.graph,plan.path,plan.before,plan.after);
  tab.repairHistory=[...(tab.repairHistory||[]),plan].slice(-30);tab.compatOpen=true;
  pendingCompatibilityRepair=null;closeOverlay({restoreFocus:false});render();
  toast('模型引用已替换并重新检查；运行兼容性仍需验证。');
 }catch(error){toast(error.message);}
}
function undoCompatibilityRepair(){
 const tab=currentTab(),plan=tab?.repairHistory?.at(-1);if(!plan)return;
 try{tab.graph=WorkflowCompatibility.patch(tab.graph,plan.path,plan.after,plan.before);tab.repairHistory.pop();render();toast('已撤销上次模型引用修复。');}catch(error){toast(error.message);}
}
function locateCompatibilityIssue(index){
 const tab=currentTab(),issue=compatibilityReport(tab)?.issues[index];if(!issue?.nodePath)return;
 const entry=WorkflowCompatibility.collect(tab.graph).nodes.find(node=>WorkflowCompatibility.pointer(node.path)===WorkflowCompatibility.pointer(issue.nodePath));
 if(!entry)return;
 const viewPath=entry.format==='ui'?entry.path.slice(0,-2):[];
 let graph;
 try{graph=WorkflowImport.describe(WorkflowCompatibility.at(tab.graph,viewPath));}catch(error){toast(`无法显示该子图：${error.message}`);return;}
 tab.graphViewPath=viewPath;tab.focusNodeId=entry.id;tab.mode='canvas';state.mode='canvas';state.page='canvas';
 const position=graph.nodes.findIndex(node=>node.id===entry.id);tab.graphPreviewStart=Math.max(0,Math.floor(position/120)*120);
 history.replaceState(null,'','#canvas');render();
 requestAnimationFrame(()=>{$(`[data-import-node="${CSS.escape(entry.id)}"]`)?.scrollIntoView({block:'center',inline:'center',behavior:'smooth'});});
 toast(`${entry.scope} · 已定位节点 #${entry.id}`);
}
function exportWorkflowCopy(){
 const tab=currentTab();if(!tab?.graph)return;
 pendingWorkflowExport={text:JSON.stringify(tab.graph,null,2),name:`${tab.title.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,100)}${tab.repairHistory?.length?'.fixed':''}.json`};
 modal('导出工作流 JSON 副本',`<p>保存为 <strong>${esc(pendingWorkflowExport.name)}</strong>。以下内容包含当前修复，原文件不会被覆盖。</p><label class="field-label spaced" for="workflow-export-json">JSON 内容</label><textarea id="workflow-export-json" readonly spellcheck="false" style="width:100%;height:240px;font:11px/1.6 ui-monospace,monospace">${esc(pendingWorkflowExport.text)}</textarea><p class="subtext spaced">如果浏览器没有弹出下载，可以复制 JSON，在文本编辑器中另存为 .json 文件。</p><div class="modal-actions">${button('关闭','close')}${button('复制 JSON','copy-workflow-json','','copy')}${button('下载文件','download-workflow-json','primary','download')}</div>`);
}
function downloadWorkflowCopy(){
 if(!pendingWorkflowExport)return;
 const url=URL.createObjectURL(new Blob([pendingWorkflowExport.text],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=pendingWorkflowExport.name;
 document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
 toast('已请求浏览器下载 JSON 副本，原文件未修改。');
}
async function copyWorkflowJSON(){
 if(!pendingWorkflowExport)return;
 try{await navigator.clipboard.writeText(pendingWorkflowExport.text);toast('已复制当前 JSON 副本。');}
 catch{const text=$('#workflow-export-json');text?.focus();text?.select();toast('已选中 JSON，请按 Ctrl+C 复制。');}
}
function bindCompatibilityActions(){
 Object.assign(actions,{
  'apply-model-repair':applyCompatibilityRepair,'undo-model-repair':undoCompatibilityRepair,'export-workflow-json':exportWorkflowCopy,
  'download-workflow-json':downloadWorkflowCopy,'copy-workflow-json':copyWorkflowJSON,
  'recheck-compatibility':()=>{const tab=currentTab();compatibilityReports.delete(tab.graph);render();toast('已按本机清单快照重新检查引用，未扫描运行服务。');},
  'compat-root-canvas':()=>{const tab=currentTab();tab.graphViewPath=[];tab.graphPreviewStart=0;tab.focusNodeId=null;render();}
 });
 document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.repairIssue!==undefined)previewCompatibilityRepair(Number(target.dataset.repairIssue),Number(target.dataset.repairCandidate));
  if(target.dataset.locateIssue!==undefined)locateCompatibilityIssue(Number(target.dataset.locateIssue));
  if(target.dataset.compatFilter){currentTab().compatFilter=target.dataset.compatFilter;render();}
  if(target.dataset.compatResources!==undefined){const issue=compatibilityReport()?.issues[Number(target.dataset.compatResources)];state.resourceCategory={diffusion:'主图像模型',encoder:'文本编码器',vae:'VAE',lora:'LoRA',language:'语言模型'}[issue?.role]||'全部资源';state.resourceTab='local';state.resourceSearch='';navigate('resources');}
 });
 document.addEventListener('input',event=>{if(event.target.id==='compat-search'){currentTab().compatSearch=event.target.value;filterRender('compat-search');}});
 document.addEventListener('toggle',event=>{if(event.target.id==='compatibility-panel'&&event.target.isConnected&&currentTab()?.kind==='imported'){currentTab().compatOpen=event.target.open;persistWorkspace();}},true);
}
