export const ORIGIN = "https://example.feishu.cn";
export const MESSAGE = "multi-doc-reader";

export function documentUrl(raw) {
  const url = new URL(raw.trim());
  if (url.origin !== ORIGIN || url.username || url.password ||
      !/^\/(wiki|docx)\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error("请使用 example.feishu.cn 下的 wiki 或 docx 文档链接。");
  }
  // 分享链接的操作参数不参与阅读，也不保留可能携带敏感值的查询串。
  return url.origin + url.pathname.replace(/\/$/, "") +
    (/^#share-[A-Za-z0-9]+$/.test(url.hash) ? url.hash : "");
}

export function documentKey(raw) {
  return documentUrl(raw).split("#")[0];
}

export function documentLinks(text) {
  return [...new Map(text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const url = documentUrl(line);
    return [documentKey(url), url];
  })).values()];
}

export function documentForFrame(sender, extensionId, tabId, documents) {
  if (sender.id !== extensionId || sender.tab?.id !== tabId || !Number.isInteger(sender.frameId) || sender.frameId <= 0) return null;
  try { return documents.find((doc) => doc.key === documentKey(sender.url)) || null; }
  catch { return null; }
}
