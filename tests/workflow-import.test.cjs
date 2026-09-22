const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parse, MAX_BYTES} = require('../workflow-import.js');
test('UI workflow retains the entire document including subgraphs and widget data', () => {
 const doc={version:0.4,nodes:[{id:1,type:'LoadImage',widgets_values:['reference.png']},{id:2,type:'CustomNode',title:'<script>untrusted</script>'}],links:[[9,1,0,2,0,'IMAGE']],definitions:{subgraphs:[{id:'child',nodes:[]}]} };
 const parsed=parse('\uFEFF'+JSON.stringify(doc));
 assert.deepEqual(parsed.document,doc);
 assert.equal(parsed.nodes[1].title,'<script>untrusted</script>');
 assert.deepEqual(parsed.links,[{from:'1',to:'2'}]);
});
test('empty workflow and object-style links are accepted', () => {
 assert.equal(parse('{"nodes":[],"links":[],"version":0.4}').nodes.length,0);
 assert.deepEqual(parse(JSON.stringify({nodes:[{id:'a',type:'A'},{id:'b',type:'B'}],links:[{origin_id:'a',target_id:'b'}]})).links,[{from:'a',to:'b'}]);
});
test('API workflow and prompt wrapper resolve node dependencies', () => {
 const prompt={'1':{class_type:'Text',inputs:{text:'hello'}},'2':{class_type:'Sampler',inputs:{positive:['1',0],size:[512,512]},_meta:{title:'Sample'}}};
 for(const doc of [prompt,{prompt,client_id:'local'}]){
  const parsed=parse(JSON.stringify(doc));
  assert.equal(parsed.nodes.length,2);
  assert.deepEqual(parsed.links,[{from:'1',to:'2'}]);
  assert.deepEqual(parsed.document,doc);
 }
});
test('invalid data never becomes a workflow', () => {
 for(const value of ['', '{', 'null','[]','{}','{"theme":"dark"}','{"nodes":[{}]}','{"nodes":[{"id":1,"type":"A"},{"id":"1","type":"B"}]}','{"nodes":[],"links":{}}']) assert.throws(()=>parse(value));
 assert.throws(()=>parse(' '.repeat(MAX_BYTES+1)+'{}'),/2 MB/);
});
test('dangling links are reported without deleting source data', () => {
 const parsed=parse('{"nodes":[{"id":1,"type":"A"}],"links":[[1,1,0,99,0,"X"]]}');
 assert.equal(parsed.skippedLinks,1);
 assert.equal(parsed.links.length,0);
 assert.equal(parsed.document.links.length,1);
});
test('subgraph instances use the saved human-readable name', () => {
 const parsed=parse('{"nodes":[{"id":1,"type":"child-uuid"}],"definitions":{"subgraphs":[{"id":"child-uuid","name":"图像编辑"}]}}');
 assert.equal(parsed.nodes[0].title,'图像编辑');
 assert.equal(parsed.document.nodes[0].type,'child-uuid');
});
