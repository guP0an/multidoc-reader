chrome.action.onClicked.addListener(async () => {
  const { controllerWindow } = await chrome.storage.session.get("controllerWindow");
  if (controllerWindow !== undefined) {
    try {
      await chrome.windows.update(controllerWindow, { focused: true, state: "fullscreen" });
      return;
    } catch {
      await chrome.storage.session.remove("controllerWindow");
    }
  }
  const panel = await chrome.windows.create({
    url: chrome.runtime.getURL("controller.html"), type: "popup", state: "fullscreen"
  });
  await chrome.storage.session.set({ controllerWindow: panel.id });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { controllerWindow } = await chrome.storage.session.get("controllerWindow");
  if (controllerWindow === id) await chrome.storage.session.remove("controllerWindow");
});
