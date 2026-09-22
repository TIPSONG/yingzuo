'use strict';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const asset = name => `assets/${name}.png`;
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`yingzuo-alpha-${key}`)) ?? fallback; } catch { return fallback; } };
const save = (key,value) => { try { localStorage.setItem(`yingzuo-alpha-${key}`,JSON.stringify(value)); return true; } catch { return false; } };
const pages = [
 {id:'home',name:'开始',icon:'home'}, {id:'create',name:'创作',icon:'create'}, {id:'canvas',name:'节点画布',icon:'workflow'},
 {id:'workflows',name:'工作流库',icon:'workflow'}, {id:'resources',name:'资源管理',icon:'box'},
 {id:'gallery',name:'作品库',icon:'gallery'}, {id:'board',name:'收藏板',icon:'heart'}
];
const workflows = [
 {id:'text',name:'文生图',desc:'从一段描述出发，让想象成为画面。',type:'文生图',file:'editorial',model:'Qwen Image 2.1',tags:['Q6_K','文生图'],icon:'create'},
 {id:'edit',name:'多图参考编辑',desc:'保留人物，参考衣服、姿势与画风。',type:'图像编辑',file:'denim-edit',model:'Qwen Image 2.1',tags:['多图参考','图像编辑'],icon:'gallery'},
 {id:'gemma-text',name:'Gemma 润色 · 文生图',desc:'先把想法说清楚，再交给 Qwen 出图。',type:'Gemma 润色',file:'watercolor-cat',model:'Gemma + Qwen',tags:['Gemma 4','文生图'],icon:'sparkles'},
 {id:'gemma-edit',name:'Gemma 润色 · 多图编辑',desc:'用自然语言描述，结合参考图优化指令。',type:'Gemma 润色',file:'portrait',model:'Gemma + Qwen',tags:['Gemma 4','图像编辑'],icon:'sparkles'},
 {id:'prompt',name:'单独润色提示词',desc:'把随手写的灵感，整理成可编辑的提示词。',type:'Gemma 润色',file:null,model:'Gemma 4 12B',tags:['提示词','LM Studio'],icon:'sparkles'}
];
const pictures = [
 {id:'editorial',name:'青柠色的时尚拼贴',file:'editorial',workflow:'文生图',workflowId:'text',size:'1024 × 1024',format:'PNG',date:'已有作品',prompt:'黑白时尚人像、青柠色背景与抽象拼贴。',path:'D:\\agent\\ComfyUI\\output\\Qwen21_Verified\\TextToImage_00001.png',kind:'作品'},
 {id:'cat',name:'窗边的午后',file:'watercolor-cat',workflow:'Gemma 润色 · 文生图',workflowId:'gemma-text',size:'512 × 512',format:'PNG',date:'已有作品',prompt:'一只橘猫坐在窗台上，窗外有柔和的光。水彩插画，保留纸张质感。',path:'D:\\agent\\ComfyUI\\output\\Qwen_Gemma\\Text_to_Image_00002.png',kind:'作品'},
 {id:'denim',name:'浅蓝牛仔 · 换装',file:'denim-edit',workflow:'多图参考编辑',workflowId:'edit',size:'896 × 1152',format:'PNG',date:'已有作品',prompt:'保持人物的面部、姿势和背景不变，将服装替换为参考图中的浅蓝色牛仔衬衫。',path:'D:\\agent\\ComfyUI\\output\\Qwen21_Verified\\Edit_00001.png',kind:'作品'},
 {id:'portrait',name:'人物参考',file:'portrait',workflow:'参考素材',workflowId:'edit',size:'原始参考图',format:'PNG',date:'参考素材',prompt:'人物原图，用于多图参考编辑。',path:'D:\\agent\\ComfyUI\\input\\portrait_model_denim.png',kind:'参考'},
 {id:'shirt',name:'浅蓝牛仔衬衫',file:'shirt',workflow:'参考素材',workflowId:'edit',size:'原始参考图',format:'PNG',date:'参考素材',prompt:'服装参考图。',path:'D:\\agent\\ComfyUI\\input\\clothing_light_blue_denim_shirt.png',kind:'参考'}
];
const resources = [
 {id:'qwen',name:'qwen-image-2.1-Q6_K.gguf',kind:'主图像模型',detail:'Qwen Image 2.1 · 图像生成 / 编辑',size:'5.88 GB',icon:'box',tone:'',path:'ComfyUI/models/diffusion_models',format:'GGUF · Q6_K'},
 {id:'encoder',name:'qwen3vl_8b_int8_convrot.safetensors',kind:'文本编码器',detail:'Qwen3 VL 8B · 提示词与参考图编码',size:'9.35 GB',icon:'code',tone:'lilac',path:'ComfyUI/models/text_encoders',format:'Safetensors · INT8'},
 {id:'vae',name:'qwen_image_2.1_vae_bf16.safetensors',kind:'VAE',detail:'Qwen Image 2.1 · 图像解码',size:'675 MB',icon:'gallery',tone:'blue',path:'ComfyUI/models/vae',format:'Safetensors · BF16'},
 {id:'gemma',name:'Gemma 4 12B · HauhauCS Balanced',kind:'语言模型',detail:'LM Studio · 自然语言与提示词润色',size:'约 7.56 GB',icon:'sparkles',tone:'lilac',path:'LM Studio 已有模型目录',format:'GGUF · Q4_K_M'},
 {id:'gguf',name:'ComfyUI-GGUF',kind:'插件',detail:'leejet/ComfyUI-GGUF · 图像 GGUF 加载器',size:'自定义节点',icon:'workflow',tone:'',path:'ComfyUI/custom_nodes/ComfyUI-GGUF',format:'自定义节点'},
 {id:'lmnode',name:'LM Studio Prompt Enhancer',kind:'插件',detail:'提示词润色节点 · 含本地显存管理修改',size:'自定义节点',icon:'sparkles',tone:'blue',path:'ComfyUI/custom_nodes/comfyui-lmstudio-prompt-enhancer',format:'自定义节点 · 本地修改'}
];
let drafts = load('drafts',{});
let favorites = new Set(load('favorites',['cat','portrait','shirt']));
let workflowFavorites = new Set(load('workflow-favorites',['gemma-text','edit']));
let state = { page:'home', workflow:load('workflow','gemma-text'), mode:load('editor-mode','form'), flowTab:'local', flowFilter:'全部',flowSearch:'', resourceTab:'local', resourceCategory:'全部资源', resourceSearch:'', source:'Hugging Face', galleryFilter:'全部', gallerySearch:'', settingTab:'外观与布局', theme:load('theme','green'), density:load('density','comfortable'), tasks:[], queueOpen:false, advanced:false, batch:false, batchCount:1, refs:[], uploaded:[], lastResult:null };
if(!workflows.some(w=>w.id===state.workflow)) state.workflow='gemma-text';
let lastFocused = null;
const currentWorkflow = () => workflows.find(w=>w.id===state.workflow);
const isEdit = () => state.workflow.includes('edit');
const isGemma = () => state.workflow.includes('gemma') || state.workflow==='prompt';
const findPicture = id => [...pictures,...state.uploaded].find(p=>p.id===id);
function getDraft(){
 return currentTab()?.draft || defaultWorkflowDraft(state.workflow);
}
function persistDraft(){persistWorkspace();}
function button(text, action, cls='', glyph){return `<button class="btn ${cls}" data-action="${action}">${glyph?icon(glyph):''}${text}</button>`;}
function pageIntro(eyebrow,title,desc,actions=''){return `<div class="page-intro"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div>${actions?`<div class="intro-actions">${actions}</div>`:''}</div>`;}
function imageUrl(p){return p.url || asset(p.file);}
function pictureCard(p){return `<article class="work-card"><button class="work-picture" data-view="${p.id}" aria-label="查看 ${esc(p.name)}"><img src="${imageUrl(p)}" alt="${esc(p.name)}" loading="lazy"><span class="image-overlay"></span><span class="image-badge">${esc(p.kind==='参考'?'参考图':p.workflow)}</span></button><div class="work-card-footer"><div><strong>${esc(p.name)}</strong><small>${esc(p.size)} · ${p.format}</small></div><button class="icon-button ${favorites.has(p.id)?'selected':''}" data-favorite="${p.id}" aria-label="${favorites.has(p.id)?'取消收藏':'收藏'} ${esc(p.name)}" aria-pressed="${favorites.has(p.id)}">${icon('heart')}</button></div></article>`;}
function renderShell(){
 $('#nav').innerHTML=pages.map(p=>`${p.id==='gallery'?'<div class="nav-divider"></div>':''}<button class="nav-link ${state.page===p.id?'active':''}" data-page="${p.id}" aria-label="${p.name}" ${state.page===p.id?'aria-current="page"':''}>${icon(p.icon)}<span>${p.name}</span>${p.id==='workflows'?'<span class="nav-index">05</span>':''}</button>`).join('');
 $('#settings-nav').innerHTML=icon('settings')+'<span>设置与维护</span>';
 $('#settings-nav').classList.toggle('active',state.page==='settings');
 $('#search-icon').innerHTML=icon('search'); $('#queue-icon').innerHTML=icon('queue');
 $('#breadcrumb').textContent=pages.find(p=>p.id===state.page)?.name || '设置与维护';
 document.body.classList.toggle('theme-cool',state.theme==='cool'); document.body.classList.toggle('density-compact',state.density==='compact');
 updateQueueBadge();
}
function renderCanvasControls(){
 const tab=currentTab(),custom=isCustomWorkspaceTab(tab),prompt=state.workflow==='prompt';
 const empty=custom&&!WorkflowImport.describe(tab.graph).nodes.length;
 const hint=custom?(empty?'暂无节点，添加节点后运行':'等待 ComfyUI 接入后运行'):(prompt?'润色预览 · 不调用模型':'A 测演示 · 不调用绘图模型');
 return `<div class="canvas-controls"><div class="canvas-run-group"><button class="btn primary canvas-run-button" data-action="${prompt?'enhance':'generate'}" aria-label="${prompt?'运行润色（演示）':'运行工作流（演示）'}" title="${custom?hint:'运行当前工作流 · Ctrl + Enter'}" ${custom?'disabled':''}>${icon('play')}${prompt?'运行润色':'运行'}${!custom&&state.batch&&!prompt?`<small>× ${state.batchCount}</small>`:''}</button><span id="canvas-run-status">${hint}</span></div><div class="inline-actions"><button class="icon-button outlined" data-action="canvas-zoom-out" aria-label="缩小画布">−</button><span class="mono" id="canvas-zoom-label">100%</span><button class="icon-button outlined" data-action="canvas-zoom-in" aria-label="放大画布">+</button><button class="btn small" data-action="canvas-zoom-reset">重置视图</button></div></div>`;
}
function render(){
 persistWorkspace();renderShell();
 const views={home:renderHome,create:renderCreate,canvas:renderCreate,workflows:renderWorkflows,resources:renderResources,gallery:renderGallery,board:renderBoard,settings:renderSettings};
 const editor=isEditorPage();
 $('#main').innerHTML=(editor?renderWorkspaceChrome():'')+`<div ${editor?'id="workflow-tab-panel" role="tabpanel"':''}>${(views[state.page] || renderHome)()}</div>`;
 if(editor&&workspaceStorageWarning)$('#workflow-tab-panel').insertAdjacentHTML('afterbegin',`<div class="notice" role="alert">${icon('info')} 浏览器存储不可用或已满，最新草稿仅在本次会话保留。请保留原 JSON 文件。</div>`);
 $('#main').dataset.tabId=currentTabId || '';
 document.body.classList.toggle('canvas-page',state.page==='canvas');
 if(state.page==='canvas'){
  const board=$('.canvas-board');
  if(board){
   board.insertAdjacentHTML('beforebegin',renderCanvasControls());
   const zoom=currentTab()?.zoom || 1;$('.graph-inner').style.zoom=zoom;$('.graph-inner').dataset.zoom=zoom;$('#canvas-zoom-label').textContent=`${Math.round(zoom*100)}%`;
  }
 }
 if(editor)updateRunningOverlay();
}
function navigate(page){
 if(![...pages.map(p=>p.id),'settings'].includes(page)) page='home';
 const nextMode=page==='canvas'?'canvas':page==='create'?'form':state.mode;
 closeOverlay({restoreFocus:false});
 // Re-selecting the current destination must not destroy focused controls.
 if(state.page===page && state.mode===nextMode)return;
 if(page==='canvas'||page==='create'){state.mode=nextMode;save('editor-mode',state.mode);}
 state.page=page;history.replaceState(null,'',`#${page}`);render();window.scrollTo({top:0,behavior:'instant'});
}
function openWorkflow(id){openWorkspaceWorkflow(id);}
function renderHome(){
 return `${pageIntro('YOUR CREATIVE SPACE','让想法，有画面。','从一个灵感开始，或接着上次的创作。',button('工作流库','open-workflows','subtle','workflow')+button('新建创作','new-create','primary','plus'))}
 <div class="creation-entry"><button data-mode="form">${icon('sliders')}<span><strong>简洁创作</strong><small>提示词、参考图与常用参数</small></span>${icon('arrow')}</button><button data-page="canvas">${icon('workflow')}<span><strong>节点画布</strong><small>查看节点结构，保留完整画布模式</small></span>${icon('arrow')}</button></div>
 <div class="feature-grid"><section class="hero"><div class="hero-copy"><span class="hero-tag">${icon('bolt')} QWEN IMAGE 2.1</span><h2>下一张作品，<br>由你定义。</h2><p>写下画面，交给想象。<br>简洁表单与节点画布，自由切换。</p><button class="btn primary" data-workflow="text">从文字开始 ${icon('arrow')}</button></div><div class="hero-art"><img src="${asset('editorial')}" alt="青柠色背景的黑白时尚拼贴作品"><span class="art-corner">MADE WITH QWEN / 001</span></div></section>
 <div class="quick-stack"><button class="quick-card" data-workflow="edit"><span class="ref-mini"><img src="${asset('portrait')}" alt="人物参考"><img src="${asset('shirt')}" alt="服装参考"></span><span><h3>让参考图说话</h3><p>多图编辑 · 人物、服装与画风</p></span>${icon('arrowUp','go')}</button><button class="quick-card" data-workflow="gemma-text"><span class="quick-symbol">${icon('sparkles')}</span><span><h3>灵感，交给 Gemma 整理</h3><p>自然语言 → 画面提示词 → 生成</p></span>${icon('arrowUp','go')}</button></div></div>
 <div class="section-head"><div class="section-title"><h2>常用工作流</h2><span>为你的本地环境准备</span></div><button class="text-button" data-page="workflows">全部 5 个 ${icon('arrow')}</button></div>
 <div class="workflow-strip">${[workflows[2],workflows[1],workflows[4]].map(w=>`<button class="strip-card" data-workflow="${w.id}"><span class="strip-icon">${icon(w.icon)}</span><span><strong>${w.name}</strong><small>${w.model} · 工作副本</small></span>${icon('chevron')}</button>`).join('')}</div>
 <div class="section-head"><div class="section-title"><h2>最近作品</h2><span>回到灵感发生的地方</span></div><button class="text-button" data-page="gallery">打开作品库 ${icon('arrow')}</button></div>
 <div class="works-grid">${[pictures[1],pictures[2],pictures[0],pictures[3]].map(pictureCard).join('')}</div>
 <p class="home-note">${icon('info')} 展示图片来自现有本地作品与参考图；服务状态和生成操作为界面演示。</p>`;
}
function renderCreate(){
 if(!currentTab())return renderEmptyWorkspace();
 if(isCustomWorkspaceTab(currentTab()))return renderCustomWorkflow();
 const w=currentWorkflow(),d=getDraft();
 if(w.id==='prompt')return renderPromptStudio(d);
 const p=state.lastResult || (isEdit()?pictures[2]:state.workflow==='text'?pictures[0]:pictures[1]);
 return `${renderWorkspaceHeader(w)}
 ${state.mode==='canvas'?renderCanvas():`<div class="editor-layout"><section class="form-panel" aria-label="生成参数">
 <div class="form-section"><label class="field-label" for="prompt"><span>画面描述</span><small>你的想法，用自然语言表达</small></label><textarea id="prompt" class="prompt-text" data-draft="prompt" placeholder="描述你想要的画面…">${esc(d.prompt)}</textarea><div class="enhance-row"><button class="btn small" data-action="enhance">${icon('sparkles')} Gemma 润色</button><label class="toggle-line">自动润色<button class="switch ${d.autoEnhance?'on':''}" data-action="auto-enhance" role="switch" aria-checked="${d.autoEnhance}" aria-label="自动润色"></button></label></div></div>
 ${isEdit()?`<div class="form-section"><div class="field-label"><span>参考图片</span><small>人物与服装</small></div><div class="ref-inputs">${(state.refs.length?state.refs:[asset('portrait'),asset('shirt')]).slice(0,2).map((url,i)=>`<button class="ref-input" data-action="upload-ref" data-reference-slot="${i}" aria-label="替换参考图 ${i+1}"><img src="${url}" alt="参考图 ${i+1}"><small>图 ${i+1} · ${i===0?'人物':'服装'}</small></button>`).join('')}<button class="ref-input" data-action="board-picker" aria-label="从收藏板选择参考图">${icon('plus')}<small>从收藏板选</small></button></div><p class="ref-hint">${isGemma()?'当前 Gemma 润色节点最多读取 2 张参考图。':'在指令中用“图 1”“图 2”说明各自的用途。'}</p></div>`:''}
 <div class="form-section"><div class="field-label"><span>画面比例</span><small>输出尺寸</small></div><div class="ratio-select">${['1:1','3:4','16:9'].map(r=>`<button class="ratio-btn ${d.ratio===r?'active':''}" data-ratio="${r}"><span class="ratio-shape"></span>${r}</button>`).join('')}</div><div class="form-grid"><label><span class="field-label">分辨率</span><select data-draft="resolution" aria-label="分辨率">${['1024','768','512'].map(n=>`<option ${String(d.resolution||1024)===n?'selected':''} value="${n}">${n} px</option>`).join('')}</select></label><label><span class="field-label">步数</span><input data-draft="steps" type="number" min="1" max="100" value="${d.steps}" aria-label="步数"></label></div></div>
 <div class="form-section"><div class="field-label"><span>当前模型</span><button class="text-button" data-page="resources">管理 ${icon('arrowUp')}</button></div><div class="model-line">${icon('box')}<span>${state.workflow==='prompt'?'Gemma 4 12B':'Qwen Image 2.1'}</span><small>${state.workflow==='prompt'?'Q4_K_M':'Q6_K'}</small></div>${isGemma()?'<p class="ref-hint">Gemma 4 12B · 通过 LM Studio 润色</p>':''}</div>
 <div class="form-section"><button class="advanced-toggle" data-action="advanced">高级参数 ${icon(state.advanced?'down':'chevron')}</button>${state.advanced?`<div class="advanced-fields"><label class="field-label" for="negative">负面提示词</label><textarea id="negative" data-draft="negative" rows="2" placeholder="不希望出现的内容">${esc(d.negative)}</textarea><div class="form-grid spaced"><label><span class="field-label">种子</span><input data-draft="seed" value="${esc(d.seed)}"></label><label><span class="field-label">CFG</span><input type="number" min="1" max="20" step="0.1" data-draft="cfg" value="${d.cfg||1}"></label></div></div>`:''}<div class="enhance-row spaced"><span class="toggle-line">批量任务</span><button class="switch ${state.batch?'on':''}" data-action="batch" role="switch" aria-label="批量任务" aria-checked="${state.batch}"></button></div>${state.batch?`<div class="batch-options"><label>生成数量<input type="number" id="batch-count" value="${state.batchCount}" min="1" max="8"></label><p>将创建 ${state.batchCount} 个演示任务，依次执行。</p></div>`:''}</div>
 <button class="btn primary generate" data-action="${state.workflow==='prompt'?'enhance':'generate'}">${icon(state.workflow==='prompt'?'sparkles':'play')}${state.workflow==='prompt'?'预览润色':'加入演示队列'}<small>${state.batch?`${state.batchCount} 个任务`:'Ctrl ↵'}</small></button><p class="form-footnote">A 测演示 · 不调用本地模型</p></section>
 <section class="preview-column" aria-label="图片预览"><div class="preview-toolbar"><strong>画面预览</strong><span>${p.size} <span class="status-separator">·</span> ${p.format}</span></div><div class="preview-stage ${isEdit()?'portrait':''}" id="preview-stage"><img src="${imageUrl(p)}" alt="${esc(p.name)}"><span class="stage-label">${state.lastResult?'DEMO RESULT / 示例结果':'LOCAL ARTWORK / 已有作品'}</span><span class="stage-zoom">适合窗口 <button class="icon-button" data-view="${p.id}" aria-label="放大图片">${icon('expand')}</button></span></div><div class="result-actions"><div class="result-caption"><strong>${esc(p.name)}</strong><small>${state.lastResult?'模拟任务完成 · 使用已有图片演示结果':'已有作品预览 · 修改参数不会重绘图片'}</small></div><div class="inline-actions"><button class="icon-button outlined ${favorites.has(p.id)?'selected':''}" data-favorite="${p.id}" aria-label="收藏预览图片">${icon('heart')}</button><button class="btn small" data-export="${p.id}">${icon('download')} 导出</button></div></div><dl class="result-info"><div><dt>工作流</dt><dd>${w.name}</dd></div><div><dt>模型</dt><dd>${w.model}</dd></div><div><dt>执行方式</dt><dd>串行队列</dd></div><div><dt>预览状态</dt><dd>未连接绘图服务</dd></div></dl></section></div>`}`;
}
function renderCanvas(){
 const d=getDraft();
 return `<div class="canvas-board"><div class="canvas-header"><span>工作流结构 · A 测示意</span><span>共享当前提示词草稿</span></div><div class="graph-inner"><svg class="graph-connections" viewBox="0 0 870 460" aria-hidden="true"><path d="M185 58C245 58 230 240 290 240M185 265C235 265 240 95 290 95M470 95C530 95 515 205 565 205M470 275C520 275 530 240 565 240M745 240C820 240 790 380 710 380" fill="none" stroke="#859e67" stroke-width="2"/><path d="M185 265C225 265 240 335 290 335" fill="none" stroke="#c4a286" stroke-width="1.5"/></svg><div class="graph-node" style="left:5px;top:25px"><h3>${icon('box')} 主模型加载</h3><div class="graph-node-content"><div class="node-chip">qwen-image-2.1-Q6_K.gguf</div>图像模型 · GGUF</div></div><div class="graph-node" style="left:5px;top:197px"><h3>${icon('create')} 画面描述</h3><div class="graph-node-content"><textarea aria-label="画布提示词" data-draft="prompt">${esc(d.prompt)}</textarea></div></div><div class="graph-node" style="left:290px;top:62px"><h3>${icon('sparkles')} ${isGemma()?'Gemma 润色':'文本编码'}</h3><div class="graph-node-content"><div class="node-chip">${isGemma()?'LM Studio · Gemma 4 12B':'Qwen3 VL 8B'}</div>提示词 → 画面条件</div></div><div class="graph-node" style="left:290px;top:225px"><h3>${icon('sliders')} 采样参数</h3><div class="graph-node-content"><div class="node-chip">steps · ${d.steps}</div><div class="node-chip">ratio · ${d.ratio}</div><div class="node-chip">sampler · euler</div></div></div><div class="graph-node node-image" style="left:565px;top:150px"><h3>${icon('gallery')} 生成与保存</h3><img src="${asset(isEdit()?'denim-edit':state.workflow==='text'?'editorial':'watercolor-cat')}" alt="工作流输出示意"><div class="graph-node-content">预览使用已有作品</div></div></div></div><div class="result-actions"><p class="canvas-notice">${icon('info')} 此画布用于布局评审；正式版将嵌入 ComfyUI。这里修改提示词会同步到简洁表单。</p>${button('返回简洁表单','back-form','','sliders')}</div>`;
}
function renderPromptStudio(d){
 const output=d.enhanced || '润色结果会显示在这里。\n\n先写下你的画面想法，再点击“预览润色”。你可以在应用之前编辑结果。';
 return `${renderWorkspaceHeader(currentWorkflow())}${state.mode==='canvas'?`<div class="canvas-board"><div class="canvas-header"><span>提示词工作流结构 · A 测示意</span><span>自然语言 → 润色 → 文本预览</span></div><div class="graph-inner"><svg class="graph-connections" viewBox="0 0 870 460" aria-hidden="true"><path d="M185 170C240 170 230 130 290 130M470 130C530 130 530 170 570 170" fill="none" stroke="#9ab77a" stroke-width="2"/></svg><div class="graph-node" style="left:5px;top:110px"><h3>${icon('create')} 自然语言描述</h3><div class="graph-node-content"><textarea data-draft="prompt" aria-label="画布提示词">${esc(d.prompt)}</textarea></div></div><div class="graph-node" style="left:290px;top:80px"><h3>${icon('sparkles')} Gemma 润色</h3><div class="graph-node-content"><div class="node-chip">LM Studio · Gemma 4 12B</div><div class="node-chip">上下文 · 8192</div>纯文本工作流，不加载 Qwen 图像模型</div></div><div class="graph-node" style="left:570px;top:110px;width:230px"><h3>${icon('code')} 润色结果</h3><div class="graph-node-content" style="white-space:pre-wrap">${esc(output)}</div></div></div></div><p class="canvas-notice">${icon('info')} 结构示意；正式版将嵌入对应的 ComfyUI 工作流。</p>`:`<div class="editor-layout"><section class="form-panel"><label class="field-label" for="prompt"><span>画面描述</span><small>用自然语言表达</small></label><textarea id="prompt" class="prompt-text" data-draft="prompt">${esc(d.prompt)}</textarea><div class="form-section spaced"><div class="field-label">润色模型</div><div class="model-line">${icon('sparkles')}<span>Gemma 4 12B</span><small>LM Studio</small></div><p class="ref-hint">整理主体、场景和风格，保留你的原始创作意图。</p></div><button class="btn primary generate" data-action="enhance">${icon('sparkles')} 预览润色</button><p class="form-footnote">A 测使用示意文本，不调用语言模型</p></section><section class="form-panel"><div class="field-label"><span>润色结果</span><small>${d.enhanced?'已应用的演示文本':'等待你的灵感'}</small></div><div class="prompt-output">${esc(output)}</div><p class="ref-hint">此工作流只输出文本。可以先打磨提示词，再复制到其他创作工作流。</p></section></div>`}`;
}
function renderWorkflows(){
 const visible=workflows.filter(w=>(state.flowFilter==='全部'||state.flowFilter==='我的收藏'&&workflowFavorites.has(w.id)||w.type===state.flowFilter)&&`${w.name} ${w.desc} ${w.model}`.toLowerCase().includes(state.flowSearch.toLowerCase()));
 return `${pageIntro('WORKFLOW LIBRARY','每个灵感，都有起点。','从模板开始创作，修改保存在独立工作副本里。',button('导入工作流','import-workflow','','upload')+button('新建模板','new-template','primary','plus'))}<div class="toolbar"><div class="tabs"><button class="tab ${state.flowTab==='local'?'active':''}" data-flow-tab="local">我的工作流 <small>05</small></button><button class="tab ${state.flowTab==='online'?'active':''}" data-flow-tab="online">在线发现</button></div><label class="search-field">${icon('search')}<input id="flow-search" placeholder="搜索名称、模型…" value="${esc(state.flowSearch)}" aria-label="搜索工作流"></label></div>${state.flowTab==='online'?`<div class="notice">${icon('info')} 在线发现为页面预览，尚未连接社区目录。</div><div class="empty-state">${icon('workflow')}<h3>发现更多创作方式</h3><p>正式版可浏览在线模板、检查依赖，并保存到自己的工作流库。</p>${button('预览导入流程','import-workflow','','link')}</div>`:`<div class="filters">${['全部','文生图','图像编辑','Gemma 润色','我的收藏'].map(t=>`<button class="chip ${state.flowFilter===t?'active':''}" data-flow-filter="${t}">${t}</button>`).join('')}<span class="subtext" style="margin-left:auto">${visible.length} 个模板</span></div><div class="library-grid">${visible.map(w=>`<article class="template-card"><div class="template-art ${w.file?'':'gemma-art'}" data-workflow="${w.id}" role="button" tabindex="0" aria-label="打开 ${w.name}">${w.file?`<img src="${asset(w.file)}" alt="${w.name}">`:`${icon('sparkles')}<span>Gemma</span>`}<span class="art-label">${w.file?'LOCAL WORKFLOW':'PROMPT STUDIO'}</span></div><div class="template-content"><h3>${w.name}</h3><p>${w.desc}</p><div class="template-tags">${w.tags.map(t=>`<span>${t}</span>`).join('')}</div><div class="template-footer"><button class="text-button" data-workflow="${w.id}">打开工作副本 ${icon('arrow')}</button><button class="icon-button ${workflowFavorites.has(w.id)?'selected':''}" data-flow-favorite="${w.id}" aria-label="收藏 ${w.name}" aria-pressed="${workflowFavorites.has(w.id)}">${icon('star')}</button></div></div></article>`).join('')}</div>${visible.length?'':'<div class="empty-state"><h3>没有找到匹配的模板</h3><p>试试其他名称或筛选条件。</p></div>'}`}`;
}
function renderResources(){
 const filtered=resources.filter(r=>(state.resourceCategory==='全部资源'||r.kind===state.resourceCategory)&&`${r.name} ${r.detail}`.toLowerCase().includes(state.resourceSearch.toLowerCase()));
 return `${pageIntro('RESOURCE MANAGER','工具就位，专心创作。','模型、LoRA 和插件，各有各的位置。',button('粘贴链接','install-link','','link'))}<div class="toolbar"><div class="tabs">${[['local','本地资源'],['online','在线模型'],['downloads','下载任务']].map(([id,name])=>`<button class="tab ${state.resourceTab===id?'active':''}" data-resource-tab="${id}">${name}</button>`).join('')}</div><label class="search-field">${icon('search')}<input id="resource-search" placeholder="${state.resourceTab==='online'?'搜索界面演示…':'搜索本地资源…'}" value="${esc(state.resourceSearch)}" aria-label="搜索资源"></label></div>
 ${state.resourceTab==='local'?`<div class="resource-layout"><aside class="resource-categories"><div class="resource-section-title">资源类型</div>${['全部资源','主图像模型','LoRA','文本编码器','VAE','语言模型','插件'].map(t=>`<button class="category-item ${state.resourceCategory===t?'active':''}" data-resource-category="${t}">${t}<span>${t==='全部资源'?resources.length:resources.filter(r=>r.kind===t).length}</span></button>`).join('')}</aside><section><div class="notice">${icon('info')} 已有环境的静态清单 · A 测未实时扫描磁盘</div><div class="resource-list">${filtered.map(r=>`<div class="resource-row"><div class="resource-icon ${r.tone}">${icon(r.icon)}</div><div class="resource-name"><strong>${r.name}</strong><small>${r.detail}</small></div><div class="resource-meta"><span class="resource-size">${r.size}</span><span class="pill">已有资源</span><button class="icon-button" data-resource="${r.id}" aria-label="查看 ${r.name}">${icon('chevron')}</button></div></div>`).join('')}</div>${filtered.length?'':'<div class="empty-state"><h3>还没有匹配的资源</h3><p>可从在线模型页或粘贴链接开始。</p></div>'}<p class="home-note">${icon('info')} GGUF 是文件格式；图像模型与语言模型分开管理。</p></section></div>`:state.resourceTab==='online'?`<div class="notice">${icon('info')} 这是模型来源选择预览，尚未发送网络搜索或下载请求。</div><div class="source-choice">${['Hugging Face','Civitai'].map(s=>`<button class="source-card ${state.source===s?'active':''}" data-source="${s}"><div class="source-monogram">${s==='Hugging Face'?'Hf.':'C.'}</div><h3>${s}</h3><p>${s==='Hugging Face'?'模型仓库、量化文件与官方发布':'风格模型、LoRA 与社区作品'}</p><span class="chip">${state.source===s?'当前来源':'选择来源'}</span></button>`).join('')}</div><div class="empty-state">${icon('search')}<h3>${state.resourceSearch?`预览搜索「${esc(state.resourceSearch)}」`:'找到适合你的下一件工具'}</h3><p>正式版将在 ${state.source} 展示模型、版本、体积与下载位置。</p>${button('预览链接安装','install-link','','link')}</div>`:`<div class="empty-state">${icon('download')}<h3>下载队列是空的</h3><p>模型和插件的下载进度会集中显示在这里。</p>${button('浏览在线模型','browse-models','','search')}</div>`}`;
}
function renderGallery(){
 const visible=pictures.filter(p=>p.kind==='作品'&&(state.galleryFilter==='全部'||state.galleryFilter==='我的收藏'&&favorites.has(p.id)||state.galleryFilter==='图像编辑'&&p.workflowId==='edit'||state.galleryFilter==='文生图'&&p.workflowId!=='edit')&&`${p.name} ${p.workflow}`.includes(state.gallerySearch));
 return `${pageIntro('YOUR GALLERY','每次创作，都值得留下。','作品、生成信息和导出，都在这里。',button('输出文件夹','output-folder','','folder'))}<div class="toolbar"><div class="filters">${['全部','文生图','图像编辑','我的收藏'].map(t=>`<button class="chip ${state.galleryFilter===t?'active':''}" data-gallery-filter="${t}">${t}</button>`).join('')}</div><label class="search-field">${icon('search')}<input id="gallery-search" placeholder="搜索作品…" value="${esc(state.gallerySearch)}" aria-label="搜索作品"></label></div><div class="section-head"><div class="section-title"><h2>已有作品</h2><span>${visible.length} 张图片 · 本地展示副本</span></div><span class="mini-pill">大图视图</span></div><div class="gallery-grid">${visible.map(pictureCard).join('')}</div>${visible.length?'':'<div class="empty-state"><h3>这里暂时没有作品</h3><p>换个筛选条件，或先收藏一张喜欢的图片。</p></div>'}<div class="home-note">${icon('info')} 正式版的新作品将按“日期 / 工作流”保存；已有文件保持原位置。</div>`;
}
function renderBoard(){
 const selected=[...pictures,...state.uploaded].filter(p=>favorites.has(p.id));
 return `${pageIntro('INSPIRATION BOARD','把喜欢的，留在手边。','一块简单的收藏板。下一次创作，随时取用。',button('收藏本地图片','upload-board','primary','plus'))}<div class="toolbar"><span class="board-count">${selected.length} 张收藏 <span class="status-separator">·</span> 自动排列</span><button class="text-button" data-page="gallery">从作品库收藏 ${icon('arrow')}</button></div><div class="gallery-grid">${selected.map(pictureCard).join('')}</div>${selected.length?'':'<div class="empty-state">'+icon('heart')+'<h3>收藏你的第一个灵感</h3><p>点击作品旁的爱心，或添加一张本地图片。</p></div>'}<p class="home-note">${icon('info')} A 测收藏保存在此浏览器；新上传图片仅在当前会话展示。</p>`;
}
function renderSettings(){
 const tab=state.settingTab;
 const row=(title,desc,control)=>`<div class="settings-row"><div><strong>${title}</strong><p>${desc}</p></div>${control}</div>`;
 let content='';
 if(tab==='外观与布局')content=`<h2 class="setting-section-head">让工作空间更像你</h2><div class="settings-group"><div style="padding:23px"><h3>强调色</h3><p class="subtext" style="margin-top:6px">同一套布局，两种视觉气质。点击即可切换。</p><div class="theme-options">${[['green','青柠 · 创作室'],['cool','雾紫 · 暗房']].map(([id,name])=>`<button class="theme-option ${state.theme===id?'active':''}" data-theme="${id}"><span class="theme-swatch"><span></span><span></span><span style="background:${id==='green'?'#d1ed87':'#c8c2f3'}"></span></span><small>${name}</small>${state.theme===id?icon('check'):''}</button>`).join('')}</div></div>${row('图片展示密度','切换作品缩略图大小',`<select id="density" aria-label="图片展示密度"><option value="comfortable" ${state.density==='comfortable'?'selected':''}>舒展</option><option value="compact" ${state.density==='compact'?'selected':''}>紧凑</option></select>`)}${row('界面语言','本版预览使用中文','<span class="chip">简体中文</span>')}</div><div class="notice">${icon('info')} “映作”为暂定名称，颜色和布局都可在 A 测评审后调整。</div>`;
 if(tab==='路径与输出')content=`<h2 class="setting-section-head">文件各就各位</h2><div class="settings-group">${row('ComfyUI 目录','沿用已部署环境','<input aria-label="ComfyUI 目录" value="D:\\agent\\ComfyUI" readonly>')}${row('作品输出','已有作品留在原位置','<input aria-label="作品输出目录" value="D:\\agent\\ComfyUI\\output" readonly>')}${row('新作品归档','启动台生成任务的保存规则','<span class="chip">日期 / 工作流</span>')}${row('导出选项','原图与分享副本分别处理','<span class="subtext">每次导出时选择</span>')}</div><div class="notice">${icon('info')} 路径是预览信息；此页面不会移动或修改现有文件。</div>`;
 if(tab==='模型与服务')content=`<h2 class="setting-section-head">按需启动，把显存留给创作</h2><div class="settings-group">${row('ComfyUI','本地绘图服务','<input aria-label="ComfyUI 地址" value="http://127.0.0.1:8188" readonly>')}${row('LM Studio','Gemma 润色接口','<input aria-label="LM Studio 地址" value="http://127.0.0.1:1234/v1" readonly>')}${row('启动方式','打开首页时不加载模型','<span class="chip">选工作流后按需启动</span>')}${row('Gemma 显存协调','润色结束后卸载本次模型实例','<span class="chip">保留现有配置</span>')}</div><div class="notice">${icon('info')} A 测前端不连接或控制以上服务。</div>`;
 if(tab==='下载与账户')content=`<h2 class="setting-section-head">连接你的模型来源</h2><div class="settings-group">${row('Hugging Face','公开资源与需要授权的模型',button('账户设置预览','account-hf','','link'))}${row('Civitai','模型与 LoRA 社区',button('账户设置预览','account-civitai','','link'))}${row('下载位置','根据模型用途自动选择目录','<span class="subtext">下载前可以修改</span>')}</div><div class="notice">${icon('info')} A 测不收集 API Key。正式版将使用系统凭据存储或系统加密。</div>`;
 if(tab==='更新与维护')content=`<div class="update-banner"><div><span class="eyebrow">ENVIRONMENT CARE</span><h3>放心更新，保留退路。</h3><p>由你决定何时更新。先备份，再执行。</p></div>${icon('refresh')}</div><div class="settings-group">${row('ComfyUI','版本状态待正式版连接后检测',button('检查更新','check-update','','refresh'))}${row('自定义节点','更新前检查本地修改',button('查看插件','open-plugins','','box'))}${row('环境备份','代码、插件、配置与受影响的依赖',button('备份方案','backup','','folder'))}${row('关闭窗口','缩到托盘；托盘提供退出并停止服务','<span class="chip">已确认的行为</span>')}</div><div class="notice">${icon('info')} 这里仅展示维护流程；不会执行更新、安装或备份。</div>`;
 return `${pageIntro('MAKE IT YOURS','你的空间，你的习惯。','从配色到环境，集中在一个地方。')}<div class="settings-layout"><aside>${['外观与布局','路径与输出','模型与服务','下载与账户','更新与维护'].map(t=>`<button class="category-item ${tab===t?'active':''}" data-setting-tab="${t}">${t}</button>`).join('')}</aside><section class="settings-section">${content}</section></div>`;
}

