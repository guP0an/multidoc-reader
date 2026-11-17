import { ORIGIN, MESSAGE, documentKey, documentLinks, documentForFrame } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const api = globalThis.chrome?.runtime?.id ? chrome : null;
let documents = [];
let tabId;
let connected = false;
let searching = false;
let syncQueue = Promise.resolve();
let noticeTimer;
let scrollRevision = 0;
let readingScale = 100;
let resizing = false;

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !text;
  if (!error) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4500);
}

function errorText(error) {
  const text = error?.message || "暂时无法连接文档。";
  if (/Cannot access|permission|receiving end|Could not establish/i.test(text)) return "尚未连上这份文档，请连接飞书后重新载入本栏。";
  return text;
}

function save() {
  return api.storage.session.set({ readingScale, documents: documents.map(({ key, title, selected }) => ({ key, title, selected })) });
}

function controls() {
  const selected = documents.filter((doc) => doc.selected);
  $("count").textContent = documents.length;
  $("empty").hidden = documents.length > 0;
  $("search").disabled = !selected.length || searching || resizing || !connected;
  const canNavigate = selected.some((doc) => doc.ready && !doc.busy && doc.query === $("query").value.trim() && matchCount(doc) > 1);
  $("previous-all").disabled = $("next-all").disabled = !connected || searching || resizing || documents.some((doc) => doc.busy) || !canNavigate;
  $("sync").disabled = selected.length < 2 || searching || resizing || !connected;
  $("add").disabled = !api || searching || resizing;
  $("font-smaller").disabled = !api || searching || resizing || readingScale <= 80;
  $("font-larger").disabled = !api || searching || resizing || readingScale >= 150;
  $("font-reset").disabled = !api || searching || resizing || readingScale === 100;
  $("font-reset").textContent = `${readingScale}%`;
  $("connect").hidden = connected || !api;
  if (selected.length < 2) $("sync").checked = false;
  documents.forEach((doc) => {
    doc.check.disabled = searching || resizing;
    doc.previous.disabled = doc.next.disabled = !doc.ready || searching || resizing || doc.busy || !doc.query || matchCount(doc) < 2;
    doc.reload.disabled = doc.remove.disabled = searching || resizing || doc.busy;
    doc.localFind.disabled = !doc.ready || searching || resizing || doc.busy;
    doc.localQuery.disabled = searching || resizing || doc.busy;
  });
}

function matchCount(doc) {
  return Number(doc.counter?.match(/^\d+\s*\/\s*(\d+)$/)?.[1]) || 0;
}

function status(doc, text, error = false) {
  doc.status.textContent = text;
  doc.status.title = doc.query ? `${doc.query} · ${text}` : text;
  doc.counter = /^\d+\s*\/\s*\d+$/.test(text) ? text : null;
  controls();
  if (error) {
    doc.messageText.textContent = text;
    doc.message.classList.add("error");
    doc.message.hidden = false;
  }
}

async function send(doc, type, data = {}) {
  if (!doc.ready || !Number.isInteger(doc.frameId)) throw new Error("原文档尚未载入，请稍候或重新载入本栏。");
  const target = doc.documentId ? { documentId: doc.documentId } : { frameId: doc.frameId };
  const result = await api.tabs.sendMessage(tabId, { namespace: MESSAGE, type, ...data }, target);
  if (!result?.ok) throw new Error(result?.error || "文档未能完成操作，请重新载入本栏。");
  return result;
}

function applySync() {
  syncQueue = syncQueue.then(async () => {
    await Promise.all(documents.filter((doc) => doc.ready).map(async (doc) => {
      try { await send(doc, "sync", { enabled: $("sync").checked && doc.selected && !searching && !resizing }); }
      catch (error) { status(doc, errorText(error), true); }
    }));
  });
  return syncQueue;
}

function button(text, label, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.setAttribute("aria-label", label);
  element.title = label;
  element.addEventListener("click", () => Promise.resolve(action()).catch((error) => notice(errorText(error), true)));
  return element;
}

function load(doc) {
  if (!connected) {
    doc.messageText.textContent = "连接飞书后，在这里显示原文档。";
    return;
  }
  clearTimeout(doc.timeout);
  doc.ready = false;
  doc.query = null;
  doc.frameId = null;
  doc.documentId = undefined;
  doc.message.classList.remove("error");
  doc.messageText.textContent = "正在载入原文档…";
  doc.message.hidden = false;
  status(doc, "载入中");
  doc.frame.src = doc.key;
  doc.timeout = setTimeout(() => {
    if (doc.ready) return;
    status(doc, "原文档未能连接。可重新载入，或打开原文确认登录及阅读权限。", true);
  }, 22000);
  controls();
}

