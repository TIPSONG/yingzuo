'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const methods = ['boot','connect','openTemplate','activateTab','duplicateTab','closeTab','importWorkflow','newBlank','snapshot','applyParameters','setMode','save','exportWorkflow','showPreview','showEditor'];
const api = Object.fromEntries(methods.map(method => [method, (...args) => ipcRenderer.invoke('yingzuo:p0', {method,args})]));
api.setBounds = bounds => ipcRenderer.send('yingzuo:p0-bounds', bounds);
api.onStatus = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('yingzuo:p0-status', listener);
  return () => ipcRenderer.removeListener('yingzuo:p0-status', listener);
};
contextBridge.exposeInMainWorld('yingzuoDesktop', Object.freeze(api));
