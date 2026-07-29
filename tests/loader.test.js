const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const loaderPath = path.resolve(__dirname, "../dist/BCMapSaver.loader.user.js");
const loader = fs.readFileSync(loaderPath, "utf8");

test("portable loader targets the official main-branch core", () => {
  assert.match(loader, /stareyeXuanyeLin\/BC-Map-Saver\/main\/dist\/BCMapSaver\.user\.js/);
  assert.match(loader, /stareyeXuanyeLin\/BC-Map-Saver@main\/dist\/BCMapSaver\.user\.js/);
});

test("portable loader validates and confirms core execution", () => {
  assert.match(loader, /const MOD_NAME = "BCMapSaver"/);
  assert.match(loader, /function initialize\(\)/);
  assert.match(loader, /__BC_MAP_SAVER_CORE_EVALUATED__/);
});

test("portable loader includes privileged request grants and four network sources", () => {
  assert.match(loader, /@grant\s+GM_xmlhttpRequest/);
  assert.match(loader, /@grant\s+GM_addElement/);
  assert.match(loader, /@grant\s+unsafeWindow/);
  assert.match(loader, /raw\.githubusercontent\.com/);
  assert.match(loader, /cdn\.jsdelivr\.net/);
  assert.match(loader, /fastly\.jsdelivr\.net/);
  assert.match(loader, /gcore\.jsdelivr\.net/);
});
