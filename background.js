"use strict";

// ========== HELPER FUNCTIONS ==========
const wait = timeout => new Promise(resolve => setTimeout(resolve, timeout));

const debounce = (func, delay) => {
    const storedArguments = new Map();
    return (...args) => {
        const windowId = args[0] || 1;
        const later = () => {
            const laterArgs = storedArguments.get(windowId);
            if (laterArgs) {
                func(laterArgs);
                setTimeout(later, delay);
                storedArguments.set(windowId, null);
            }
            else {
                storedArguments.delete(windowId);
            }
        };

        if (!storedArguments.has(windowId)) {
            func(args[1] || args[0]);
            setTimeout(later, delay);
            storedArguments.set(windowId, null);
        }
        else {
            storedArguments.set(windowId, args[1] || args[0] || 1);
        }
    };
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
            reject();
        }
        else resolve();
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
            reject();
        }
        else resolve();
    });
});

const activateWindow = (windowId) => updateWindow(windowId, { focused: true });
const activateTab = (tabId) => updateTab(tabId, { active: true });
const focusTab = (tabId, windowId) => Promise.all([activateTab(tabId), activateWindow(windowId)]);

const removeTab = (tabId) => new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
            console.error("removeTab error:", chrome.runtime.lastError.message);
            reject();
        }
        else resolve();
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
    }
    else if (isBrowserURL(url)) {
        urlPattern = `${url}*`;
    }
    return urlPattern;
};

