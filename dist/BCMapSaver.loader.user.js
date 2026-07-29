// ==UserScript==
// @name         Bondage Club - Map Saver（正式版加载器）
// @name:zh-CN   Bondage Club - 地图存档（正式版加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-Map-Saver
// @version      0.1.0
// @description  Fetches and executes the latest BC Map Saver from the official branch with a privileged request and network fallback.
// @description:zh-CN 每次进入页面时通过特权请求获取并执行 main 分支的最新 BC Map Saver，并在网络故障时自动切换备用源。
// @author       林宣夜＆佩菈
// @match        https://www.bondageprojects.com/R*/BondageClub*
// @match        https://bondageprojects.com/R*/BondageClub*
// @match        https://www.bondageprojects.elementfx.com/R*/BondageClub*
// @match        https://bondageprojects.elementfx.com/R*/BondageClub*
// @match        https://bondage-europe.com/R*/BondageClub*
// @match        https://www.bondage-europe.com/R*/BondageClub*
// @match        https://bondage-asia.com/club/R*/BondageClub*
// @match        https://www.bondage-asia.com/club/R*/BondageClub*
// @include      /^https:\/\/(www\.)?bondageprojects\.elementfx\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondageprojects\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondage-europe\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondage-asia\.com\/club\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https?:\/\/localhost:\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      gcore.jsdelivr.net
// @noframes
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.loader.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.loader.user.js
// ==/UserScript==

(function () {
    "use strict";

    const pageWindow = unsafeWindow;
    const LOADER_GUARD = "__BC_MAP_SAVER_LOADER__";
    const EXECUTION_MARKER = "__BC_MAP_SAVER_CORE_EVALUATED__";
    if (pageWindow[LOADER_GUARD]) return;
    pageWindow[LOADER_GUARD] = true;

    const cacheKey = Date.now();
    const corePath = "stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.user.js";
    const sources = Object.freeze([
        `https://raw.githubusercontent.com/${corePath}?timestamp=${cacheKey}`,
        `https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-Map-Saver@main/dist/BCMapSaver.user.js?timestamp=${cacheKey}`,
        `https://fastly.jsdelivr.net/gh/stareyeXuanyeLin/BC-Map-Saver@main/dist/BCMapSaver.user.js?timestamp=${cacheKey}`,
        `https://gcore.jsdelivr.net/gh/stareyeXuanyeLin/BC-Map-Saver@main/dist/BCMapSaver.user.js?timestamp=${cacheKey}`,
    ]);

    function fail(message, detail) {
        delete pageWindow[LOADER_GUARD];
        console.error(`[BC Map Saver Loader] ${message}`, detail || "");
    }

    function validCore(source) {
        return typeof source === "string"
            && source.includes('const MOD_NAME = "BCMapSaver"')
            && source.includes("function initialize()")
            && !/^\s*</.test(source);
    }

    function executeCore(source, sourceURL) {
        delete pageWindow[EXECUTION_MARKER];
        const marker = `\n;globalThis.${EXECUTION_MARKER} = true;\n//# sourceURL=${sourceURL}`;
        GM_addElement(document.head || document.documentElement, "script", { textContent: source + marker });
        if (pageWindow[EXECUTION_MARKER] !== true) throw new Error("核心文本已下载，但未能在游戏页面上下文中执行");
        delete pageWindow[EXECUTION_MARKER];
        console.info(`[BC Map Saver Loader] latest core executed from ${sourceURL}.`);
    }

    function loadFrom(attempt) {
        if (attempt >= sources.length) {
            fail("all remote sources failed; core was not loaded.");
            return;
        }

        const sourceURL = sources[attempt];
        GM_xmlhttpRequest({
            method: "GET",
            url: sourceURL,
            timeout: 15000,
            headers: { "Cache-Control": "no-cache" },
            onload(response) {
                if (response.status < 200 || response.status >= 300 || !validCore(response.responseText)) {
                    console.warn(`[BC Map Saver Loader] invalid response from ${sourceURL} (HTTP ${response.status}); trying the next source.`);
                    loadFrom(attempt + 1);
                    return;
                }
                try {
                    executeCore(response.responseText, sourceURL);
                } catch (error) {
                    fail("the core was downloaded but execution failed.", error);
                }
            },
            onerror(error) {
                console.warn(`[BC Map Saver Loader] request failed for ${sourceURL}; trying the next source.`, error);
                loadFrom(attempt + 1);
            },
            ontimeout() {
                console.warn(`[BC Map Saver Loader] request timed out for ${sourceURL}; trying the next source.`);
                loadFrom(attempt + 1);
            },
        });
    }

    loadFrom(0);
})();
