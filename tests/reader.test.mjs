import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extension/reader.js", import.meta.url), "utf8");

function reader({ canOpen = true, origin = "https://example.feishu.cn", reduced = false, nativeSearchScroll = null, parentOrigin = "chrome-extension://synthetic-extension", textPositions = [], wideTable = false, navigationEvent = "click", landmarkVisible = true, failFirstScroll = false, landmarkPosition = "static" } = {}) {
  let listener, searchVisible = false, now = 10000, frameId = 0, currentIndex = 0, total = 0;
  const messages = [], readyMessages = [], frames = new Map(), listeners = new Map();
  const location = { origin, pathname: "/wiki/SampleDocument", ancestorOrigins: [parentOrigin] };
  const root = { scrollTop: 100, scrollHeight: 20000, clientHeight: 600, style: { scrollBehavior: "smooth" }, contains: (target) => target === root, getBoundingClientRect: () => ({top:0}),querySelector:()=>({innerText:"合成文档"}) };
  const table = {parentElement:root,closest:()=>null,checkVisibility:()=>landmarkVisible,clientWidth:500,scrollWidth:wideTable?1600:500,scrollLeft:0,getBoundingClientRect:()=>({left:0,right:500})};
  class Input {
    get value() { return this.query || ""; }
    set value(query) { this.query = query; }
    focus() {}
    getBoundingClientRect() { return { width: 200 }; }
    closest(selector) {
      if (selector === ".find-field") return { get textContent() { return `${currentIndex} / ${total}`; } };
      if (selector === ".find-replace-box-wrapper") return panel;
    }
    dispatchEvent(event) {
      if (event.type === "input") {
        if (this.value === this.reportedValue) return;
        this.reportedValue = this.value;
        total = this.value === "每日任务" ? 3 : 0; currentIndex = total ? 1 : 0;
        if (nativeSearchScroll !== null) { root.scrollTop = nativeSearchScroll; fire("scroll"); }
      }
    }
  }
  const input = new Input();
  const panel = { setAttribute(){},removeAttribute(){},querySelectorAll: () => ["Previous", "Next"].map((textContent) => ({
    textContent, get disabled() { return !total; }, getBoundingClientRect: () => ({ width: 40 }),
    dispatchEvent(event){if(navigationEvent==="mousedown" && event.type==="mousedown") currentIndex=(currentIndex-1+(textContent==="Next"?1:-1)+total)%total+1;},
    click: () => { currentIndex = (currentIndex - 1 + (textContent === "Next" ? 1 : -1) + total) % total + 1; }
  })) };
  class DOMEvent { constructor(type, properties = {}) { this.type = type; Object.assign(this, properties); } }
  const document = {
    documentElement: {classList:{add(){},remove(){}}},
    title: "合成文档",
    body: { dispatchEvent: () => { searchVisible = canOpen; } },
    querySelector: () => root,
    querySelectorAll: () => searchVisible ? [input] : [],
    createTreeWalker: () => {
      const nodes = textPositions.map(top => ({nodeValue:"每日任务",parentElement:table,top}));
      return {nextNode:()=>nodes.shift()};
    },
    createRange: () => {
      let node;
      return {get startContainer(){return node;},setStart:value=>{node=value;},setEnd(){},getBoundingClientRect:()=>({width:80,height:20,top:node.top-root.scrollTop,left:wideTable?1000-table.scrollLeft:0,right:wideTable?1080-table.scrollLeft:80})};
    },
    addEventListener: (type, fn, options) => {
      const entries = listeners.get(type) || [];
      entries.push({ fn, signal: options.signal });
      listeners.set(type, entries);
    }
  };
  const runtime = {
    id: "synthetic-extension",
    sendMessage: async (message) => {
      (message.type === "ready" ? readyMessages : messages).push(message);
      if(message.type === "scroll" && failFirstScroll){failFirstScroll=false;throw new Error("合成消息发送失败");}
    },
    onMessage: { addListener: (fn) => { listener = fn; }, removeListener: () => { listener = null; } }
  };
  const context = vm.createContext({
    chrome: { runtime }, document, location, HTMLInputElement: Input, Event: DOMEvent, KeyboardEvent: DOMEvent, MouseEvent: DOMEvent,
    navigator: { platform: "MacIntel" }, AbortController, NodeFilter:{SHOW_TEXT:4},
    MutationObserver: class { observe() {} disconnect() {} },
    Date: { now: () => now }, setTimeout: (fn, ms) => setTimeout(() => { now += ms === 260 ? 0 : ms; fn(); }, 0),
    performance: { now: () => now }, matchMedia: () => ({ matches: reduced }), getComputedStyle:()=>({overflowX:"auto",position:landmarkPosition}),
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id)
  });
  vm.runInContext(source, context);
  const receive = (message, sender = { id: runtime.id }) => new Promise((resolve) => {
    if (!listener || listener({ namespace: "multi-doc-reader", ...message }, sender, (value) => resolve(structuredClone(value))) !== true) resolve(undefined);
  });
  const fire = (type, data = {}) => {
    for (const entry of listeners.get(type) || []) if (!entry.signal.aborted) entry.fn({ target: root, isTrusted: true, ...data });
  };
  const flush = (ms = 0) => { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(now)); };
  return { receive, fire, flush, root, table, messages, readyMessages, location, context, advance: (ms) => { now += ms; } };
}

