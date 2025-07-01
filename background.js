"use strict";

// URL utility functions
const isBlankURL = (url) => url === "about:blank";
const isChromeURL = (url) => url.startsWith("chrome://") || url.startsWith("view-source:chrome-search");
const isBrowserURL = (url) => url.startsWith("about:") || url.startsWith("chrome://");
const isValidURL = (url) => /^(f|ht)tps?:\/\//i.test(url);

// Simple URL normalization - keeps full path to make gmail.com/inbox ≠ gmail.com/starred
const normalizeURL = (url) => {
    try {
        if (!isValidURL(url)) return url;
        
        let normalized = url.toLowerCase();
        // Remove www but keep full path
        normalized = normalized.replace("://www.", "://");
        // Normalize protocol
        normalized = normalized.replace(/^https?:\/\//, "://");
        // Remove trailing slash only
        normalized = normalized.replace(/\/$/, "");
        
        return normalized;
    } catch (e) {
        console.error("normalizeURL error:", e.message);
        return url;
    }
};

// Get match pattern for chrome.tabs.query
const getMatchPattern = (url) => {
    if (!isValidURL(url)) {
        return isBrowserURL(url) ? `${url}*` : null;
    }
    
    try {
        const uri = new URL(url);
        return `*://${uri.hostname}${uri.pathname}${uri.search || ""}`;
    } catch (e) {
        return null;
    }
};

// Simple age tracking using tab creation order
const tabAges = new Map(); // tabId -> timestamp
const ignoredTabs = new Set();

const trackNewTab = (tabId) => {
    tabAges.set(tabId, Date.now());
};

const getOlderTabId = (tab1Id, tab2Id) => {
    const age1 = tabAges.get(tab1Id) || 0;
    const age2 = tabAges.get(tab2Id) || 0;
    return age1 <= age2 ? tab1Id : tab2Id;
};

const searchForDuplicates = async (observedTab, loadingUrl = null) => {
    const targetUrl = loadingUrl || observedTab.url;
    const normalizedTarget = normalizeURL(targetUrl);
    
    if (!normalizedTarget || isBlankURL(targetUrl)) return;
    
    const pattern = getMatchPattern(targetUrl);
    if (!pattern) return;
    
    try {
        const tabs = await getTabs({
            url: pattern,
            windowId: observedTab.windowId
        });
        
        const duplicates = tabs
            .filter(tab => 
                tab.id !== observedTab.id && 
                !ignoredTabs.has(tab.id) &&
                normalizeURL(tab.url) === normalizedTarget
            );
        
        for (const duplicate of duplicates) {
            const olderTabId = getOlderTabId(observedTab.id, duplicate.id);
            const newerTabId = olderTabId === observedTab.id ? duplicate.id : observedTab.id;
            const keepTabId = olderTabId;
            
            await closeDuplicate(newerTabId, keepTabId);
            
            // If we closed the observed tab, stop processing
            if (newerTabId === observedTab.id) break;
        }
    } catch (error) {
        console.error("Error searching for duplicates:", error);
    }
};

const closeDuplicate = async (closeTabId, keepTabId) => {
    try {
        ignoredTabs.add(closeTabId);
        await removeTab(closeTabId);
        
        // Focus the kept tab
        setTimeout(() => {
            focusTab(keepTabId);
        }, 100);
        
    } catch (error) {
        console.error("Error closing duplicate:", error);
        ignoredTabs.delete(closeTabId);
    }
};

// Event handlers
const onCreatedTab = (tab) => {
    trackNewTab(tab.id);
    if (tab.status === "complete" && !isBlankURL(tab.url)) {
        searchForDuplicates(tab);
    }
};

const onBeforeNavigate = async (details) => {
    if (details.frameId === 0 && details.tabId !== -1 && !isBlankURL(details.url)) {
        if (ignoredTabs.has(details.tabId)) return;
        
        try {
            const tab = await getTab(details.tabId);
            if (tab) {
                searchForDuplicates(tab, details.url);
            }
        } catch (error) {
            console.error("Error in onBeforeNavigate:", error);
        }
    }
};

const onUpdatedTab = (tabId, changeInfo, tab) => {
    if (ignoredTabs.has(tabId)) return;
    
    if (changeInfo.status === "complete" && !isBlankURL(tab.url)) {
        searchForDuplicates(tab);
    }
};

const onCompletedTab = async (details) => {
    if (details.frameId === 0 && details.tabId !== -1) {
        if (ignoredTabs.has(details.tabId)) return;
        
        try {
            const tab = await getTab(details.tabId);
            if (tab) {
                searchForDuplicates(tab);
            }
        } catch (error) {
            console.error("Error in onCompleted:", error);
        }
    }
};

const onRemovedTab = (tabId) => {
    tabAges.delete(tabId);
    ignoredTabs.delete(tabId);
};

// Chrome API helpers
const getTab = (tabId) => new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
            console.error("getTab error:", chrome.runtime.lastError.message);
            resolve(null);
        } else {
            resolve(tab);
        }
    });
});

const getTabs = (queryInfo) => new Promise((resolve) => {
    chrome.tabs.query({ ...queryInfo, windowType: "normal" }, (tabs) => {
        if (chrome.runtime.lastError) {
            console.error("getTabs error:", chrome.runtime.lastError.message);
            resolve([]);
        } else {
            resolve(tabs || []);
        }
    });
});

const removeTab = (tabId) => new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
            console.error("removeTab error:", chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
        } else {
            resolve();
        }
    });
});

const focusTab = async (tabId) => {
    try {
        const tab = await getTab(tabId);
        if (tab) {
            await new Promise((resolve) => {
                chrome.tabs.update(tabId, { active: true }, () => {
                    if (!chrome.runtime.lastError) {
                        chrome.windows.update(tab.windowId, { focused: true }, resolve);
                    } else {
                        resolve();
                    }
                });
            });
        }
    } catch (error) {
        console.error("Error focusing tab:", error);
    }
};

// Initialize existing tabs
const initializeTabs = async () => {
    try {
        const tabs = await getTabs({});
        tabs.forEach(tab => trackNewTab(tab.id));
    } catch (error) {
        console.error("Error initializing tabs:", error);
    }
};

// Start the extension
const start = async () => {
    await initializeTabs();
    
    chrome.tabs.onCreated.addListener(onCreatedTab);
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    chrome.tabs.onUpdated.addListener(onUpdatedTab);
    chrome.webNavigation.onCompleted.addListener(onCompletedTab);
    chrome.tabs.onRemoved.addListener(onRemovedTab);
};

start();