function toast(message){
 const el=document.createElement('div');el.className='toast';el.innerHTML=icon('check')+`<span>${esc(message)}</span>`;$('#toast-root').append(el);setTimeout(()=>el.remove(),4000);
}
function showOverlay(content,cls=''){
 lastFocused=document.activeElement;state.queueOpen=false;
 $('#overlay-root').innerHTML=`<div class="overlay ${cls}" data-overlay><div class="${cls==='drawer-overlay'?'drawer':'modal'}" role="dialog" aria-modal="true" aria-label="${cls==='drawer-overlay'?'演示任务队列':'预览对话框'}">${content}</div></div>`;
 document.body.style.overflow='hidden';setTimeout(()=>$('#overlay-root input:not([readonly]),#overlay-root button,#overlay-root textarea')?.focus(),0);
}
function closeOverlay({restoreFocus=true}={}){
 const root=$('#overlay-root'),hadOverlay=root.childElementCount>0,focusTarget=lastFocused;
 root.innerHTML='';state.queueOpen=false;document.body.style.overflow='';lastFocused=null;
 if(hadOverlay&&restoreFocus&&focusTarget?.isConnected)focusTarget.focus({preventScroll:true});
}
function modal(title,body){showOverlay(`<div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div>`);}
function openPicture(id){
 const p=findPicture(id);if(!p)return;
 lastFocused=document.activeElement;state.queueOpen=false;document.body.style.overflow='hidden';
 $('#overlay-root').innerHTML=`<div class="overlay" data-overlay><div class="modal lightbox" role="dialog" aria-modal="true" aria-label="${esc(p.name)}"><div class="lightbox-image"><img src="${imageUrl(p)}" alt="${esc(p.name)}"></div><aside class="lightbox-info"><div class="close-row"><button class="icon-button" data-action="close" aria-label="关闭大图">${icon('close')}</button></div><div class="eyebrow">${p.kind==='参考'?'REFERENCE':'LOCAL ARTWORK'}</div><h2>${esc(p.name)}</h2><span class="subtext">${esc(p.workflow)}</span><dl><div><dt>画面尺寸</dt><dd>${esc(p.size)}</dd></div><div><dt>文件格式</dt><dd>${p.format}</dd></div><div><dt>图片来源</dt><dd>${p.url?'当前会话上传':'本地已有图片的展示副本'}</dd></div></dl><div class="field-label">${p.kind==='参考'?'图片说明':'画面摘要（演示文案）'}</div><p class="prompt-detail">${esc(p.prompt)}</p><small class="muted" style="margin-top:10px">正式版从原始元数据读取参数；此处未解析 seed 等信息。</small><div class="actions-bottom"><button class="btn" data-favorite="${p.id}" data-lightbox="true">${icon('heart')}${favorites.has(p.id)?'已收藏 · 取消收藏':'收藏到板子'}</button><button class="btn primary" data-export="${p.id}">${icon('download')} 导出图片</button><button class="btn subtle" data-use-picture="${p.id}">${icon('arrow')} 带到创作中</button></div></aside></div></div>`;
 setTimeout(()=>$('#overlay-root button')?.focus(),0);
}
function exportDialog(id){
 const p=findPicture(id);if(!p)return;
 modal('导出图片',`<p>${esc(p.name)} · ${p.format}<br>先选择导出用途，原始作品始终保留。</p><div class="settings-group"><div class="settings-row"><div><strong>保留生成信息</strong><p>保留提示词、参数和工作流元数据。</p></div><button class="btn" data-action="demo-export-original">导出原图</button></div><div class="settings-row"><div><strong>分享副本</strong><p>移除生成信息，保留画面与透明通道。</p></div><button class="btn primary" data-action="demo-export-share">导出副本</button></div></div><div class="notice">${icon('info')} A 测仅预览两种选项，不写入或改动任何图片。</div>`);
}
function enhanceDialog(){
 const d=getDraft();if(!d.prompt.trim()){toast('先写一点画面描述，再预览润色。');$('#prompt')?.focus();return;}
 const preview=`${d.prompt.trim()}\n\n${isEdit()?'明确每张参考图的用途，保留未要求修改的人物特征、姿势和背景。':'保持描述中的主体、风格与构图意图，避免添加未要求的元素。'}`;
 modal('Gemma 润色 · 交互预览',`<div class="notice">${icon('info')} 以下是规则拼接的演示文本，并非 Gemma 实际输出。你可以编辑后应用，体验完整流程。</div><label class="field-label" for="enhanced-prompt">润色结果 · 可继续编辑</label><textarea id="enhanced-prompt">${esc(preview)}</textarea><div class="modal-actions">${button('保留原文','close')}${button('应用到画面描述','apply-enhanced','primary','check')}</div>`);
}
function resourceDialog(id){
 const r=resources.find(x=>x.id===id);if(!r)return;
 modal('资源详情',`<div class="resource-row" style="padding:0 0 22px;background:none"><div class="resource-icon ${r.tone}">${icon(r.icon)}</div><div class="resource-name"><strong>${r.name}</strong><small>${r.detail}</small></div></div><div class="settings-group"><div class="settings-row"><span class="subtext">资源用途</span><strong>${r.kind}</strong></div><div class="settings-row"><span class="subtext">格式 / 类型</span><strong>${r.format}</strong></div><div class="settings-row"><span class="subtext">文件体积</span><strong>${r.size}</strong></div></div><label class="field-label">已有位置</label><input class="full-width mono" readonly value="${esc(r.path)}"><p class="subtext spaced">${r.id==='lmnode'?'此插件包含本地修改，正式更新前需要备份。':'本页展示现有环境资料，尚未实时检测文件状态。'}</p><div class="modal-actions">${button('关闭','close')}${r.kind==='插件'?'':`<button class="btn primary" data-workflow="${r.id==='gemma'?'prompt':'text'}">${icon('arrow')} 在工作流中查看</button>`}</div>`);
}
function importDialog(){
 modal('导入工作流 · 流程预览',`<p>粘贴分享链接，正式版会读取模板并检查所需的插件与模型。</p><label class="field-label" for="workflow-link">工作流来源</label><input class="full-width" id="workflow-link" placeholder="https://…"><div class="settings-group spaced"><div class="settings-row"><span class="subtext">01 · 读取工作流</span><span class="mini-pill">解析节点与表单参数</span></div><div class="settings-row"><span class="subtext">02 · 检查依赖</span><span class="mini-pill">模型 / 插件 / 路径</span></div><div class="settings-row"><span class="subtext">03 · 保存模板</span><span class="mini-pill">打开时创建工作副本</span></div></div><div class="modal-actions">${button('关闭','close')}${button('预览依赖检查','dependency-preview','primary','arrow')}</div>`);
}
function linkDialog(){
 modal('从链接安装 · 预览',`<p>支持 Hugging Face、Civitai 模型链接，以及插件 GitHub 地址。</p><label class="field-label" for="install-link">资源链接</label><input id="install-link" class="full-width" placeholder="粘贴资源链接…"><div class="form-grid spaced"><label><span class="field-label">资源类型</span><select id="install-type"><option>主图像模型</option><option>LoRA</option><option>文本编码器</option><option>VAE</option><option>插件</option></select></label><label><span class="field-label">保存位置</span><input readonly value="根据类型自动选择"></label></div><div class="notice spaced">${icon('info')} 仅演示安装流程，不发起下载或执行插件代码。</div><div class="modal-actions">${button('取消','close')}${button('查看安装清单','install-preview','primary','arrow')}</div>`);
}
function boardPicker(){
 const available=[...pictures,...state.uploaded].filter(p=>favorites.has(p.id));
 modal('从收藏板选择',`<p>选择一张图片作为参考，当前演示最多保留两张。</p><div class="gallery-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">${available.map(p=>`<button class="work-picture" style="height:140px" data-reference="${p.id}" aria-label="选择 ${esc(p.name)}"><img src="${imageUrl(p)}" alt="${esc(p.name)}"><span class="image-badge">${esc(p.name)}</span></button>`).join('')}</div>${available.length?'':'<p>先到作品库收藏一张图片，或上传本地图片。</p>'}<div class="modal-actions">${button('上传本地图片','upload-ref','','upload')}</div>`);
}
function updateQueueBadge(){const n=state.tasks.filter(t=>['waiting','running'].includes(t.status)).length;$('#queue-count').hidden=!n;$('#queue-count').textContent=n;}
function queueBody(){
 const labels={waiting:'等待中',running:'模拟生成中',done:'演示完成',cancelled:'已取消'};
 return `<div class="modal-head"><h2>任务队列 <span class="subtext">${state.tasks.length}</span></h2><button class="icon-button" data-action="close" aria-label="关闭队列">${icon('close')}</button></div><div class="modal-body"><div class="notice">${icon('info')} 演示队列 · 所有任务依次执行，不调用模型。</div>${state.tasks.length?state.tasks.map((t,i)=>`<article class="queue-card"><div class="queue-card-top"><span class="mono muted">#${String(i+1).padStart(3,'0')}</span><span style="color:${t.status==='done'?'var(--accent)':'var(--sub)'}">${labels[t.status]}</span></div><h3>${esc(t.name)}</h3><p>${esc(t.prompt)}</p><div class="progress-track"><span style="width:${t.progress}%"></span></div><div class="queue-card-bottom"><span>${t.ratio} · ${t.steps} 步 · ${t.progress}%</span>${['waiting','running'].includes(t.status)?`<button class="text-button" data-cancel-task="${t.id}">取消</button>`:`<button class="text-button" data-retry-task="${t.id}">再次演示</button>`}</div></article>`).join(''):`<div class="empty-state" style="padding:45px 15px">${icon('queue')}<h3>把灵感放进队列</h3><p>去创作页提交一个演示任务，看看运行状态。</p><button class="btn primary" data-page="create">去创作 ${icon('arrow')}</button></div>`}</div><div class="drawer-foot">${icon('info')} 队列仅在本次预览会话保存。任务完成后展示已有图片。</div>`;
}
function openQueue(){showOverlay(queueBody(),'drawer-overlay');state.queueOpen=true;}
function refreshQueue(){if(state.queueOpen){const focus=$('#overlay-root button:focus');const action=focus?.outerHTML;const scroll=$('#overlay-root .modal-body')?.scrollTop||0;$('#overlay-root .drawer').innerHTML=queueBody();$('#overlay-root .modal-body').scrollTop=scroll;if(action)$$('#overlay-root button').find(x=>x.outerHTML===action)?.focus({preventScroll:true});}updateQueueBadge();}
function addTasks(){
 if(isCustomWorkspaceTab(currentTab())){toast('这个工作流尚未接入运行服务。');return;}
 const d=getDraft();if(!d.prompt.trim()){toast('先写下画面描述。');$('#prompt')?.focus();return;}
 const count=state.batch?Math.min(8,Math.max(1,Number(state.batchCount)||1)):1;
 for(let i=0;i<count;i++)state.tasks.push({id:crypto.randomUUID?.()||`${Date.now()}-${i}`,name:currentTab()?.title || currentWorkflow().name,tabId:currentTabId,workflow:state.workflow,prompt:d.prompt,ratio:d.ratio,steps:d.steps,status:'waiting',progress:0,autoEnhance:d.autoEnhance});
 updateQueueBadge();toast(`已加入 ${count} 个演示任务，将依次执行。`);tickQueue();
}
function tickQueue(){
 let task=state.tasks.find(t=>t.status==='running');
 if(!task){task=state.tasks.find(t=>t.status==='waiting');if(task)task.status='running';}
 if(task){
  task.progress=Math.min(100,task.progress+8);
  if(task.progress===100){
   task.status='done';const tab=workspaceTabs.find(t=>t.id===task.tabId);
   if(tab){tab.lastResult=task.workflow.includes('edit')?pictures[2]:task.workflow==='text'?pictures[0]:pictures[1];if(currentTabId===tab.id){state.lastResult=tab.lastResult;if(isEditorPage())render();}persistWorkspace();}
   toast('演示任务完成：预览使用已有作品，没有实际出图。');
  }
 }
 updateRunningOverlay();refreshQueue();
}
function updateRunningOverlay(){
 const tabTasks=state.tasks.filter(t=>t.tabId===currentTabId),task=tabTasks.find(t=>t.status==='running');
 const waiting=tabTasks.filter(t=>t.status==='waiting').length,latest=tabTasks.at(-1),status=$('#canvas-run-status');
 if(status&&!isCustomWorkspaceTab(currentTab())&&state.workflow!=='prompt'){
  status.textContent=task?`模拟生成中 ${task.progress}%${waiting?` · ${waiting} 个等待`:''}`:waiting?`${waiting} 个任务排队中`:latest?.status==='done'?'演示完成 · 未实际出图':latest?.status==='cancelled'?'任务已取消':'A 测演示 · 不调用绘图模型';
 }
 const stage=$('#preview-stage');if(!stage)return;stage.querySelector('.demo-running')?.remove();
 if(task)stage.insertAdjacentHTML('beforeend',`<div class="demo-running"><span class="spinner"></span><strong>模拟生成中 ${task.progress}%</strong><p>${task.autoEnhance?'自动润色 → 生成 · ':''}前端动画，不调用绘图模型</p></div>`);
}
function openSearch(){
 showOverlay(`<div class="global-search">${icon('search')}<input id="global-search" placeholder="查找页面、工作流…" aria-label="全局搜索"><button class="icon-button" data-action="close" aria-label="关闭搜索">${icon('close')}</button></div><div class="search-results" id="search-results"></div>`);$('#overlay-root .modal').classList.add('search-modal');renderSearch('');$('#global-search').focus();
}
function renderSearch(query){
 const entries=[...pages.map(p=>({...p,kind:'页面'})),{id:'settings',name:'设置与维护',icon:'settings',kind:'页面'},...workflows.map(w=>({...w,kind:'工作流'}))].filter(p=>p.name.toLowerCase().includes(query.toLowerCase()));
 $('#search-results').innerHTML=entries.length?entries.map(p=>`<button class="search-result" ${p.kind==='工作流'?`data-workflow="${p.id}"`:`data-page="${p.id}"`}>${icon(p.icon)}<span>${p.name}</span><small>${p.kind} ${icon('chevron')}</small></button>`).join(''):'<p class="subtext" style="padding:15px">没有匹配的页面或工作流。</p>';
}
function filterRender(inputId){const el=$(`#${inputId}`),pos=el.selectionStart;render();const fresh=$(`#${inputId}`);fresh.focus();if(pos!==null)fresh.setSelectionRange(pos,pos);}
function zoomCanvas(delta){
 const graph=$('.graph-inner');if(!graph)return;
 const zoom=delta===null?1:Math.min(1.6,Math.max(.5,Number(graph.dataset.zoom||1)+delta));
 graph.dataset.zoom=zoom;graph.style.zoom=zoom;$('#canvas-zoom-label').textContent=`${Math.round(zoom*100)}%`;if(currentTab())currentTab().zoom=zoom;persistWorkspace();
}
function syncBatchCount(){
 persistWorkspace();
 const note=$('.batch-options p');if(note)note.textContent=`将创建 ${state.batchCount} 个演示任务，依次执行。`;
 const badge=$('.generate small');if(badge)badge.textContent=`${state.batchCount} 个任务`;
}
function normalizeNumberInput(el){
 let value=el.value.trim()?Number(el.value):Number(el.defaultValue);
 if(!Number.isFinite(value))value=Number(el.min)||1;
 const min=el.min===''?-Infinity:Number(el.min),max=el.max===''?Infinity:Number(el.max);
 value=Math.max(min,Math.min(max,value));
 if(el.step!=='any'){
  const step=Number(el.step)||1,base=Number.isFinite(min)?min:0;
  value=Number((base+Math.round((value-base)/step)*step).toFixed(8));
 }
 el.value=String(Math.max(min,Math.min(max,value)));return Number(el.value);
}
const actions={
 'canvas-zoom-in':()=>zoomCanvas(.1),'canvas-zoom-out':()=>zoomCanvas(-.1),'canvas-zoom-reset':()=>zoomCanvas(null),
 'comfy-canvas':()=>modal('打开现有 ComfyUI 节点编辑器',`<p>现有 ComfyUI 的完整节点编辑器保留在本机 8188 端口。请先用原启动入口开启 ComfyUI，再打开画布。</p><p>此入口打开 ComfyUI 当前工作区，不会自动载入此 A 测的模板或同步表单。</p><div class="notice">${icon('info')} A 测页面不启动服务；完整画布嵌入与同一工作流的双向同步仍在后续接入范围内。</div><div class="modal-actions">${button('返回预览','close')}<a class="btn primary" href="http://127.0.0.1:8188/" target="_blank" rel="noopener noreferrer">${icon('arrowUp')} 打开本机 ComfyUI</a></div>`),
 'search':openSearch,'queue':openQueue,'close':closeOverlay,'new-create':()=>openWorkflow('text'),'open-workflows':()=>navigate('workflows'),'new-template':()=>modal('新建模板 · 预览',`<p>正式版可以导入节点工作流，并选择在简洁表单中显示的参数。</p><div class="settings-group">${['画面描述','参考图片','画面比例与尺寸','步数与种子'].map(t=>`<label class="settings-row"><strong>${t}</strong><input type="checkbox" checked style="width:16px"></label>`).join('')}</div><div class="modal-actions">${button('完成预览','demo-template','primary','check')}</div>`),
 'demo-template':()=>{closeOverlay();toast('表单参数选择已演示；正式版将保存到模板。');},
 'save-template':()=>modal('保存当前工作副本',`<p>草稿已自动保存。正式版还会保留模板的手动保存历史。</p><div class="settings-group"><div class="settings-row"><div><strong>更新原模板</strong><p>保存一版历史，之后可以回退。</p></div>${button('预览保存','demo-save')}</div><div class="settings-row"><div><strong>另存新模板</strong><p>保留原模板，创建新的创作起点。</p></div>${button('预览另存','demo-save','primary')}</div></div>`),
 'demo-save':()=>{closeOverlay();toast('已演示模板保存选项；现有工作流文件未修改。');},
 'advanced':()=>{state.advanced=!state.advanced;render();},'auto-enhance':()=>{getDraft().autoEnhance=!getDraft().autoEnhance;persistDraft();render();},
 'batch':()=>{state.batch=!state.batch;render();},'generate':addTasks,'enhance':enhanceDialog,
 'apply-enhanced':()=>{getDraft().prompt=$('#enhanced-prompt').value;getDraft().enhanced=getDraft().prompt;persistDraft();closeOverlay();render();toast('演示文本已应用，你可以继续修改。');},
 'back-form':()=>navigate('create'),'import-workflow':importDialog,'install-link':linkDialog,
 'dependency-preview':()=>modal('依赖检查 · 演示清单',`<p>这是一份示例检查结果，并未解析输入的链接。</p><div class="resource-list">${['Qwen Image 2.1 · 主图像模型','Qwen3 VL 8B · 文本编码器','ComfyUI-GGUF · 自定义节点'].map(n=>`<div class="resource-row">${icon('check')}<div class="resource-name"><strong>${n}</strong><small>示例状态 · 已有资源可复用</small></div></div>`).join('')}</div><div class="modal-actions">${button('完成预览','close','primary','check')}</div>`),
 'install-preview':()=>{const val=$('#install-link').value.trim();if(!val){toast('先填入资源链接，或关闭返回。');return;}let parsed;try{parsed=new URL(val);if(!['http:','https:'].includes(parsed.protocol))throw Error();}catch{toast('请输入 http 或 https 链接。');return;}const type=$('#install-type').value;modal('安装清单 · 演示',`<div class="notice">${icon('info')} 此清单只反映你的选择，未读取远程资源。</div><p>来源：${esc(parsed.hostname)}<br>类型：${esc(type)}<br>体积：读取资源后确定<br>文件与兼容性：等待实际解析</p><div class="modal-actions">${button('返回资源管理','close','primary')}</div>`);},
 'browse-models':()=>{state.resourceTab='online';render();},'board-picker':boardPicker,
 'upload-ref':trigger=>{const input=$('#image-upload');input.dataset.purpose='reference';input.dataset.referenceSlot=trigger?.dataset.referenceSlot??'';input.multiple=input.dataset.referenceSlot==='';input.value='';closeOverlay();input.click();},
 'upload-board':()=>{const input=$('#image-upload');input.dataset.purpose='board';input.dataset.referenceSlot='';input.multiple=true;input.value='';input.click();},
 'output-folder':()=>modal('作品文件入口',`<p>正式桌面版点击后，会直接打开 Windows 文件夹。</p><label class="field-label">已有作品位置</label><input readonly class="full-width mono" value="D:\\agent\\ComfyUI\\output"><p class="subtext spaced">新任务的归档规则：日期 / 工作流。A 测未调用系统文件管理器。</p><div class="modal-actions">${button('知道了','close','primary')}</div>`),
 'demo-export-original':()=>{closeOverlay();toast('已选择保留生成信息。A 测未写出文件。');},'demo-export-share':()=>{closeOverlay();toast('已选择移除生成信息的分享副本。A 测未写出文件。');},
 'account-hf':()=>accountDialog('Hugging Face'),'account-civitai':()=>accountDialog('Civitai'),
 'check-update':()=>modal('更新流程 · 预览',`<p>正式版将检查已安装版本，并在你确认后更新。</p><div class="settings-group">${['检查版本与本地修改','生成备份并验证恢复范围','执行更新与兼容性验证','失败时恢复原环境'].map((s,i)=>`<div class="settings-row"><span class="subtext mono">0${i+1}</span><strong>${s}</strong></div>`).join('')}</div><div class="notice">${icon('info')} 未联网检查版本，也未更新 ComfyUI。</div>`),
 'open-plugins':()=>{state.resourceTab='local';state.resourceCategory='插件';navigate('resources');},
 'backup':()=>modal('更新前的备份范围',`<p>备份代码、插件、本地修改、配置及受影响依赖；沿用现有大模型文件。</p><div class="notice">${icon('info')} 这是备份方案预览，当前没有创建备份或执行恢复。</div><p>尤其保留 Gemma 润色节点已有的显存释放、上下文和模型卸载修改。</p><div class="modal-actions">${button('知道了','close','primary')}</div>`)
};
function accountDialog(source){modal(`${source} 账户 · 预览`,`<p>正式版会按需使用你的账户权限访问资源。</p><div class="notice">${icon('info')} A 测不接收或保存密钥，请不要在预览中输入 API Key。</div><div class="settings-group"><div class="settings-row"><strong>连接状态</strong><span class="chip">未连接</span></div><div class="settings-row"><strong>凭据保存</strong><span class="subtext">系统凭据存储或系统加密</span></div></div>`);}

