'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('yzRecovery', {call: (op, arg) => ipcRenderer.invoke('yz-recovery', {op, arg})});