test("搜索与逐份切换使用飞书查找计数，不改写正文", async () => {
  const page = reader();
  assert.deepEqual(await page.receive({ type: "find", query: "每日任务" }), { ok: true, counter: "1 / 3" });
  assert.equal((await page.receive({ type: "next", direction: 1 })).counter, "2 / 3");
  assert.equal((await page.receive({ type: "next", direction: -1 })).counter, "1 / 3");
  assert.equal((await page.receive({ type: "find", query: "无匹配" })).counter, "0 / 0");
  assert.equal((await page.receive({ type: "next", direction: 1 })).ok, false);
  assert.ok(page.messages.every((message) => message.type === "counter" && !Object.hasOwn(message, "query")));
});

test("拒绝不受支持的页面、外部消息和无效查找参数", async () => {
  assert.equal(await reader({ origin: "https://example.org" }).receive({ type: "sync", enabled: true }), undefined);
  const page = reader();
  assert.equal(await page.receive({ type: "find", query: "每日任务" }, { id: "other-extension" }), undefined);
  assert.equal((await page.receive({ type: "find", query: " " })).ok, false);
  assert.equal((await page.receive({ type: "find", query: "x".repeat(201) })).ok, false);
  assert.equal((await page.receive({ type: "next", direction: 2 })).ok, false);
  page.location.pathname = "/wiki/DifferentDocument";
  assert.equal((await page.receive({ type: "scroll", delta: 200 })).ok, false);
  assert.equal(page.root.scrollTop, 100);
});

test("快捷键未能打开飞书查找时明确失败，不能冒充定位成功", async () => {
  const result = await reader({ canOpen: false }).receive({ type: "find", query: "每日任务" });
  assert.equal(result.ok, false);
  assert.match(result.error, /查找尚未就绪/);
});

test("独立模式不广播；用户滚动只发送最新位置；跟随立即生效且不反馈循环", async () => {
  const page = reader();
  page.fire("wheel"); page.root.scrollTop += 20; page.fire("scroll"); page.flush();
  assert.equal(page.messages.length, 0);
  await page.receive({ type: "sync", enabled: true });
  page.fire("wheel"); page.root.scrollTop += 40; page.fire("scroll");
  page.root.scrollTop += 60; page.fire("scroll"); page.flush();
  assert.equal(page.messages.length, 1);
  assert.ok(Math.abs(page.messages[0].progress - 100 / (19400-120)) < 1e-8);
  assert.equal(page.messages[0].delta, undefined);
  await page.receive({ type: "scroll", progress: 0.5, anchors: [], revision: 1 });
  assert.equal(page.root.scrollTop, 9760);
  page.fire("scroll"); page.flush();
  assert.equal(page.messages.length, 1);
  assert.equal(page.root.style.scrollBehavior, "smooth");
});

