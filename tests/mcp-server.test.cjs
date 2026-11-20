'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {Client, StreamableHTTPClientTransport} = require('@modelcontextprotocol/client');
const {createMcpServer} = require('../desktop/services/mcp-server.cjs');

const token = 'fixture-local-token';
const headers = {authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json'};
function fixture(t, port) {
  const calls = [];
  const tools = {
    tools: [{name: 'echo', description: 'Return the supplied text', inputSchema: {
      type: 'object', properties: {message: {type: 'string'}}, required: ['message'], additionalProperties: false,
    }}],
    call: async (name, args) => {
      calls.push({name, args});
      return {content: [{type: 'text', text: args.message}]};
    },
  };
  const service = createMcpServer({tools, token, port});
  t.after(() => service.stop());
  return {service, calls};
}
async function connect(t, url) {
  const client = new Client({name: 'independent-test-client', version: '1.0.0'}, {versionNegotiation: {mode: 'auto'}});
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {requestInit: {headers: {authorization: headers.authorization}}}));
  t.after(() => client.close());
  return client;
}
test('MCP: two independent official SDK clients discover, list, and call tools through loopback', async t => {
  const {service, calls} = fixture(t);
  const [url, again] = await Promise.all([service.start(), service.start()]);
  assert.equal(url, again);
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const clients = await Promise.all([connect(t, url), connect(t, url)]);
  for (const client of clients) {
    assert.equal(client.getServerVersion().name, 'yingzuo');
    assert.equal((await client.listTools()).tools[0].inputSchema.properties.message.type, 'string');
  }
  const results = await Promise.all(clients.map((client, i) => client.callTool({name: 'echo', arguments: {message: `工作流 ${i}`}})));
  assert.deepEqual(results.map(r => r.content[0].text), ['工作流 0', '工作流 1']);
  assert.equal(calls.length, 2);
});

test('MCP: earlier Streamable HTTP clients can initialize, acknowledge, list, and call', async t => {
  const {service} = fixture(t), url = await service.start();
  const rpc = async (method, params, id) => {
    const res = await fetch(url, {method: 'POST', headers: {...headers, 'mcp-protocol-version': '2025-11-25'},
      body: JSON.stringify({jsonrpc: '2.0', method, params, id})});
    if (id === undefined) { assert.equal(res.status, 202); return; }
    assert.equal(res.status, 200);
    const text = await res.text();
    const payload = res.headers.get('content-type').includes('text/event-stream')
      ? JSON.parse(text.split(/\r?\n/).find(s => s.startsWith('data:')).slice(5)) : JSON.parse(text);
    assert.equal(payload.id, id);
    assert.ok(!payload.error, JSON.stringify(payload.error));
    return payload.result;
  };
  const first = await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'local-host', version: '1'}}, 1);
  assert.equal(first.protocolVersion, '2025-11-25');
  await rpc('notifications/initialized', {});
  assert.equal((await rpc('tools/list', {}, 2)).tools[0].name, 'echo');
  assert.equal((await rpc('tools/call', {name: 'echo', arguments: {message: '预览'}}, 3)).content[0].text, '预览');
});

test('MCP: checks the local endpoint and credentials before dispatch, and enforces a body limit', async t => {
  const {service, calls} = fixture(t), url = await service.start();
  const post = (extra, body = '{}') => fetch(url, {method: 'POST', headers: {...headers, ...extra}, body});
  assert.equal((await post({authorization: ''})).status, 401);
  assert.equal((await post({authorization: 'Bearer wrong'})).status, 401);
  assert.equal((await post({origin: 'https://example.invalid'})).status, 403);
  const request = http.request(url, {method: 'POST', headers: {...headers, host: 'example.invalid'}});
  const response = once(request, 'response');
  request.end('{}');
  const [rejected] = await response;
  assert.equal(rejected.statusCode, 403);
  rejected.resume();
  assert.equal((await fetch(url + '/other', {headers})).status, 404);
  assert.equal((await post({}, Buffer.alloc(1024 * 1024 + 1, 32))).status, 413);
  assert.equal(calls.length, 0);
});

test('MCP: shutdown closes an unfinished HTTP request and a failed bind can be retried', async t => {
  const {service} = fixture(t);
  const url = await service.start();
  const second = fixture(t, Number(new URL(url).port)).service;
  await assert.rejects(second.start(), {code: 'EADDRINUSE'});
  const req = http.request(url, {method: 'POST', headers});
  const disconnected = once(req, 'error');
  const gotSocket = once(req, 'socket');
  req.write('{');
  const [socket] = await gotSocket;
  if (socket.connecting) await once(socket, 'connect');
  await service.stop();
  await disconnected;
  assert.equal(await second.start(), url);
  await second.stop();
  await service.stop();
});
