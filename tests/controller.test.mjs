import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as core from "../extension/core.mjs";

const source = readFileSync(new URL("../extension/controller.mjs", import.meta.url), "utf8").split("\n").slice(1).join("\n");
const html = readFileSync(new URL("../extension/controller.html", import.meta.url), "utf8");

async function controller(totals = [3, 3, 3], savedScale = 100) {
  class Element {
    constructor() { this.events = {}; this.children = []; this.value = ""; this.disabled = false; this.hidden = false; this.classList = { add() {}, remove() {}, toggle() {} }; this.style={setProperty:(name,value)=>{this.style[name]=value;}}; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    remove() {}
    focus() {}
    select() {}
    async fire(name) { if (!this.disabled) await this.events[name]?.({ preventDefault() {} }); }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const documents = totals.map((_, index) => ({ key: `https://example.feishu.cn/wiki/Sample${index}`, title: `文档 ${index}`, selected: true }));
  const calls = [], positions = totals.map(() => 0);
  const childReceivers = new Map();
  let listener, failIndex = -1, hold, release;
  const api = {
    runtime: { id: "synthetic-extension", onMessage: { addListener(callback) { listener = callback; } } },
    storage: { session: { async get() { return { documents, readingScale:savedScale }; }, async set() {} } },
    permissions: { async contains() { return true; } },
    scripting: { async getRegisteredContentScripts() { return []; }, async registerContentScripts() {} },
    tabs: {
      async getCurrent() { return { id: 42 }; },
      async sendMessage(tab, message, target) {
        const index = Number((target.documentId || "").replace("document-", ""));
        calls.push({ index, ...message });
        if (childReceivers.has(index)) return childReceivers.get(index)(message);
        if (message.type === "sync") return { ok: true };
        if (message.type === "find") positions[index] = totals[index] ? 1 : 0;
        if (message.type === "next") {
          if (hold) await hold;
          if (index === failIndex) return { ok: false, error: "合成导航失败" };
          positions[index] = ((positions[index] - 1 + message.direction + totals[index]) % totals[index]) + 1;
        }
        return { ok: true, counter: `${positions[index]} / ${totals[index]}` };
      }
    }
  };
  const context = vm.createContext({ ...core, chrome: api, document: { getElementById: id => elements[id], createElement: () => new Element(), addEventListener() {} }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame:callback=>setImmediate(callback) });
  await vm.runInContext(`(async () => {${source}\n})()`, context);
  for (const [index, doc] of documents.entries()) listener({ namespace: core.MESSAGE, type: "ready", title: doc.title }, { id: api.runtime.id, tab: { id: 42 }, frameId: index + 1, documentId: `document-${index}`, url: doc.key });
  await new Promise(resolve => setImmediate(resolve));
  return {
    elements, calls, positions,
    pane(index) { return elements.workspace.children[index].children[0]; },
    localSearch(index) { return elements.workspace.children[index].children[1]; },
    async search() { elements.query.value = "每日任务"; await elements["search-form"].fire("submit"); calls.length = 0; },
    fail(index) { failIndex = index; },
    hold() { hold = new Promise(resolve => { release = resolve; }); },
    release() { release(); hold = null; },
    scroll(index, data) {
      listener({namespace:core.MESSAGE,type:"scroll",...data},{id:api.runtime.id,tab:{id:42},frameId:index+1,documentId:`document-${index}`,url:documents[index].key});
    },
    attach(index, receive) { childReceivers.set(index, receive); },
    fromReader(index, message) {
      return new Promise(resolve => {
        listener(message,{id:api.runtime.id,tab:{id:42},frameId:index+1,documentId:`document-${index}`,url:documents[index].key},resolve);
      });
    }
  };
}

test("顶部下一处一次推动所有勾选文档，上一处可一起返回并恢复滚动联动", async () => {
  const app = await controller();
  assert.equal(app.elements["next-all"].disabled, true);
  await app.search();
  app.elements.sync.checked = true;
  await app.elements["next-all"].fire("click");
  assert.deepEqual(app.positions, [2, 2, 2]);
  const moves = app.calls.filter(call => call.type === "next");
  assert.equal(moves.length, 3);
  assert.ok(moves.every(call => call.direction === 1));
  assert.ok(app.calls.slice(0, 3).every(call => call.type === "sync" && call.enabled === false));
  assert.ok(app.calls.slice(-3).every(call => call.type === "sync" && call.enabled === true));
  await app.elements["previous-all"].fire("click");
  assert.deepEqual(app.positions, [1, 1, 1]);
  await app.elements["next-all"].fire("click");
  await app.elements["next-all"].fire("click");
  assert.deepEqual(app.positions, [3, 3, 3]);
});

test("单栏搜索只查目标文档；统一下一处不会带动正在查询其他词的栏", async () => {
  const app=await controller();
  await app.search();
  const local=app.localSearch(1);
  local.children[0].value="独立关键词";
  await local.fire("submit");
  assert.deepEqual(app.calls.filter(call=>call.type==="find").map(call=>({index:call.index,query:call.query})),[{index:1,query:"独立关键词"}]);
  app.calls.length=0;
  await app.elements["next-all"].fire("click");
  assert.deepEqual(app.calls.filter(call=>call.type==="next").map(call=>call.index),[0,2]);
  assert.deepEqual(app.positions,[2,1,2]);
});

test("文档内查找快捷键只展开来源栏，即使该栏没有勾选", async () => {
  const app=await controller();
  const check=app.pane(1).children[0];check.checked=false;await check.fire("change");
  await app.fromReader(1,{namespace:core.MESSAGE,type:"focus-search"});
  assert.equal(app.localSearch(1).hidden,false);
  assert.equal(app.localSearch(0).hidden,true);
  assert.equal(app.localSearch(2).hidden,true);
  app.localSearch(1).children[0].value="仅本栏";
  app.calls.length=0;
  await app.localSearch(1).fire("submit");
  assert.deepEqual(app.calls.filter(call=>call.type==="find").map(call=>call.index),[1]);
});

function wireReader(app, index, top, max) {
  let listener, frame=0;
  const callbacks=new Map(), events=new Map();
  const root={scrollTop:top,scrollHeight:max+600,clientHeight:600,style:{scrollBehavior:"auto"},contains:target=>target===root,querySelector:()=>({innerText:`文档 ${index}`}),getBoundingClientRect:()=>({top:0})};
  const context=vm.createContext({
    location:{origin:core.ORIGIN,pathname:`/wiki/Sample${index}`,ancestorOrigins:["chrome-extension://synthetic-extension"]},
    document:{documentElement:{classList:{add(){},remove(){}}},querySelector:()=>root,createTreeWalker:()=>({nextNode:()=>null}),addEventListener:(type,fn)=>{events.set(type,fn);}},
    chrome:{runtime:{id:"synthetic-extension",sendMessage:message=>app.fromReader(index,message),onMessage:{addListener:fn=>{listener=fn;},removeListener(){}}}},
    NodeFilter:{SHOW_TEXT:4},AbortController,matchMedia:()=>({matches:false}),performance:{now:()=>10000},Date:{now:()=>10000},
    requestAnimationFrame:fn=>{const id=++frame;callbacks.set(id,fn);return id;},cancelAnimationFrame:id=>callbacks.delete(id)
  });
  vm.runInContext(readFileSync(new URL("../extension/reader.js",import.meta.url),"utf8"),context);
  app.attach(index,message=>new Promise(resolve=>listener(message,{id:"synthetic-extension"},resolve)));
  return {root,fire:type=>events.get(type)?.({target:root,isTrusted:true}),flush(){const pending=[...callbacks.values()];callbacks.clear();pending.forEach(fn=>fn(10000));}};
}

test("实际三份 reader 与 controller 联通：中栏先发生位移，两侧接收快照并移动且不循环", async () => {
  const app=await controller();
  const left=wireReader(app,0,100,19400);
  const middle=wireReader(app,1,2000,38800);
  const right=wireReader(app,2,1000,30000);
  await new Promise(resolve=>setImmediate(resolve));
  app.elements.sync.checked=true;
  await app.elements.sync.fire("change");
  app.calls.length=0;
  middle.root.scrollTop=4400;
  middle.fire("wheel");middle.fire("scroll");middle.flush();
  await new Promise(resolve=>setImmediate(resolve));
  const progress=2400/(38800-2000);
  assert.ok(Math.abs(left.root.scrollTop-(100+progress*(19400-100)))<1e-6);
  assert.ok(Math.abs(right.root.scrollTop-(1000+progress*(30000-1000)))<1e-6);
  assert.equal(middle.root.scrollTop,4400);
  assert.equal(app.calls.filter(call=>call.type==="scroll").length,2);
  left.fire("scroll");left.flush();right.fire("scroll");right.flush();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.calls.filter(call=>call.type==="scroll").length,2);
});

test("阅读大小可统一放大缩小及恢复，限制范围并暂停联动后重新校准", async () => {
  const app=await controller();
  app.elements.sync.checked=true;
  app.calls.length=0;
  await app.elements["font-larger"].fire("click");
  assert.equal(app.elements["font-reset"].textContent,"110%");
  assert.equal(app.elements.workspace.style["--reading-scale"],"1.1");
  assert.ok(app.calls.slice(0,3).every(call=>call.type==="sync" && call.enabled===false));
  assert.ok(app.calls.slice(-3).every(call=>call.type==="sync" && call.enabled===true));
  await app.elements["font-reset"].fire("click");
  assert.equal(app.elements.workspace.style["--reading-scale"],"1");
  for(let i=0;i<10;i++)await app.elements["font-smaller"].fire("click");
  assert.equal(app.elements["font-reset"].textContent,"80%");
  assert.equal(app.elements["font-smaller"].disabled,true);
  for(let i=0;i<10;i++)await app.elements["font-larger"].fire("click");
  assert.equal(app.elements["font-reset"].textContent,"150%");
  assert.equal(app.elements["font-larger"].disabled,true);
});

test("跟随只转发有效的最新位置，附加递增序号而不再累计距离", async () => {
  const app=await controller();
  app.elements.sync.checked=true;
  app.calls.length=0;
  app.scroll(0,{progress:0.2,anchors:[{text:"每日任务",offset:0.2}]});
  app.scroll(0,{progress:0.4,anchors:[]});
  await new Promise(resolve=>setImmediate(resolve));
  const calls=app.calls.filter(call=>call.type==="scroll");
  assert.equal(calls.length,4);
  assert.deepEqual(calls.map(call=>call.index),[1,2,1,2]);
  assert.deepEqual(calls.map(call=>call.revision),[1,1,2,2]);
  assert.ok(calls.every(call=>!Object.hasOwn(call,"delta")));
  app.scroll(0,{progress:Infinity,anchors:[]});
  app.scroll(0,{progress:0.5,anchors:new Array(4)});
  app.elements.sync.checked=false;
  app.scroll(0,{progress:0.5,anchors:[]});
  assert.equal(app.calls.filter(call=>call.type==="scroll").length,4);
});

test("重新打开本次会话沿用阅读大小，非法设置回退为默认值", async () => {
  const saved=await controller([3],130);
  assert.equal(saved.elements["font-reset"].textContent,"130%");
  assert.equal(saved.elements.workspace.style["--reading-scale"],"1.3");
  const invalid=await controller([3],999);
  assert.equal(invalid.elements.workspace.style["--reading-scale"],"1");
});

test("统一切换排除未选、零匹配与单处匹配；更改关键词后须先搜索", async () => {
  const app = await controller([3, 0, 1, 3]);
  await app.search();
  const check = app.pane(3).children[0];
  check.checked = false;
  await check.fire("change");
  await app.elements["next-all"].fire("click");
  assert.deepEqual(app.positions, [2, 0, 1, 1]);
  assert.deepEqual(app.calls.filter(call => call.type === "next").map(call => call.index), [0]);
  app.elements.query.value = "新关键词";
  await app.elements.query.fire("input");
  assert.equal(app.elements["next-all"].disabled, true);
});

test("切换期间阻止重复操作；一栏失败不阻塞其他栏且恢复可重试状态", async () => {
  const app = await controller();
  await app.search();
  app.hold();
  app.fail(1);
  const pending = app.elements["next-all"].fire("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.elements["next-all"].disabled, true);
  assert.equal(app.elements.search.disabled, true);
  await app.elements["next-all"].fire("click");
  app.release();
  await pending;
  assert.deepEqual(app.positions, [2, 1, 2]);
  assert.equal(app.calls.filter(call => call.type === "next").length, 3);
  assert.equal(app.elements["next-all"].disabled, false);
  assert.match(app.elements.notice.textContent, /合成导航失败/);
});
