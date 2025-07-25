"use strict";

// ========== HELPER FUNCTIONS ==========
const wait = timeout => new Promise(resolve => setTimeout(resolve, timeout));

const windowBasedDebounce = (func, delay) => {
    const timers = new Map();
    
    const debounced = (windowId, ...args) => {
        if (windowId == null) {
            console.warn('windowBasedDebounce called with null/undefined windowId');
            return;
        }
        if (timers.has(windowId)) {
            clearTimeout(timers.get(windowId));
        }
        const timerId = setTimeout(() => {
            func(windowId, ...args);
            timers.delete(windowId);
        }, delay);
        timers.set(windowId, timerId);
    };
    
    debounced.cancel = (windowId) => {
        if (windowId != null && timers.has(windowId)) {
            clearTimeout(timers.get(windowId));
            timers.delete(windowId);
            return true;
        }
        return false;
    };
    
    debounced.cancelAll = () => {
        timers.forEach(timerId => clearTimeout(timerId));
        timers.clear();
        console.log("Cancelled all pending debounce operations");
    };
    
    debounced.hasPending = (windowId) => timers.has(windowId);
    debounced.getPendingWindowIds = () => Array.from(timers.keys());
    
    debounced.cleanupStaleWindows = (currentWindowIds) => {
        const pendingWindowIds = debounced.getPendingWindowIds();
        let cleanedCount = 0;
        for (const windowId of pendingWindowIds) {
            if (!currentWindowIds.has(windowId)) {
                console.log(`Cleaning up pending operations for closed window ${windowId}`);
                debounced.cancel(windowId);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} stale window operations`);
        }
    };
    
    return debounced;
};

const isTabComplete = tab => tab.status === "complete";
const isTabLoading = tab => tab.status === "loading";

const getTab = (tabId) => new Promise((resolve) => {
    chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) console.error("getTab error:", chrome.runtime.lastError.message);
        resolve(chrome.runtime.lastError ? null : tab);
    });
});

const getTabs = (queryInfo) => new Promise((resolve) => {
    queryInfo.windowType = "normal";
    chrome.tabs.query(queryInfo, tabs => {
        if (chrome.runtime.lastError) console.error("getTabs error:", chrome.runtime.lastError.message);
        resolve(chrome.runtime.lastError ? null : tabs);
    });
});

const updateWindow = (windowId, updateProperties) => new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateProperties, () => {
        if (chrome.runtime.lastError) {
            console.error("updateWindow error:", chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
        } else {
            resolve();
        }
    });
});

const getActiveTab = async (windowId) => {
    const tabs = await getTabs({ windowId: windowId, active: true });
    return tabs ? tabs[0] : null;
};

const getActiveWindowId = () => new Promise((resolve) => {
    chrome.windows.getLastFocused(null, window => {
        if (chrome.runtime.lastError) console.error("getActiveWindowId error:", chrome.runtime.lastError.message);
        resolve(chrome.runtime.lastError ? null : window.id);
    });
});

const updateTab = (tabId, updateProperties) => new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, () => {
        if (chrome.runtime.lastError) {
            console.error("updateTab error:", tabId, updateProperties, chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
        } else {
            resolve();
        }
    });
});

const activateWindow = (windowId) => updateWindow(windowId, { focused: true });
const activateTab = (tabId) => updateTab(tabId, { active: true });
const focusTab = (tabId, windowId) => Promise.all([activateTab(tabId), activateWindow(windowId)]);

const removeTab = (tabId, retryCount = 0) => new Promise(async (resolve, reject) => {
    const maxRetries = 2;
    const retryDelay = 50;
    
    chrome.tabs.remove(tabId, async () => {
        if (chrome.runtime.lastError) {
            const errorMessage = chrome.runtime.lastError.message;
            if (errorMessage.includes("Tabs cannot be edited right now") && retryCount < maxRetries) {
                await wait(retryDelay);
                try {
                    await removeTab(tabId, retryCount + 1);
                    resolve();
                } catch (retryError) {
                    reject(retryError);
                }
            } else {
                reject(new Error(errorMessage));
            }
        } else {
            resolve();
        }
    });
});

// ========== URL UTILITIES ==========
const isBlankURL = (url) => url === "about:blank";
const isChromeURL = (url) => url.startsWith("chrome://") || url.startsWith("view-source:chrome-search");
const isExtensionURL = (url) => url.startsWith("chrome-extension://");
const isBrowserURL = (url) => url.startsWith("about:") || url.startsWith("chrome://") || url.startsWith("chrome-extension://");
const isValidURL = (url) => {
    const regex = /^(f|ht)tps?:\/\//i;
    return regex.test(url);
};

const getMatchingURL = (url) => {    
    if (!isValidURL(url)) return url;
    let matchingURL = url;
    matchingURL = matchingURL.split("#")[0];
    matchingURL = matchingURL.replace("://www.", "://");
    matchingURL = matchingURL.toLowerCase();
    matchingURL = matchingURL.replace(/\/$/, "");
    return matchingURL;
};

const getMatchPatternURL = (url) => {
    let urlPattern = null;
    if (isValidURL(url)) {
        const uri = new URL(url);
        urlPattern = `*://${uri.hostname}${uri.pathname}`;
        if (uri.search || uri.hash) {
            urlPattern += "*";
        }
    } else if (isBrowserURL(url)) {
        urlPattern = `${url}*`;
    }
    return urlPattern;
};

// ========== TABS INFO CLASS WITH CLEANUP ==========
class TabsInfo {
    constructor() {
        this.tabs = new Map();
        this.initialize();
        this.scheduleCleanup();
    }

    async initialize() {
        const openedTabs = await getTabs({ windowType: "normal" });
        for (const openedTab of openedTabs) {
            this.setOpenedTab(openedTab);
        }
    }

    setNewTab(tabId) {
        const tab = { url: null, lastComplete: null, ignored: false, lastAccessed: Date.now() };
        this.tabs.set(tabId, tab);
    }

    setOpenedTab(openedTab) {
        const tab = { url: openedTab.url, lastComplete: Date.now(), ignored: false, lastAccessed: Date.now() };
        this.tabs.set(openedTab.id, tab);
    }

    ignoreTab(tabId, state) {
        const tab = this.tabs.get(tabId);
        if (tab) {
            tab.ignored = state;
            tab.lastAccessed = Date.now();
            this.tabs.set(tabId, tab);
        }
    }

    isIgnoredTab(tabId) {
        const tab = this.tabs.get(tabId);
        return (!tab || tab.ignored) ? true : false;
    }

    getLastComplete(tabId) {
        const tab = this.tabs.get(tabId);
        return tab ? tab.lastComplete : null;
    }

    updateTab(openedTab) {
        const tab = this.tabs.get(openedTab.id);
        if (tab) {
            tab.url = openedTab.url;
            tab.lastComplete = Date.now();
            tab.lastAccessed = Date.now();
            this.tabs.set(openedTab.id, tab);
        }
    }

    resetTab(tabId) {
        this.setNewTab(tabId);
    }

    hasUrlChanged(openedTab) {
        const tab = this.tabs.get(openedTab.id);
        return tab ? tab.url !== openedTab.url : true;
    }

    removeTab(tabId) {
        this.tabs.delete(tabId);
    }

    hasTab(tabId) {
        return this.tabs.has(tabId);
    }

    async cleanup() {
        try {
            const currentTabs = await getTabs({});
            if (!currentTabs) return;
            const currentTabIds = new Set(currentTabs.map(tab => tab.id));
            const storedTabIds = Array.from(this.tabs.keys());
            for (const tabId of storedTabIds) {
                if (!currentTabIds.has(tabId)) {
                    this.tabs.delete(tabId);
                }
            }
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            for (const [tabId, tab] of this.tabs) {
                if (tab.lastAccessed < oneHourAgo && !currentTabIds.has(tabId)) {
                    this.tabs.delete(tabId);
                }
            }
            const currentWindows = await new Promise(resolve => chrome.windows.getAll({}, windows => resolve(windows || [])));
            const currentWindowIds = new Set(currentWindows.map(w => w.id));
            handleRemainingTab.cleanupStaleWindows(currentWindowIds);
        } catch (error) {
            console.error("Error during TabsInfo cleanup:", error);
        }
    }

    scheduleCleanup() {
        setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }
}

// ========== WORKER LOGIC ==========
const getLastUpdatedTabId = (observedTab, openedTab) => {
    const observedTabLastUpdate = tabsInfo.getLastComplete(observedTab.id);
    const openedTabLastUpdate = tabsInfo.getLastComplete(openedTab.id);
    return observedTabLastUpdate === null ? openedTab.id :
           openedTabLastUpdate === null ? observedTab.id :
           observedTabLastUpdate < openedTabLastUpdate ? observedTab.id : openedTab.id;
};

const getFocusedTab = (observedTab, openedTab, activeWindowId, retainedTabId) => {
    if (retainedTabId === observedTab.id) {
        return (openedTab.windowId === activeWindowId && (openedTab.active || observedTab.windowId !== activeWindowId)) ? openedTab.id : observedTab.id;
    }
    return (observedTab.windowId === activeWindowId && (observedTab.active || openedTab.windowId !== activeWindowId)) ? observedTab.id : openedTab.id;
};

const getCloseInfo = (details) => {
    const { observedTab, openedTab, activeWindowId } = details;
    let retainedTabId = getLastUpdatedTabId(observedTab, openedTab);
    if (activeWindowId) {
        retainedTabId = getFocusedTab(observedTab, openedTab, activeWindowId, retainedTabId);
    }
    const keepInfo = {
        observedTabClosed: retainedTabId !== observedTab.id,
        active: retainedTabId === observedTab.id ? openedTab.active : observedTab.active,
        tabIndex: retainedTabId === observedTab.id ? openedTab.index : observedTab.index,
        tabId: retainedTabId,
        windowId: retainedTabId === observedTab.id ? observedTab.windowId : openedTab.windowId
    };
    return [retainedTabId === observedTab.id ? openedTab.id : observedTab.id, keepInfo];
};

const searchForDuplicateTabsToClose = async (observedTab, queryComplete, loadingUrl) => {
    const observedTabUrl = loadingUrl || observedTab.url;
    const queryInfo = {
        status: queryComplete ? "complete" : null,
        url: getMatchPatternURL(observedTabUrl),
        windowId: observedTab.windowId
    };
    
    const openedTabs = await getTabs(queryInfo);
    if (openedTabs && openedTabs.length > 1) {
        const matchingObservedTabUrl = getMatchingURL(observedTabUrl);
        for (const openedTab of openedTabs) {
            if (openedTab.id === observedTab.id || tabsInfo.isIgnoredTab(openedTab.id) || (isBlankURL(openedTab.url) && !isTabComplete(openedTab))) continue;
            if (getMatchingURL(openedTab.url) === matchingObservedTabUrl) {
                const [tabToCloseId, remainingTabInfo] = getCloseInfo({ observedTab, openedTab, activeWindowId: await getActiveWindowId() });
                closeDuplicateTab(tabToCloseId, remainingTabInfo);
                if (remainingTabInfo.observedTabClosed) break;
            }
        }
    }
};

const closeDuplicateTab = async (tabToCloseId, remainingTabInfo) => {
    try {
        tabsInfo.ignoreTab(tabToCloseId, true);
        await removeTab(tabToCloseId);
        handleRemainingTab(remainingTabInfo.windowId, remainingTabInfo);
    } catch (error) {
        tabsInfo.ignoreTab(tabToCloseId, false);
    }
};

// Enhanced _handleRemainingTab with robust tab existence checks
const _handleRemainingTab = async (windowId, details) => {
    if (!tabsInfo.hasTab(details.tabId)) return;
    try {
        // Verify tab still exists before focusing - CRITICAL FIX
        const tab = await getTab(details.tabId);
        if (!tab) {
            tabsInfo.removeTab(details.tabId);
            return;
        }
        await focusTab(details.tabId, windowId);
    } catch (error) {
        tabsInfo.removeTab(details.tabId);
    }
};

// Balanced debounce delay - not too aggressive, not too slow
const handleRemainingTab = windowBasedDebounce(_handleRemainingTab, 75);

// ========== MAIN BACKGROUND LOGIC ==========
const tabsInfo = new TabsInfo();

const onCreatedTab = (tab) => {
    tabsInfo.setNewTab(tab.id);
    if (tab.status === "complete" && !isBlankURL(tab.url)) {
        searchForDuplicateTabsToClose(tab, true);
    }
};

const onBeforeNavigate = async (details) => {
    if (details.frameId === 0 && details.tabId !== -1 && !isBlankURL(details.url)) {
        if (tabsInfo.isIgnoredTab(details.tabId)) return;
        const tab = await getTab(details.tabId);
        if (tab) {
            tabsInfo.resetTab(tab.id);
            searchForDuplicateTabsToClose(tab, true, details.url);
        }
    }
};

const onCompletedTab = async (details) => {
    if (details.frameId === 0 && details.tabId !== -1) {
        if (tabsInfo.isIgnoredTab(details.tabId)) return;
        const tab = await getTab(details.tabId);
        if (tab) {
            tabsInfo.updateTab(tab);
            searchForDuplicateTabsToClose(tab);
        }
    }
};

const onUpdatedTab = (tabId, changeInfo, tab) => {
    if (tabsInfo.isIgnoredTab(tabId)) return;
    if (changeInfo.status === "complete") {
        if (changeInfo.url && changeInfo.url !== tab.url) {
            if (isBlankURL(tab.url) || !tab.favIconUrl || !tabsInfo.hasUrlChanged(tab)) return;
            tabsInfo.updateTab(tab);
            searchForDuplicateTabsToClose(tab);
        } else if (isChromeURL(tab.url)) {
            tabsInfo.updateTab(tab);
            searchForDuplicateTabsToClose(tab);
        }
    }
};

const onAttached = async (tabId) => {
    const tab = await getTab(tabId);
    if (tab) {
        searchForDuplicateTabsToClose(tab);
    }
};

const onRemovedTab = (removedTabId, removeInfo) => {
    tabsInfo.removeTab(removedTabId);
    if (removeInfo.isWindowClosing) {
        handleRemainingTab.cancel(removeInfo.windowId);
    }
};

const onDetachedTab = (detachedTabId, detachInfo) => {};

const onWindowRemoved = (windowId) => {
    if (handleRemainingTab.cancel(windowId)) {
        console.log(`Cancelled pending operations for window ${windowId}`);
    }
};

// Improved findAndCloseDuplicatesOnInstall with balanced concurrency
const findAndCloseDuplicatesOnInstall = async () => {
    console.log("Scanning for duplicate tabs on extension install...");
    try {
        const allTabs = await getTabs({});
        if (!allTabs || allTabs.length <= 1) return;
        
        const tabGroups = new Map();
        for (const tab of allTabs) {
            if (isBlankURL(tab.url) || isBrowserURL(tab.url)) continue;
            const matchingUrl = getMatchingURL(tab.url);
            if (!tabGroups.has(matchingUrl)) {
                tabGroups.set(matchingUrl, []);
            }
            tabGroups.get(matchingUrl).push(tab);
        }
        
        const urlGroups = Array.from(tabGroups.entries()).filter(([url, tabs]) => tabs.length > 1);
        for (const [url, tabs] of urlGroups) {
            console.log(`Found ${tabs.length} duplicate tabs for: ${url}`);
            tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
            const tabToKeep = tabs[0];
            const tabsToClose = tabs.slice(1);
            
            // Balanced approach: concurrent for small batches, sequential for large ones
            if (tabsToClose.length <= 4) {
                tabsToClose.forEach(tab => tabsInfo.ignoreTab(tab.id, true));
                const closurePromises = tabsToClose.map(async (tabToClose) => {
                    try {
                        await removeTab(tabToClose.id);
                        return { success: true, tabId: tabToClose.id };
                    } catch (error) {
                        tabsInfo.ignoreTab(tabToClose.id, false);
                        return { success: false, tabId: tabToClose.id, error };
                    }
                });
                const results = await Promise.allSettled(closurePromises);
                const successfulClosures = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
                console.log(`Closed ${successfulClosures}/${tabsToClose.length} duplicate tabs concurrently`);
            } else {
                for (const tabToClose of tabsToClose) {
                    try {
                        tabsInfo.ignoreTab(tabToClose.id, true);
                        await removeTab(tabToClose.id);
                        await wait(25); // Balanced delay
                    } catch (error) {
                        tabsInfo.ignoreTab(tabToClose.id, false);
                    }
                }
            }
            
            if (tabsToClose.some(tab => tab.active)) {
                try {
                    await focusTab(tabToKeep.id, tabToKeep.windowId);
                } catch (error) {
                    console.error(`Failed to focus kept tab ${tabToKeep.id}:`, error);
                }
            }
        }
        
        console.log("Duplicate tab cleanup completed");
    } catch (error) {
        console.error("Error during duplicate tab cleanup:", error);
    }
};

const onInstalled = (details) => {
    console.log("Extension installed/started, reason:", details.reason);
    setTimeout(() => findAndCloseDuplicatesOnInstall(), 1000);
};

const onStartup = () => {
    console.log("Extension startup detected");
    handleRemainingTab.cancelAll();
    console.log("Cleared all pending debounce operations on startup");
    setTimeout(() => findAndCloseDuplicatesOnInstall(), 2000);
};

// ========== INITIALIZATION ==========
const start = async () => {
    chrome.tabs.onCreated.addListener(onCreatedTab);
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    chrome.tabs.onAttached.addListener(onAttached);
    chrome.tabs.onDetached.addListener(onDetachedTab);
    chrome.tabs.onUpdated.addListener(onUpdatedTab);
    chrome.webNavigation.onCompleted.addListener(onCompletedTab);
    chrome.tabs.onRemoved.addListener(onRemovedTab);
    chrome.runtime.onInstalled.addListener(onInstalled);
    chrome.runtime.onStartup.addListener(onStartup);
    if (chrome.windows.onRemoved) {
        chrome.windows.onRemoved.addListener(onWindowRemoved);
    }
};

start();
