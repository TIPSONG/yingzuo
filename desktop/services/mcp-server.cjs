'use strict';
const http = require('node:http');
const {createHash, timingSafeEqual} = require('node:crypto');
const {version} = require('../../package.json');

const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();

function createMcpServer({tools, token, port = 0}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) throw new Error('MCP 访问令牌无效。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MCP 端口无效。');
  const expected = digest(token);
  let active = null;
  let lifecycle = Promise.resolve();
  function serialize(action) {
    const next = lifecycle.then(action);
    lifecycle = next.catch(() => {});
    return next;
  }
  async function listen() {
    if (active) return active.url;
    // Keep the SDK and its schema compiler off the ordinary desktop startup path.
    const {createMcpHandler, McpServer, fromJsonSchema} = require('@modelcontextprotocol/server');
    const {toNodeHandler} = require('@modelcontextprotocol/node');
    const definitions = tools.tools.map(tool => ({...tool, inputSchema: fromJsonSchema(tool.inputSchema)}));
    let accepting = true;
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({name: 'yingzuo', version});
      for (const {name, ...config} of definitions) {
        mcp.registerTool(name, config, async args => {
          if (!accepting) return {isError: true, content: [{type: 'text', text: '映作 MCP 接口已关闭。'}]};
          try { return await tools.call(name, args); }
          catch { return {isError: true, content: [{type: 'text', text: '映作暂时无法完成该工具调用。'}]}; }
        });
      }
      return mcp;
    }, {maxRequestBodySize: MAX_BODY});
    const dispatch = toNodeHandler(handler, {maxRequestBodySize: MAX_BODY});
    const server = http.createServer({headersTimeout: 10000, requestTimeout: 30000}, (req, res) => {
      const reject = (status, headers = {}) => res.writeHead(status, {connection: 'close', ...headers}).end();
      if (req.url !== '/mcp') return reject(404);
      const authority = `${HOST}:${req.socket.localPort}`;
      if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`)) return reject(403);
      const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(req.headers.authorization ?? '');
      if (!match || !timingSafeEqual(expected, digest(match[1]))) return reject(401, {'www-authenticate': 'Bearer realm="yingzuo"'});
      if (!accepting) return reject(503);
      dispatch(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed) reject(500);
        else res.destroy();
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
      });
    } catch (error) {
      await handler.close();
      throw error;
    }
    const url = `http://${HOST}:${server.address().port}/mcp`;
    active = {url, async close() {
      accepting = false;
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await Promise.all([closed, handler.close()]);
    }};
    return url;
  }
  return {
    start: () => serialize(listen),
    stop: () => serialize(async () => {
      const previous = active;
      active = null;
      if (previous) await previous.close();
    }),
  };
}

module.exports = {createMcpServer};