function addPane(record) {
  const doc = { ...record, ready: false, frameId: null, busy: false };
  const pane = document.createElement("section");
  pane.className = "document-pane";
  const bar = document.createElement("div");
  bar.className = "pane-bar";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = doc.selected;
  check.setAttribute("aria-label", `${doc.title}参与搜索和联动`);
  check.addEventListener("change", async () => {
    doc.selected = check.checked;
    controls();
    await save();
    await applySync();
  });
  const index = document.createElement("span");
  index.className = "pane-index";
  index.setAttribute("aria-hidden", "true");
  index.textContent = String(documents.length + 1).padStart(2, "0");
  const title = document.createElement("h2");
  title.className = "pane-title";
  title.textContent = doc.title;
  title.title = doc.title;
  const count = document.createElement("span");
  count.className = "match-count";
  count.textContent = "待连接";
  const localPanel = document.createElement("form");
  localPanel.className = "local-search";
  localPanel.hidden = true;
  const localQuery = document.createElement("input");
  localQuery.type = "search";
  localQuery.maxLength = 200;
  localQuery.placeholder = "只搜索这份文档";
  localQuery.setAttribute("aria-label", `${doc.title}：独立搜索关键词`);
  const localFind = document.createElement("button");
  localFind.type = "submit";
  localFind.className = "local-find";
  localFind.textContent = "定位";
  const closeLocal = button("×", "收起本栏搜索", () => { localPanel.hidden = true; applySync(); });
  localPanel.append(localQuery, localFind, closeLocal);
  localPanel.addEventListener("submit", (event) => {
    event.preventDefault();
    return findInDocuments([doc], localQuery.value.trim());
  });
  localQuery.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); localPanel.hidden = true; applySync(); }
  });
  const openLocal = button("⌕", "只搜索这份文档（⌘F / Ctrl+F）", () => openLocalSearch(doc));
  openLocal.className = "open-local-search";
  const move = (direction) => () => navigateMatches([doc], direction);
  const previous = button("‹", `${doc.title}：上一处匹配`, move(-1));
  const next = button("›", `${doc.title}：下一处匹配`, move(1));
  const reload = button("↻", "重新载入这一栏", () => load(doc));
  reload.className = "reload-document";
  const remove = button("×", "移除此栏，不修改原文", async () => {
    clearTimeout(doc.timeout);
    if (doc.ready) try { await send(doc, "disconnect"); } catch { /* 移除 iframe 本身也会销毁其脚本。 */ }
    documents = documents.filter((item) => item !== doc);
    pane.remove();
    await save();
    controls();
    await applySync();
  });
  remove.className = "remove-document";
  bar.append(check, index, title, count, openLocal, previous, next, reload, remove);
  const wrap = document.createElement("div");
  wrap.className = "frame-wrap";
  const frame = document.createElement("iframe");
  frame.title = doc.title;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  const message = document.createElement("div");
  message.className = "pane-message";
  const messageText = document.createElement("p");
  const retry = button("重新载入", "重新载入这一栏", () => load(doc));
  const open = button("打开原文", "在新标签页确认原文登录和阅读权限", () => api.tabs.create({ url: doc.key }));
  message.append(messageText, retry, open);
  wrap.append(frame, message);
  pane.append(bar, localPanel, wrap);
  Object.assign(doc, { pane, check, titleNode: title, status: count, previous, next, reload, remove, frame, message, messageText, localPanel, localQuery, localFind });
  documents.push(doc);
  $("workspace").append(pane);
  load(doc);
  controls();
  return doc;
}

function openLocalSearch(doc) {
  if (doc.localPanel.hidden) doc.localQuery.value = doc.query || "";
  doc.localPanel.hidden = false;
  doc.localQuery.focus();
  doc.localQuery.select();
  applySync();
}

async function registerReader() {
  const id = "multidoc-reader-frames";
  const script = { id, matches: [`${ORIGIN}/wiki/*`, `${ORIGIN}/docx/*`], allFrames: true, js: ["reader.js"], css: ["frame.css"], runAt: "document_idle", persistAcrossSessions: false };
  if ((await api.scripting.getRegisteredContentScripts({ ids: [id] })).length) await api.scripting.updateContentScripts([script]);
  else await api.scripting.registerContentScripts([script]);
}

