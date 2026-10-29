'use strict';
// 固定方法白名单。不暴露通用 exec/readFile/writeFile；每个方法都由主进程再次校验来源与参数。
const {contextBridge, ipcRenderer} = require('electron');
const methods = ['boot','connect','openTemplate','activateTab','duplicateTab','closeTab','renameTab','importWorkflow','importText','newBlank','snapshot','applyParameters','setMode','save','exportWorkflow','showPreview','showEditor'];
const api = Object.fromEntries(methods.map(method => [method, (...args) => ipcRenderer.invoke('yingzuo:p0', {method,args})]));
api.setBounds = bounds => ipcRenderer.send('yingzuo:p0-bounds', bounds);
api.setOverlay = value => ipcRenderer.send('yingzuo:overlay', value === true);
api.windowMinimize = () => ipcRenderer.invoke('yingzuo:window', {op: 'minimize'});
api.windowMaximize = () => ipcRenderer.invoke('yingzuo:window', {op: 'maximize'});
api.windowClose = () => ipcRenderer.invoke('yingzuo:window', {op: 'close'});
api.windowIsMaximized = () => ipcRenderer.invoke('yingzuo:window', {op: 'isMaximized'});
api.onWindowState = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('yingzuo:window-state', listener);
  return () => ipcRenderer.removeListener('yingzuo:window-state', listener);
};
api.onStatus = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('yingzuo:p0-status', listener);
  return () => ipcRenderer.removeListener('yingzuo:p0-status', listener);
};
const GROUPS = {
  services: ['status','startComfy','stopComfy','freeComfyMemory','startLmServer','stopLmServer','logs'],
  settings: ['get','update','pickPath','setCredential','removeCredential'],
  tasks: ['preview','form','applyFormField','run','previewBatch','runBatch','enhance','enhanceResult','list','get','cancel','retry','recheck','pause','resume','pickReference','refs','setRefs','copyRefs','exportPackage','importPackage','closedList','reopenClosed'],
  templates: ['list','get','update','import','importBuiltins','open','saveFromTab','restore','export','formDraft','saveForm','checkMapping','rebind','diagnose','catalog','applyFix','undoFix','exportFixed','importOnline','dependencyPlan','findModelSources','applyDependencyPlan','detectManager','installMissingPlugins','thumbnail','setThumbnail','onlineSources','browseOnline','onlineThumbnail','importFromSource'],
  downloads: ['search','detail','version','parseLink','plan','pickDir','add','list','pause','resume','cancel'],
  maintenance: ['info','eventsSince','openLocation','exportDiagnostics','importAlphaDrafts','checkUpdates','checkAppRelease','downloadAppRelease','openAppUpdateFolder','lastUpdateCheck','manifest','backups','createBackup','verifyBackup','restoreBackup','pendingRestores','appRecovery','chooseAppRecovery','appBackup','appBackups','scheduleAppRestore','resumeRestore','holds','clearHold','transactions','pruneBackups','updateComfy','updatePlugin'],
  resources: ['scan','detail','setNote','hash','references','impact','quickUse','plugins','disablePlugin','enablePlugin','installPlugin','removePlugin','modelRoots','moveModel'],
  trash: ['list','restore','planPurge','purge'],
  assets: ['scan','watch','list','recent','get','thumbnail','linkTask','previewPrefix','openFile','revealFile','openLocation','shareSupport','exportOriginal','exportShare','favorite','unfavorite','favorites','favoriteLayout'],
};
let counter = 0;
const call = (method, args) => ipcRenderer.invoke('yingzuo:api', {requestId:`r${Date.now().toString(36)}${(counter++).toString(36)}`, method, args});
const grouped = Object.fromEntries(Object.entries(GROUPS).map(([group, names]) => [group, Object.freeze(Object.fromEntries(names.map(name => [name, (...args) => call(`${group}.${name}`, args)])))]));
grouped.events = Object.freeze({
  /** 订阅事件，返回取消函数。 */
  subscribe(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('yingzuo:event', listener);
    return () => ipcRenderer.removeListener('yingzuo:event', listener);
  },
});
contextBridge.exposeInMainWorld('yingzuoDesktop', Object.freeze(api));
contextBridge.exposeInMainWorld('yingzuo', Object.freeze(grouped));
