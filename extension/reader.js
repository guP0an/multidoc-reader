(() => {
  if (location.origin !== "https://example.feishu.cn" || !/^\/(wiki|docx)\/[A-Za-z0-9]+\/?$/.test(location.pathname)) return;
  if (location.ancestorOrigins?.[0] !== `chrome-extension://${chrome.runtime.id}`) return;
  if (globalThis.__multiDocReader?.path === location.pathname) return;
  globalThis.__multiDocReader?.disconnect();
  document.documentElement.classList.add("multidoc-reader-frame");
  const namespace = "multi-doc-reader";
  const path = location.pathname;
  const events = new AbortController();
  let enabled = false;
  let lastTop = 0;
  let userUntil = 0;
  let pointerHeld = false;
  let suppressUntil = 0;
  let frame = 0;
  let originTop = 0;
  let lastRevision = 0;
  let landmarkCache = [];
  let landmarksAt = -Infinity;
  let counterObserver;
  let lastCounter = "";
  let finding = false;
  let motionFrame = 0;
  let restoreScrollBehavior;
  let operation = 0;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const root = () => document.querySelector(".bear-web-x-container");
  const current = () => location.pathname === path;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => element && element.getBoundingClientRect().width > 0;
  const findInput = () => Array.from(document.querySelectorAll(".find-field input")).find(visible);
  const box = () => findInput()?.closest(".find-replace-box-wrapper");
  const counter = () => {
    const text = findInput()?.closest(".find-field")?.textContent || "";
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    return match ? `${match[1]} / ${match[2]}` : "等待查找结果";
  };

  const normalizeText = (text) => text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\s]/g, "").trim();

  function isReadingText(node) {
    const element = node.parentElement;
    if (!element || node.isConnected === false || element.closest("script,style,input,textarea,button,[role=button],.catalogue-container,.catalogue,.find-replace-box-wrapper,[aria-hidden=true],.docCommentContainer,#docCommentContainer,[class*=watermark]")) return false;
    const scroller = root();
    // 吸顶表头与固定浮层不随正文移动，不能用来校正阅读位置。
    for (let parent = element; parent && parent !== scroller; parent = parent.parentElement) {
      const position = getComputedStyle(parent).position;
      if (position === "sticky" || position === "fixed") return false;
    }
    return !element.checkVisibility || element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function landmarks(scroller) {
    if (performance.now() - landmarksAt < 100) return landmarkCache.filter((item) => isReadingText(item.node));
    landmarksAt = performance.now();
    landmarkCache = [];
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!isReadingText(node)) continue;
      const text = normalizeText(node.nodeValue);
      if (text.length < 4 || text.length > 240) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.nodeValue.length);
      landmarkCache.push({ text, node, range });
    }
    return landmarkCache;
  }

  function scrollPosition(scroller) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const travel = scroller.scrollTop - originTop;
    const span = travel >= 0 ? max - originTop : originTop;
    const progress = span > 0 ? Math.max(-1, Math.min(1, travel / span)) : 0;
    const bounds = scroller.getBoundingClientRect();
    const anchors = landmarks(scroller).map((item) => {
      const rect = item.range.getBoundingClientRect();
      return { text: item.text, offset: (rect.top - bounds.top) / scroller.clientHeight, width: rect.width, height: rect.height };
    }).filter((item) => item.width > 0 && item.height > 0 && item.offset >= 0 && item.offset < 0.8)
      .sort((a, b) => Math.abs(a.offset - 0.2) - Math.abs(b.offset - 0.2)).slice(0, 3)
      .map(({ text, offset }) => ({ text, offset }));
    return { progress, anchors };
  }

  function followPosition(scroller, message) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let target = originTop + message.progress * (message.progress >= 0 ? max - originTop : originTop);
    const bounds = scroller.getBoundingClientRect();
    const items = landmarks(scroller);
    for (const anchor of message.anchors) {
      if (typeof anchor?.text !== "string" || anchor.text.length < 4 || anchor.text.length > 240 || !Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1) continue;
      const matches = items.filter((item) => item.text === anchor.text).map((item) => {
        const rect = item.range.getBoundingClientRect();
        return rect.width && rect.height ? scroller.scrollTop + rect.top - bounds.top - anchor.offset * scroller.clientHeight : null;
      }).filter((top) => top !== null);
      if (matches.length) {
        target = matches.reduce((best, top) => Math.abs(top - target) < Math.abs(best - target) ? top : best);
        break;
      }
    }
    stopMotion();
    const previous = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop = Math.max(0, Math.min(max, target));
    lastTop = scroller.scrollTop;
    scroller.style.scrollBehavior = previous;
  }

  function matchPosition(query) {
    const scroller = root();
    if (!scroller || !query) return;
    const bounds = scroller.getBoundingClientRect();
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    let best;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest("script,style,input,textarea,.find-replace-box-wrapper,[aria-hidden=true]")) continue;
      for (let offset = node.nodeValue.indexOf(query); offset !== -1; offset = node.nodeValue.indexOf(query, offset + query.length)) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + query.length);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const distance = Math.abs(rect.top - bounds.top - scroller.clientHeight / 3);
        // 飞书表格表头会吸顶，给实际匹配文字留出阅读空间。
        if (!best || distance < best.distance) best = { top: scroller.scrollTop + rect.top - bounds.top - 96, distance, range };
      }
    }
    return best;
  }

  function revealHorizontal(range, scroller) {
    for (let element = range.startContainer.parentElement; element && element !== scroller; element = element.parentElement) {
      if (element.clientWidth <= 0 || element.scrollWidth <= element.clientWidth + 1 || !/^(auto|scroll|hidden)$/.test(getComputedStyle(element).overflowX)) continue;
      const text = range.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      if (text.left < bounds.left + 16 || text.right > bounds.right - 16) element.scrollLeft += text.left - bounds.left - Math.max(16, (element.clientWidth - text.width) / 2);
    }
  }

  async function alignMatch(query, token) {
    const position = await waitFor(() => /\d+\s*\/\s*[1-9]\d*/.test(counter()) && matchPosition(query), 5000);
    if (!position || token !== operation) return;
    await pause(120);
    if (token !== operation || !current()) return;
    const settled = matchPosition(query);
    if (settled) {
      revealHorizontal(settled.range, root());
      moveTo(root(), settled.top);
    }
    await pause(260);
  }

  function stopMotion() {
    cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    restoreScrollBehavior?.();
    restoreScrollBehavior = null;
  }

  function moveTo(scroller, target, start = scroller.scrollTop) {
    stopMotion();
    const end = Math.max(0, Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
    const previous = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    restoreScrollBehavior = () => { scroller.style.scrollBehavior = previous; };
    const write = (top) => {
      scroller.scrollTop = top;
      lastTop = scroller.scrollTop;
    };
    write(start);
    if (reducedMotion.matches || Math.abs(end - start) < 1) {
      write(end);
      stopMotion();
      return;
    }
    const started = performance.now();
    const tick = (time) => {
      if (!current() || root() !== scroller) { stopMotion(); return; }
      const progress = reducedMotion.matches ? 1 : Math.max(0, Math.min(1, (time - started) / 240));
      // easeOutCubic：快速起步、缓慢停靠。真实滚动必须更新滚动容器，不能用视觉位移代替。
      const eased = 1 - (1 - progress) ** 3;
      suppressUntil = Date.now() + 500;
      write(start + (end - start) * eased);
      if (progress < 1) motionFrame = requestAnimationFrame(tick);
      else stopMotion();
    };
    motionFrame = requestAnimationFrame(tick);
  }

  function beginSearch() {
    stopMotion();
    return ++operation;
  }

  function disconnect() {
    operation++;
    enabled = false;
    events.abort();
    counterObserver?.disconnect();
    cancelAnimationFrame(frame);
    stopMotion();
    document.documentElement.classList.remove("multidoc-reader-frame");
    box()?.removeAttribute("aria-hidden");
    chrome.runtime.onMessage.removeListener(listener);
    delete globalThis.__multiDocReader;
  }

  function emit(type, data) {
    // 临时端口失败不改变用户的联动开关，后续滚动仍可重试。
    chrome.runtime.sendMessage({ namespace, type, ...data }).catch(() => {});
  }

  async function waitFor(read, timeout = 8000) {
    const deadline = Date.now() + timeout;
    do {
      if (!current()) throw new Error("文档页面已切换，请重新连接。");
      const value = read();
      if (value) return value;
      await pause(100);
    } while (Date.now() < deadline);
    return null;
  }

  function watchCounter() {
    counterObserver?.disconnect();
    const panel = box();
    if (!panel) return;
    const report = () => {
      if (!current()) return;
      const value = counter();
      if (value !== lastCounter) { lastCounter = value; emit("counter", { counter: value }); }
    };
    counterObserver = new MutationObserver(report);
    counterObserver.observe(panel, { childList: true, characterData: true, subtree: true });
    report();
  }

  async function find(query) {
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("请输入 1～200 字的关键词。");
    if (finding) throw new Error("这份文档正在查找，请稍后重试。");
    finding = true;
    suppressUntil = Date.now() + 10000;
    try {
      if (!await waitFor(root)) throw new Error("飞书正文尚未加载，请先打开文档并确认有阅读权限。");
      if (!findInput()) {
        const mac = /Mac/.test(navigator.platform);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", keyCode: 70, which: 70, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
      }
      const input = await waitFor(findInput, 1500);
      if (!input) throw new Error("飞书查找尚未就绪，请重新载入本栏后重试。");
      const token = beginSearch();
      box()?.setAttribute("aria-hidden", "true");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      if (input.value === query.trim()) {
        // 相同关键词也要让飞书重新定位，不能停留在用户手动滚动后的位置。
        setValue.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await pause(0);
      }
      setValue.call(input, query.trim());
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      watchCounter();
      await pause(900);
      if (!current()) throw new Error("文档页面已切换，请重新连接。");
      await alignMatch(query.trim(), token);
      return { counter: counter() };
    } finally {
      finding = false;
      lastTop = root()?.scrollTop || 0;
      suppressUntil = Date.now() + 500;
    }
  }

  async function handle(message) {
    if (!current()) throw new Error("文档页面已切换，请重新连接。");
    if (message.type === "find") return find(message.query);
    if (message.type === "next") {
      if (finding) throw new Error("这份文档正在查找，请稍后重试。");
      if (message.direction !== 1 && message.direction !== -1) throw new Error("无效的查找方向。");
      const label = message.direction === 1 ? /^(Next|下一个|下一处)$/ : /^(Previous|上一个|上一处)$/;
      const button = Array.from(box()?.querySelectorAll("button") || []).find((element) => visible(element) && label.test(element.textContent.trim()));
      if (!button || button.disabled) throw new Error("请先搜索关键词，确认这份文档有可切换的匹配结果。");
      suppressUntil = Date.now() + 1500;
      const token = beginSearch();
      try {
        const before = counter();
        if (Number(before.split("/")[1]) === 1) return { counter: before };
        // 编辑器按钮可能在 mousedown 中导航，保留原生事件顺序并避免重复前进。
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
        if (!await waitFor(() => counter() !== before, 500)) button.click();
        if (!await waitFor(() => counter() !== before, 1200)) throw new Error("飞书尚未切换匹配结果，请重新载入本栏后重试。");
        watchCounter();
        await pause(300);
        await alignMatch(findInput()?.value.trim(), token);
        return { counter: counter() };
      } finally {
        lastTop = root()?.scrollTop || 0;
      }
    }
    if (message.type === "sync") {
      const nextEnabled = message.enabled === true;
      if (enabled && !nextEnabled) stopMotion();
      enabled = nextEnabled;
      cancelAnimationFrame(frame);
      frame = 0;
      lastTop = root()?.scrollTop || 0;
      originTop = lastTop;
      landmarkCache = [];
      landmarksAt = -Infinity;
      userUntil = 0;
      pointerHeld = false;
      return {};
    }
    if (message.type === "scroll") {
      if (!enabled || !Number.isFinite(message.progress) || Math.abs(message.progress) > 1 || !Number.isSafeInteger(message.revision) || message.revision <= lastRevision || !Array.isArray(message.anchors) || message.anchors.length > 3) return {};
      const scroller = root();
      if (!scroller) throw new Error("飞书正文尚未加载，无法联动滚动。");
      suppressUntil = Date.now() + 500;
      lastRevision = message.revision;
      followPosition(scroller, message);
      return {};
    }
    if (message.type === "disconnect") {
      disconnect();
      return {};
    }
    throw new Error("不支持的阅读操作。");
  }

  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.namespace !== namespace) return;
    handle(message).then((result) => respond({ ok: true, ...result })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);

  const gesture = (event) => {
    if (!event.isTrusted || event.ctrlKey && event.type === "wheel") return;
    const scroller = root();
    if (!scroller?.contains(event.target)) return;
    operation++;
    stopMotion();
    userUntil = Date.now() + 1200;
    suppressUntil = 0;
  };
  document.addEventListener("wheel", gesture, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("touchstart", gesture, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("touchmove", gesture, { capture: true, passive: true, signal: events.signal });
  document.addEventListener("pointerdown", (event) => {
    gesture(event);
    pointerHeld = event.isTrusted && Boolean(root()?.contains(event.target));
  }, { capture: true, signal: events.signal });
  document.addEventListener("pointerup", () => { pointerHeld = false; }, { capture: true, signal: events.signal });
  document.addEventListener("keydown", (event) => {
    if (event.isTrusted && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); emit("focus-search", {}); return;
    }
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key) && !event.target.closest?.("input,textarea,[contenteditable=true]")) gesture(event);
  }, { capture: true, signal: events.signal });
  document.addEventListener("scroll", (event) => {
    const scroller = root();
    if (event.target !== scroller) return;
    const movement = scroller.scrollTop - lastTop;
    lastTop = scroller.scrollTop;
    if (!enabled || !current() || finding || Date.now() < suppressUntil || (!pointerHeld && Date.now() > userUntil)) return;
    if (!movement) return;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (enabled && current() && !finding) emit("scroll", scrollPosition(scroller));
    });
  }, { capture: true, passive: true, signal: events.signal });
  globalThis.__multiDocReader = { path, disconnect };
  waitFor(root, 15000).then((scroller) => {
    if (scroller && current() && globalThis.__multiDocReader?.path === path) emit("ready", { title: scroller.querySelector?.("h1")?.innerText || document.title || "飞书文档" });
  }).catch(() => { /* 父工作台会在超时后逐栏提示，不将未载入报告为已就绪。 */ });
})();