async function enableConnection(request) {
  const permission = { origins: [`${ORIGIN}/*`] };
  const allowed = request ? await api.permissions.request(permission) : await api.permissions.contains(permission);
  if (!allowed) { connected = false; controls(); return false; }
  await registerReader();
  connected = true;
  controls();
  documents.filter((doc) => !doc.ready).forEach(load);
  return true;
}

function showToolbar() {
  $("toolbar").hidden = false;
  $("reveal").hidden = true;
}
function openAdd() { showToolbar(); $("add-error").hidden = true; $("add-dialog").showModal(); $("urls").focus(); }
$("add-open").addEventListener("click", openAdd);
$("empty-add").addEventListener("click", openAdd);
$("add-close").addEventListener("click", () => $("add-dialog").close());
$("collapse").addEventListener("click", () => { $("toolbar").hidden = true; $("notice").hidden = true; $("reveal").hidden = false; });
$("reveal").addEventListener("click", () => { showToolbar(); $("query").focus(); });
$("connect").addEventListener("click", async () => {
  try { if (!await enableConnection(true)) notice("尚未授予飞书访问权限。", true); }
  catch (error) { notice(errorText(error), true); }
});
$("fullscreen").addEventListener("click", async () => {
  try {
    const window = await api.windows.getCurrent();
    await api.windows.update(window.id, { state: window.state === "fullscreen" ? "normal" : "fullscreen" });
  } catch (error) { notice(errorText(error), true); }
});

function applyReadingScale() {
  $("workspace").style.setProperty("--reading-scale", String(readingScale / 100));
}

async function resizeReading(value) {
  if (!api || searching || resizing) return;
  resizing = true;
  controls();
  try {
    await applySync();
    readingScale = Math.max(80, Math.min(150, value));
    applyReadingScale();
    await save();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } catch (error) { notice(errorText(error), true); }
  finally {
    resizing = false;
    controls();
    await applySync();
  }
}
$("font-smaller").addEventListener("click", () => resizeReading(readingScale - 10));
$("font-larger").addEventListener("click", () => resizeReading(readingScale + 10));
$("font-reset").addEventListener("click", () => resizeReading(100));

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    if (event.target.closest?.(".local-search")) { event.preventDefault(); event.target.focus(); event.target.select(); return; }
    event.preventDefault(); showToolbar(); $("query").focus(); $("query").select();
  }
});

$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!api || searching || resizing) return;
  try {
    const urls = documentLinks($("urls").value);
    if (!urls.length) throw new Error("请粘贴至少一份飞书文档链接。");
    $("add").disabled = true;
    if (!await enableConnection(true)) throw new Error("未授予飞书访问权限，尚未添加文档。");
    for (const url of urls) {
      const key = documentKey(url);
      if (!documents.some((doc) => doc.key === key)) addPane({ key, title: `文档 ${documents.length + 1}`, selected: true });
    }
    await save();
    $("urls").value = "";
    $("add-dialog").close();
  } catch (error) { $("add-error").textContent = errorText(error); $("add-error").hidden = false; }
  finally { controls(); }
});

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  return findInDocuments(documents.filter((doc) => doc.selected), $("query").value.trim());
});

async function findInDocuments(targets, query) {
  if (!api || searching || resizing || documents.some((doc) => doc.busy)) return;
  if (!query || !targets.length) return;
  searching = true;
  controls();
  await applySync();
  let failed = 0;
  let found = 0;
  await Promise.all(targets.map(async (doc) => {
    try {
      doc.query = null;
      status(doc, "定位中");
      const result = await send(doc, "find", { query });
      doc.query = query;
      doc.localQuery.value = query;
      status(doc, result.counter);
      doc.message.hidden = true;
      if (/\d+\s*\/\s*[1-9]\d*/.test(result.counter)) found++;
    }
    catch (error) { failed++; status(doc, errorText(error), true); }
  }));
  searching = false;
  controls();
  await applySync();
  if (failed) notice(`${failed} 栏尚未定位，请查看各栏提示；其他文档可以继续阅读。`, true);
  else if (targets.length === 1) notice(found ? "已在这份文档内定位。用本栏的 ‹ › 切换结果。" : "这份文档中没有找到这个关键词。");
  else notice(found ? `${found} 栏有匹配${targets.length > found ? `，${targets.length - found} 栏无匹配` : ""}。顶部“上一处／下一处”可一起切换。` : "所选文档中没有找到这个关键词，可换个名称再试。");
}