test("滚动位置先更新、再投递 wheel 和 scroll 时仍广播最新位置", async () => {
  const page=reader();
  await page.receive({type:"sync",enabled:true});
  page.root.scrollTop+=240;
  page.fire("wheel");
  page.fire("scroll");
  page.flush();
  assert.equal(page.messages.filter(message=>message.type==="scroll").length,1);
  assert.ok(page.messages[0].progress>0);
});

test("有几何尺寸的隐藏文字不能作为跟随依据", async () => {
  const page=reader({textPositions:[1000],landmarkVisible:false});
  await page.receive({type:"sync",enabled:true});
  await page.receive({type:"scroll",progress:0.5,anchors:[{text:"每日任务",offset:.2}],revision:1});
  assert.equal(page.root.scrollTop,9750);
});

test("吸顶表头或固定浮层不能把跟随位置锁回表头", async () => {
  for (const landmarkPosition of ["sticky", "fixed"]) {
    const page=reader({textPositions:[1000],landmarkPosition});
    await page.receive({type:"sync",enabled:true});
    await page.receive({type:"scroll",progress:0.5,anchors:[{text:"每日任务",offset:0.2}],revision:1});
    assert.equal(page.root.scrollTop,9750);
  }
});

test("一次临时消息失败不会静默关闭下一次滚动联动", async () => {
  const page=reader({failFirstScroll:true});
  await page.receive({type:"sync",enabled:true});
  page.fire("wheel");page.root.scrollTop+=40;page.fire("scroll");page.flush();
  await new Promise(resolve=>setImmediate(resolve));
  page.fire("wheel");page.root.scrollTop+=40;page.fire("scroll");page.flush();
  assert.equal(page.messages.filter(message=>message.type==="scroll").length,2);
});

test("位置快照不累加误差；忽略乱序消息；不同文档长度按相对进度跟随", async () => {
  const page = reader();
  page.root.scrollHeight=10600;
  page.root.scrollTop=1000;
  await page.receive({type:"sync",enabled:true});
  await page.receive({type:"scroll",progress:0.5,anchors:[],revision:2});
  assert.equal(page.root.scrollTop,5500);
  await page.receive({type:"scroll",progress:0.5,anchors:[],revision:3});
  assert.equal(page.root.scrollTop,5500);
  await page.receive({type:"scroll",progress:0.1,anchors:[],revision:1});
  assert.equal(page.root.scrollTop,5500);
  await page.receive({type:"scroll",progress:-0.5,anchors:[],revision:4});
  assert.equal(page.root.scrollTop,500);
  await page.receive({type:"scroll",progress:2,anchors:[],revision:5});
  assert.equal(page.root.scrollTop,500);
});

test("共同正文片段优先对齐到同一视口位置，校正不同区服排版偏差", async () => {
  const page=reader({textPositions:[1000]});
  await page.receive({type:"sync",enabled:true});
  await page.receive({type:"scroll",progress:0.5,anchors:[{text:"每日任务",offset:0.2}],revision:1});
  assert.equal(page.root.scrollTop,880);
});

test("搜索后的最终位置仍使用先快后慢校正，手动操作可中断", async () => {
  const page=reader({textPositions:[1000]});
  await page.receive({type:"find",query:"每日任务"});
  page.flush(60); const first=page.root.scrollTop;
  page.flush(60); const second=page.root.scrollTop;
  assert.ok(first-100 > second-first);
  assert.equal(second,803.5);
  page.fire("wheel"); page.flush(500);
  assert.equal(page.root.scrollTop,second);
});

test("减少动态效果时搜索直接定位；跟随位置始终限制在文档内", async () => {
  const page=reader({reduced:true,textPositions:[1000]});
  await page.receive({type:"find",query:"每日任务"});
  assert.equal(page.root.scrollTop,904);
  await page.receive({type:"sync",enabled:true});
  await page.receive({type:"scroll",progress:1,anchors:[],revision:1});
  assert.equal(page.root.scrollTop,19400);
  await page.receive({type:"scroll",progress:-1,anchors:[],revision:2});
  assert.equal(page.root.scrollTop,0);
});