// ========== TABS INFO CLASS WITH CLEANUP ==========
class TabsInfo {
    constructor() {
        this.tabs = new Map();
        this.initialize();
        // Schedule periodic cleanup
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

    // NEW: Cleanup method to remove stale tab data
    async cleanup() {
        try {
            const currentTabs = await getTabs({});
            if (!currentTabs) return;

            const currentTabIds = new Set(currentTabs.map(tab => tab.id));
            const storedTabIds = Array.from(this.tabs.keys());

            // Remove tabs that no longer exist
            for (const tabId of storedTabIds) {
                if (!currentTabIds.has(tabId)) {
                    console.log(`Cleaning up stale tab data for tab ${tabId}`);
                    this.tabs.delete(tabId);
                }
            }

            // Also remove very old entries (older than 1 hour)
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            for (const [tabId, tab] of this.tabs) {
                if (tab.lastAccessed < oneHourAgo && !currentTabIds.has(tabId)) {
                    console.log(`Cleaning up old tab data for tab ${tabId}`);
                    this.tabs.delete(tabId);
                }
            }
        } catch (error) {
            console.error("Error during TabsInfo cleanup:", error);
        }
    }

    // NEW: Schedule periodic cleanup
    scheduleCleanup() {
        // Run cleanup every 10 minutes
        setInterval(() => {
            this.cleanup();
        }, 10 * 60 * 1000);
    }
}

// ========== WORKER LOGIC ==========
const getLastUpdatedTabId = (observedTab, openedTab) => {
    const observedTabLastUpdate = tabsInfo.getLastComplete(observedTab.id);
    const openedTabLastUpdate = tabsInfo.getLastComplete(openedTab.id);
    
    if (observedTabLastUpdate === null) return openedTab.id;
    if (openedTabLastUpdate === null) return observedTab.id;
    return (observedTabLastUpdate < openedTabLastUpdate) ? observedTab.id : openedTab.id;
};

const getFocusedTab = (observedTab, openedTab, activeWindowId, retainedTabId) => {
    if (retainedTabId === observedTab.id) {
        return ((openedTab.windowId === activeWindowId) && (openedTab.active || (observedTab.windowId !== activeWindowId)) ? openedTab.id : observedTab.id);
    }
    else {
        return ((observedTab.windowId === activeWindowId) && (observedTab.active || (openedTab.windowId !== activeWindowId)) ? observedTab.id : openedTab.id);
    }
};

const getCloseInfo = (details) => {
    const observedTab = details.observedTab;
    const openedTab = details.openedTab;
    const activeWindowId = details.activeWindowId;
    
    let retainedTabId = getLastUpdatedTabId(observedTab, openedTab);
    if (activeWindowId) {
        retainedTabId = getFocusedTab(observedTab, openedTab, activeWindowId, retainedTabId);
    }
    
    if (retainedTabId === observedTab.id) {
        const keepInfo = {
            observedTabClosed: false,
            active: openedTab.active,
            tabIndex: openedTab.index,
            tabId: observedTab.id,
            windowId: observedTab.windowId
        };
        return [openedTab.id, keepInfo];
    } else {
        const keepInfo = {
            observedTabClosed: true,
            active: observedTab.active,
            tabIndex: observedTab.index,
            tabId: openedTab.id,
            windowId: openedTab.windowId
        };
        return [observedTab.id, keepInfo];
    }
};

const searchForDuplicateTabsToClose = async (observedTab, queryComplete, loadingUrl) => {
    const observedTabUrl = loadingUrl || observedTab.url;
    const observedWindowsId = observedTab.windowId;
    
    const queryInfo = {};
    queryInfo.status = queryComplete ? "complete" : null;
    queryInfo.url = getMatchPatternURL(observedTabUrl);
    queryInfo.windowId = observedWindowsId;
    
    const openedTabs = await getTabs(queryInfo);
    if (openedTabs && openedTabs.length > 1) {
        const matchingObservedTabUrl = getMatchingURL(observedTabUrl);
        for (const openedTab of openedTabs) {
            if ((openedTab.id === observedTab.id) || tabsInfo.isIgnoredTab(openedTab.id) || (isBlankURL(openedTab.url) && !isTabComplete(openedTab))) continue;
            
            if (getMatchingURL(openedTab.url) === matchingObservedTabUrl) {
                const [tabToCloseId, remainingTabInfo] = getCloseInfo({ observedTab: observedTab, observedTabUrl: observedTabUrl, openedTab: openedTab });
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
    }
    catch (ex) {
        tabsInfo.ignoreTab(tabToCloseId, false);
        return;
    }
    if (tabsInfo.hasTab(tabToCloseId)) {
        await wait(10);
        if (tabsInfo.hasTab(tabToCloseId)) {
            tabsInfo.ignoreTab(tabToCloseId, false);
            return;
        }
    }
    handleRemainingTab(remainingTabInfo.windowId, remainingTabInfo);
};

const _handleRemainingTab = async (details) => {
    if (!tabsInfo.hasTab(details.tabId)) return;
    focusTab(details.tabId, details.windowId);
};

const handleRemainingTab = debounce(_handleRemainingTab, 500);

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
    if (Object.prototype.hasOwnProperty.call(changeInfo, "status") && changeInfo.status === "complete") {
        if (Object.prototype.hasOwnProperty.call(changeInfo, "url") && (changeInfo.url !== tab.url)) {
            if (isBlankURL(tab.url) || !tab.favIconUrl || !tabsInfo.hasUrlChanged(tab)) return;
            tabsInfo.updateTab(tab);
            searchForDuplicateTabsToClose(tab);
        }
        else if (isChromeURL(tab.url)) {
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
};

const onDetachedTab = (detachedTabId, detachInfo) => {
    // Nothing needed
};

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
        
        for (const [url, tabs] of tabGroups) {
            if (tabs.length > 1) {
                console.log(`Found ${tabs.length} duplicate tabs for: ${url}`);
                
                tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
                
                const tabToKeep = tabs[0];
                const tabsToClose = tabs.slice(1);
                
                console.log(`Keeping tab ${tabToKeep.id}, closing ${tabsToClose.length} duplicates`);
                
                for (const tabToClose of tabsToClose) {
                    try {
                        await removeTab(tabToClose.id);
                        console.log(`Closed duplicate tab ${tabToClose.id}`);
                    } catch (error) {
                        console.error(`Failed to close tab ${tabToClose.id}:`, error);
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
        }
        
        console.log("Duplicate tab cleanup completed");
    } catch (error) {
        console.error("Error during duplicate tab cleanup:", error);
    }
};

const onInstalled = (details) => {
    console.log("Extension installed/started, reason:", details.reason);
    setTimeout(() => {
        findAndCloseDuplicatesOnInstall();
    }, 1000);
};

const onStartup = () => {
    console.log("Extension startup detected");
    setTimeout(() => {
        findAndCloseDuplicatesOnInstall();
    }, 2000);
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
};

start();