document.addEventListener('click',e=>{
 const t=e.target.closest('button,a,[data-workflow]');
 if(e.target.matches('[data-overlay]')){closeOverlay();return;}
 if(!t)return;
 if(t.dataset.page){navigate(t.dataset.page);return;}
 if(t.dataset.workflow){openWorkflow(t.dataset.workflow);return;}
 if(t.dataset.view){openPicture(t.dataset.view);return;}
 if(t.dataset.favorite){const id=t.dataset.favorite;favorites.has(id)?favorites.delete(id):favorites.add(id);save('favorites',[...favorites].filter(id=>pictures.some(p=>p.id===id)));const box=t.dataset.lightbox;render();if(box)openPicture(id);else toast(favorites.has(id)?'已加入收藏板。':'已取消收藏。');return;}
 if(t.dataset.flowFavorite){const id=t.dataset.flowFavorite;workflowFavorites.has(id)?workflowFavorites.delete(id):workflowFavorites.add(id);save('workflow-favorites',[...workflowFavorites]);render();return;}
 if(t.dataset.export){exportDialog(t.dataset.export);return;}
 if(t.dataset.usePicture){const p=findPicture(t.dataset.usePicture);openWorkflow(p.workflowId||'edit');if(p.kind==='参考'){state.refs=[imageUrl(p)];render();}else {getDraft().prompt=p.prompt;persistDraft();render();}toast(p.kind==='参考'?'参考图已带入创作表单。':'画面摘要已带入工作副本。');return;}
 if(t.dataset.reference){const p=findPicture(t.dataset.reference);if(state.refs.length>=2)state.refs.shift();state.refs.push(imageUrl(p));closeOverlay();render();toast('已选入参考图。');return;}
 if(t.dataset.mode){navigate(t.dataset.mode==='canvas'?'canvas':'create');return;}
 if(t.dataset.ratio){getDraft().ratio=t.dataset.ratio;persistDraft();render();return;}
 if(t.dataset.flowTab){state.flowTab=t.dataset.flowTab;render();return;}
 if(t.dataset.flowFilter){state.flowFilter=t.dataset.flowFilter;render();return;}
 if(t.dataset.galleryFilter){state.galleryFilter=t.dataset.galleryFilter;render();return;}
 if(t.dataset.resourceTab){state.resourceTab=t.dataset.resourceTab;state.resourceSearch='';render();return;}
 if(t.dataset.resourceCategory){state.resourceCategory=t.dataset.resourceCategory;render();return;}
 if(t.dataset.resource){resourceDialog(t.dataset.resource);return;}
 if(t.dataset.source){state.source=t.dataset.source;render();return;}
 if(t.dataset.settingTab){state.settingTab=t.dataset.settingTab;render();return;}
 if(t.dataset.theme){state.theme=t.dataset.theme;save('theme',state.theme);render();toast(state.theme==='green'?'已切换到青柠配色。':'已切换到雾紫配色。');return;}
 if(t.dataset.cancelTask){const task=state.tasks.find(x=>x.id===t.dataset.cancelTask);if(task)task.status='cancelled';refreshQueue();updateRunningOverlay();return;}
 if(t.dataset.retryTask){const task=state.tasks.find(x=>x.id===t.dataset.retryTask);if(task)state.tasks.push({...task,id:crypto.randomUUID?.()||`${Date.now()}`,status:'waiting',progress:0});refreshQueue();return;}
 if(t.dataset.action&&actions[t.dataset.action])actions[t.dataset.action](t);
});
document.addEventListener('input',e=>{
 const el=e.target;
 if(el.dataset.draft){let val=el.value;if(el.type==='number'){if(!val.trim()||!el.validity.valid)return;val=Number(val);}getDraft()[el.dataset.draft]=val;persistDraft();return;}
 if(el.id==='batch-count'&&el.value.trim()&&el.validity.valid){state.batchCount=Number(el.value);syncBatchCount();return;}
 if(el.id==='flow-search'){state.flowSearch=el.value;filterRender(el.id);}
 if(el.id==='resource-search'){state.resourceSearch=el.value;filterRender(el.id);}
 if(el.id==='gallery-search'){state.gallerySearch=el.value;filterRender(el.id);}
 if(el.id==='global-search')renderSearch(el.value);
});
document.addEventListener('change',e=>{
 const el=e.target;
 if(el.id==='workflow-select'){openWorkflow(el.value);return;}
 if(el.dataset.draft){getDraft()[el.dataset.draft]=el.type==='number'?normalizeNumberInput(el):el.value;persistDraft();return;}
 if(el.id==='density'){state.density=el.value;save('density',state.density);render();return;}
 if(el.id==='batch-count'){state.batchCount=normalizeNumberInput(el);syncBatchCount();return;}
 if(el.id==='image-upload'){
  const files=[...el.files].filter(f=>f.type.startsWith('image/')).slice(0,20);if(!files.length)return;
  if(el.dataset.purpose==='reference'){
   if(el.dataset.referenceSlot!==''){const refs=state.refs.length?[...state.refs]:[asset('portrait'),asset('shirt')];refs[Number(el.dataset.referenceSlot)]=URL.createObjectURL(files[0]);state.refs=refs;}
   else state.refs=files.slice(0,2).map(f=>URL.createObjectURL(f));
   render();toast('参考图已载入当前预览会话。');
  }
  else{for(const file of files){const id=`upload-${Date.now()}-${state.uploaded.length}`;state.uploaded.push({id,name:file.name,url:URL.createObjectURL(file),kind:'参考',workflow:'本地上传',workflowId:'edit',size:'本地图片',format:file.type.split('/')[1].toUpperCase(),prompt:'当前会话上传的参考图片。'});favorites.add(id);}render();toast('已加入收藏板，仅在当前预览会话保留。');}el.value='';
 }
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){closeOverlay();return;}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();return;}
 if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&isEditorPage()&&currentTab()&&!$('#overlay-root').children.length){e.preventDefault();if(currentTab().kind==='starter'){importWorkflowText($('#workflow-json').value);return;}state.workflow==='prompt'?enhanceDialog():addTasks();return;}
 if((e.key==='Enter'||e.key===' ')&&e.target.matches('[role="button"][data-workflow]')){e.preventDefault();openWorkflow(e.target.dataset.workflow);return;}
 if(e.key==='Tab'&&$('#overlay-root').children.length){const f=$$('button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"]',$('#overlay-root')).filter(x=>x.offsetParent!==null);if(!f.length)return;const first=f[0],last=f.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
});
window.addEventListener('hashchange',()=>{const p=location.hash.slice(1);if(p!==state.page)navigate(p);});
initializeWorkspace();bindWorkspaceActions();bindWorkflowStartActions();bindCompatibilityActions();
state.page=[...pages.map(p=>p.id),'settings'].includes(location.hash.slice(1))?location.hash.slice(1):'home';
if(state.page==='canvas'||state.page==='create'){state.mode=state.page==='canvas'?'canvas':'form';save('editor-mode',state.mode);}
render();setInterval(tickQueue,600);
