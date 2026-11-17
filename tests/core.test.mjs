import test from "node:test";
import assert from "node:assert/strict";
import { documentUrl, documentKey, documentLinks, documentForFrame } from "../extension/core.mjs";

test("只接受指定飞书域名的文档，剔除查询串且保留有效段落锚点", () => {
  assert.equal(documentUrl(" https://example.feishu.cn/wiki/SampleDocument?create_from=copy#share-SampleBlock "), "https://example.feishu.cn/wiki/SampleDocument#share-SampleBlock");
  assert.equal(documentKey("https://example.feishu.cn/wiki/SampleDocument#share-SampleBlock"), "https://example.feishu.cn/wiki/SampleDocument");
  assert.equal(documentUrl("https://example.feishu.cn/docx/SampleDocument/#arbitrary"), "https://example.feishu.cn/docx/SampleDocument");
  for (const value of ["http://example.feishu.cn/wiki/Sample", "https://example.feishu.cn.example.org/wiki/Sample", "https://other.feishu.cn/wiki/Sample", "https://example.feishu.cn/settings", "https://synthetic-user:invalid-placeholder@example.feishu.cn/wiki/Sample", "javascript:alert(1)", "https://example.feishu.cn/wiki/"]) assert.throws(() => documentUrl(value));
});

test("文档清单不限制三份，同一文档不同分享参数只显示一栏", () => {
  const links = Array.from({length:8}, (_,index)=>`https://example.feishu.cn/wiki/Sample${index}`);
  assert.equal(documentLinks(links.join("\n")).length, 8);
  assert.deepEqual(documentLinks(`${links[0]}?create_from=copy\n\n${links[0]}#share-SampleBlock\n${links[1]}`), [`${links[0]}#share-SampleBlock`, links[1]]);
  assert.throws(() => documentLinks(`${links[0]}\nhttps://example.org/wiki/Other`));
});

test("只接受本工作台、本扩展及已添加文档的子框架消息", () => {
  const documents = [{key:"https://example.feishu.cn/wiki/Sample",selected:true}];
  const sender = {id:"synthetic-extension",tab:{id:42},frameId:7,url:documents[0].key};
  const match = value => documentForFrame(value,"synthetic-extension",42,documents);
  assert.equal(match(sender),documents[0]);
  assert.equal(match({...sender,id:"other-extension"}),null);
  assert.equal(match({...sender,tab:{id:41}}),null);
  assert.equal(match({...sender,frameId:0}),null);
  assert.equal(match({...sender,frameId:undefined}),null);
  assert.equal(match({...sender,url:"https://example.org/wiki/Sample"}),null);
  assert.equal(match({...sender,url:"https://example.feishu.cn/wiki/Unselected"}),null);
});