async function navigateMatches(targets, direction) {
  if (!api || searching || resizing || documents.some((doc) => doc.busy)) return;
  const eligible = targets.filter((doc) => doc.ready && doc.query && matchCount(doc) > 1);
  if (!eligible.length) return;
  searching = true;
  eligible.forEach((doc) => { doc.busy = true; });
  controls();
  let failed = 0;
  try {
    await applySync();
    await Promise.all(eligible.map(async (doc) => {
      try {
        const result = await send(doc, "next", { direction });
        status(doc, result.counter);
        doc.message.hidden = true;
      } catch (error) {
        failed++;
        notice(`${doc.title}：${errorText(error)}`, true);
      }
    }));
  } finally {
    eligible.forEach((doc) => { doc.busy = false; });
    searching = false;
    controls();
    await applySync();
  }
  if (!failed) notice(`${eligible.length} 栏已切换到${direction === 1 ? "下一处" : "上一处"}匹配${eligible.length < targets.length ? "，无匹配或仅一处的文档保持原位" : ""}。`);
}

$("query").addEventListener("input", controls);
for (const [id, direction] of [["previous-all", -1], ["next-all", 1]]) {
  $(id).addEventListener("click", () => navigateMatches(documents.filter((doc) => doc.selected && doc.query === $("query").value.trim()), direction));
}
$("sync").addEventListener("change", () => applySync());

if (api) {
  tabId = (await api.tabs.getCurrent()).id;
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.namespace !== MESSAGE) return;
    const doc = documentForFrame(sender, api.runtime.id, tabId, documents);
    if (!doc) return;
    if (message.type === "ready") {
      respond?.({ ok: true });
      clearTimeout(doc.timeout);
      doc.frameId = sender.frameId;
      doc.documentId = sender.documentId;
      doc.ready = true;
      if (typeof message.title === "string" && message.title.trim()) {
        doc.title = message.title.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").replace(/\s*- Feishu Docs$/, "").slice(0, 160);
        doc.titleNode.textContent = doc.title;
        doc.titleNode.title = doc.title;
        doc.frame.title = doc.title;
        doc.check.setAttribute("aria-label", `${doc.title}参与搜索和联动`);
        doc.previous.setAttribute("aria-label", `${doc.title}：上一处匹配`);
        doc.next.setAttribute("aria-label", `${doc.title}：下一处匹配`);
        doc.previous.title = `${doc.title}：上一处匹配`;
        doc.next.title = `${doc.title}：下一处匹配`;
        doc.localQuery.setAttribute("aria-label", `${doc.title}：独立搜索关键词`);
      }
      doc.message.hidden = true;
      status(doc, "已就绪");
      controls();
      save().catch(() => notice("阅读清单暂时未能保存到本次会话。", true));
      applySync();
      return;
    }
    if (!doc.ready || sender.frameId !== doc.frameId || sender.documentId !== doc.documentId) return;
    if (message.type === "counter" && typeof message.counter === "string") { respond?.({ ok: true }); status(doc, message.counter.slice(0, 60)); }
    if (message.type === "focus-search") { respond?.({ ok: true }); openLocalSearch(doc); }
    if (message.type !== "scroll" || !doc.selected || !$("sync").checked || searching || resizing || !Number.isFinite(message.progress) || Math.abs(message.progress) > 1 || !Array.isArray(message.anchors) || message.anchors.length > 3) return;
    respond?.({ ok: true });
    const revision = ++scrollRevision;
    for (const other of documents.filter((item) => item !== doc && item.selected && item.ready)) {
      send(other, "scroll", { progress: message.progress, anchors: message.anchors, revision }).catch((error) => status(other, errorText(error), true));
    }
  });
  const saved = await api.storage.session.get(["documents", "readingScale"]);
  if (Number.isInteger(saved.readingScale) && saved.readingScale >= 80 && saved.readingScale <= 150) readingScale = saved.readingScale;
  applyReadingScale();
  for (const record of saved.documents || []) {
    try {
      const key = documentKey(record.key);
      if (!documents.some((doc) => doc.key === key)) addPane({ key, title: String(record.title || `文档 ${documents.length + 1}`), selected: record.selected !== false });
    } catch { /* 忽略旧版本清单中已不属于支持范围的链接。 */ }
  }
  try { await enableConnection(false); }
  catch (error) { notice(errorText(error), true); }
} else {
  $("connect").hidden = true;
  $("add").disabled = true;
}
controls();
