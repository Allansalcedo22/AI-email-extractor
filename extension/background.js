// Clicking the toolbar icon opens the side panel. Clicking it also grants
// `activeTab` for the current tab, which lets the panel read that page.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));
