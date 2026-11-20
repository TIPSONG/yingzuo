'use strict';
const {randomBytes} = require('node:crypto');
const {AppError, CODES} = require('../core/errors.cjs');

// Settings, port changes, rotation and shutdown all own the same listener.
// The renderer receives its address and status; the token only goes to the
// clipboard in response to the user's explicit copy action.
function createMcpAccess({configRepo, credentials, clipboard, createServer, getTools, isQuitting}) {
  let listener = null, lastError = null, closed = false;
  let pending = Promise.resolve();
  function serial(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  function status() {
    const {enabled, port} = configRepo.config.mcp ?? {};
    return {enabled: enabled === true, port, running: !!listener, url: listener?.url ?? null, error: lastError};
  }
  async function stop() {
    if (listener) {
      const old = listener;
      listener = null;
      await old.server.stop();
    }
  }
  function newToken() {
    const token = randomBytes(32).toString('base64url');
    credentials.set('access', token);
    return token;
  }
  async function apply(rotate = false) {
    const {enabled, port} = configRepo.config.mcp ?? {};
    if (!rotate && enabled === true && listener?.port === port && !closed) return status();
    await stop();
    lastError = null;
    if (closed || enabled !== true) return status();
    try {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(CODES.INVALID_ARGUMENT, '请在设置中填写有效的 MCP 端口。');
      const tools = getTools();
      const token = rotate ? newToken() : (credentials.get('access') ?? newToken());
      const instance = {port, token, url: null, server: null};
      function assertActive() {
        const desired = configRepo.config.mcp;
        if (closed || isQuitting() || listener !== instance || desired?.enabled !== true || desired.port !== port) {
          throw new AppError(CODES.INVALID_STATE, '映作正在退出或 MCP 配置已变更。');
        }
      }
      instance.server = createServer({port, token, tools: {tools: tools.tools, call(name, args) {
        assertActive();
        return tools.call(name, args, {assertActive});
      }}});
      instance.url = await instance.server.start();
      listener = instance;
    } catch (e) {
      if (e.code === 'EADDRINUSE') lastError = 'MCP 端口已被占用，请更换端口并保存。';
      else if (e instanceof AppError) lastError = e.message;
      else lastError = 'MCP 启动失败，请确认端口可用、系统凭据可读取，然后重新保存设置。';
    }
    return status();
  }
  return {
    sync: () => serial(() => apply()),
    close: () => { closed = true; return serial(stop); },
    methods: {
      'mcp.status': () => serial(status),
      'mcp.rotateToken': () => serial(() => {
        if (closed || configRepo.config.mcp?.enabled !== true) throw new AppError(CODES.INVALID_STATE, '请先启用 MCP。');
        return apply(true);
      }),
      'mcp.copyConfig': () => serial(() => {
        if (!listener || isQuitting() || closed) throw new AppError(CODES.INVALID_STATE, '请先启用 MCP 并确认服务正在运行。');
        const config = {mcpServers: {yingzuo: {url: listener.url, headers: {Authorization: `Bearer ${listener.token}`}}}};
        clipboard.writeText(JSON.stringify(config, null, 2));
        return {copied: true};
      }),
    },
  };
}
module.exports = {createMcpAccess};