test("保留飞书原生跳转，不将查找位移回传为新的联动输入", async () => {
  const page = reader({ nativeSearchScroll: 900 });
  await page.receive({ type: "sync", enabled: true });
  const pending = page.receive({ type: "find", query: "每日任务" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.root.scrollTop, 900);
  page.flush(120);
  assert.equal(page.root.scrollTop, 900);
  await pending;
  page.flush(120);
  assert.equal(page.root.scrollTop, 900);
  assert.ok(page.messages.every((message) => message.type !== "scroll"));
});

test("暂停联动取消未广播的滚动，切换页面和移除后也不再广播", async () => {
  const page = reader();
  await page.receive({ type: "sync", enabled: true });
  page.fire("wheel"); page.root.scrollTop += 40; page.fire("scroll");
  await page.receive({ type: "sync", enabled: false });
  await page.receive({ type: "sync", enabled: true });
  page.flush();
  assert.equal(page.messages.length, 0);
  page.location.pathname = "/wiki/DifferentDocument";
  page.fire("wheel"); page.root.scrollTop += 20; page.fire("scroll"); page.flush();
  assert.equal(page.messages.length, 0);
  page.location.pathname = "/wiki/SampleDocument";
  await page.receive({ type: "disconnect" });
  assert.equal(page.context.__multiDocReader, undefined);
  assert.equal(await page.receive({ type: "sync", enabled: true }), undefined);
});

test("扩展没有网络上传、Cookie 权限、外部依赖和常驻页面注入", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["scripting", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://example.feishu.cn/*"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  assert.match(manifest.content_security_policy.extension_pages, /frame-src https:\/\/example\.feishu\.cn;/);
  for (const name of ["reader.js", "controller.mjs", "background.js"]) {
    const code = readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(code, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\s*\(|document\.cookie|chrome\.cookies|storage\.(local|sync)/);
  }
});

test("飞书单页导航后可重新连接，不会残留旧文档的控制脚本", async () => {
  const page = reader();
  await page.receive({ type: "sync", enabled: true });
  page.location.pathname = "/wiki/DifferentDocument";
  assert.equal((await page.receive({ type: "sync", enabled: true })).ok, false);
  vm.runInContext(source, page.context);
  assert.equal((await page.receive({ type: "sync", enabled: true })).ok, true);
  page.fire("wheel"); page.root.scrollTop += 20; page.fire("scroll"); page.flush();
  assert.equal(page.messages.filter((message) => message.type === "scroll").length, 1);
});

test("原生查找落在长表格时，将实际匹配文字移到正文上沿附近", async () => {
  const page = reader({textPositions:[1000,4000]});
  assert.equal((await page.receive({type:"find",query:"每日任务"})).ok,true);
  page.flush(240);
  assert.equal(page.root.scrollTop,904);
});

test("普通飞书标签和其他网站嵌入不能启用正文控制脚本", async () => {
  for (const parentOrigin of [undefined,"https://example.feishu.cn","https://example.org","chrome-extension://another-extension"]) {
    const page=reader({parentOrigin:parentOrigin === undefined ? "" : parentOrigin});
    assert.equal(await page.receive({type:"sync",enabled:true}),undefined);
    assert.equal(page.context.__multiDocReader,undefined);
    assert.equal(page.readyMessages.length,0);
  }
});

test("关键词落在宽表格右侧时同步调整表格横向视口", async () => {
  const page=reader({textPositions:[1000],wideTable:true});
  await page.receive({type:"find",query:"每日任务"});
  assert.equal(page.table.scrollLeft,790);
});

test("同一关键词再次定位也会重建匹配位置", async () => {
  const page=reader();
  await page.receive({type:"find",query:"每日任务"});
  await page.receive({type:"next",direction:1});
  assert.equal((await page.receive({type:"find",query:"每日任务"})).counter,"1 / 3");
});

test("原生按钮在按下时已切换结果，不重复发送 click 跳过一处", async () => {
  const page=reader({navigationEvent:"mousedown"});
  await page.receive({type:"find",query:"每日任务"});
  assert.equal((await page.receive({type:"next",direction:1})).counter,"2 / 3");
});
