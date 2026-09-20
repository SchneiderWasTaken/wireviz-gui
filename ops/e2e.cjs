// End-to-end test of the WireViz GUI prototype (headless Chromium).
const { chromium } = require("/home/opencode/.local/opt/browser-automation/node_modules/playwright");
const zlib = require("zlib");
const fs = require("fs");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || "" });
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (extra ? " | " + extra : ""));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE ERROR:", m.text()); });

  await page.goto("http://127.0.0.1:8377/index.html", { waitUntil: "networkidle" });

  // 1. demo doc loaded
  await page.waitForSelector(".node", { timeout: 5000 });
  const nodeCount = await page.locator(".node").count();
  check("demo doc renders 4 nodes", nodeCount === 4, "count=" + nodeCount);

  // 2. YAML panel populated
  const yaml = await page.inputValue("#yaml-view");
  check("yaml has connectors", /connectors:/.test(yaml) && /X1:/.test(yaml));
  check("yaml has connections", /connections:/.test(yaml) && /W1:/.test(yaml));

  // 3. add a connector via palette
  await page.click('.palette-item[data-kind="connector"]');
  const afterAdd = await page.locator(".node").count();
  check("palette adds connector", afterAdd === 5, "count=" + afterAdd);

  // 4. drag a node (X2) by -80,+40 (leftward, stays inside the canvas)
  const x2 = page.locator('.node[data-id]').filter({ hasText: "X2" }).first();
  const before = await x2.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 80, before.y + 50, { steps: 5 });
  await page.mouse.up();
  const after = await x2.boundingBox();
  check("node drags", Math.abs(after.x - before.x + 80) < 3 && Math.abs(after.y - before.y - 40) < 3,
    `dx=${(after.x - before.x).toFixed(1)} dy=${(after.y - before.y).toFixed(1)}`);

  // 5. connect X2 (right handle) to the new connector via handle drag
  const connCountBefore = await page.locator(".conn").count();
  const newX = page.locator(".node").nth(4); // newly added connector
  const nb = await newX.boundingBox();
  // drag from X2's right handle (exact circle center) to new node body
  const handle = page.locator('g.node:has-text("X2") circle.handle[data-handle="right"]');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2, { steps: 8 });
  await page.mouse.up();
  const connCountAfter = await page.locator(".conn").count();
  check("handle drag creates connection", connCountAfter === connCountBefore + 1,
    `before=${connCountBefore} after=${connCountAfter}`);

  // 5b. splice palette entry
  await page.click('.palette-item[data-kind="splice"]');
  const spliceCount = await page.locator('g.node:has-text("S1")').count();
  check("splice adds simple connector S1", spliceCount >= 1, "count=" + spliceCount);
  await page.waitForTimeout(400); // debounced yaml refresh
  const yamlSplice = await page.inputValue("#yaml-view");
  check("splice exports style simple", /S1:[\s\S]*style: simple/.test(yamlSplice));

  // 5c. pin-level click-to-connect: X1 pin 1 -> X2 pin 1
  const connBeforePins = await page.locator(".conn").count();
  await page.locator('g.node:has-text("X1") circle.pin[data-pin="1"]').first().click();
  const pendingDots = await page.locator("circle.pin.pending").count();
  check("pin click sets pending state", pendingDots === 1, "pending=" + pendingDots);
  await page.locator('g.node:has-text("X2") circle.pin[data-pin="1"]').first().click();
  const connAfterPins = await page.locator(".conn").count();
  check("pin click creates mate connection", connAfterPins === connBeforePins + 1,
    `before=${connBeforePins} after=${connAfterPins}`);
  await page.waitForTimeout(400);
  const yamlPins = await page.inputValue("#yaml-view");
  check("pin mate lands in yaml", /X1: 1[\s\S]*?-->[\s\S]*?X2: 1/.test(yamlPins) || /X1: 1/.test(yamlPins));

  // 5d. pin-to-pin DRAG appends to the same mate set
  const p1 = await page.locator('g.node:has-text("X1") circle.pin[data-pin="2"]').first().boundingBox();
  const p2 = await page.locator('g.node:has-text("X2") circle.pin[data-pin="2"]').first().boundingBox();
  await page.mouse.move(p1.x + p1.width / 2, p1.y + p1.height / 2);
  await page.mouse.down();
  await page.mouse.move(p2.x + p2.width / 2, p2.y + p2.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const listText = await page.locator("#connection-list").textContent();
  check("pin drag appends to mate set", listText.includes("X1:1,2") && listText.includes("X2:1,2"),
    listText.slice(0, 90));

  // 5e. double-click a wire opens wire properties (voltage/signal labels, colors)
  await page.locator(".conn-hit").first().dispatchEvent("dblclick");
  const wireProps = await page.locator('#inspector h2:has-text("Wire properties")').count();
  check("dblclick wire shows wire properties", wireProps >= 1);
  await page.locator("#inspector textarea").first().fill("12V\nGND\nDATA");
  await page.waitForTimeout(400);
  const yamlWire = await page.inputValue("#yaml-view");
  check("wirelabels land in yaml", /wirelabels:[\s\S]*- 12V/.test(yamlWire));

  // 6. inspector edits: select X1, change Type via its label
  await page.locator('g.node:has-text("X1")').first().click();
  await page.getByLabel("Type", { exact: true }).fill("D-Sub DB-9");
  await page.waitForTimeout(300);
  const yaml2 = await page.inputValue("#yaml-view");
  check("inspector edit updates yaml", /DB-9/.test(yaml2));

  // 7. image upload on X1
  fs.writeFileSync("/tmp/opencode/test-image.png", makePng(60, 40, [30, 120, 220]));
  await page.locator('g.node:has-text("X1")').first().click();
  await page.click('#inspector button:has-text("Add image")');
  await page.setInputFiles("#file-image", "/tmp/opencode/test-image.png");
  await page.waitForSelector(".node image", { timeout: 5000 });
  await page.waitForTimeout(400); // allow debounced yaml refresh
  check("image upload shows on canvas", true);
  const yaml3 = await page.inputValue("#yaml-view");
  check("yaml includes image src", /images\/X1\.png/.test(yaml3), yaml3.match(/images\/[^\s"']+/)?.[0] || "none");

  // 8. save project download
  const dlPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.click("#btn-save");
  const dl = await dlPromise;
  check("project save downloads", /wvproj\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  // 9. zip bundle download
  const dl2Promise = page.waitForEvent("download", { timeout: 10000 });
  await page.click("#btn-export-zip");
  const dl2 = await dl2Promise;
  check("zip bundle downloads", /\.zip$/.test(dl2.suggestedFilename()), dl2.suggestedFilename());
  fs.writeFileSync("/tmp/opencode/bundle.zip", await dl2.path().then((p) => fs.readFileSync(p)));

  // 10. real WireViz render (Pyodide) — the big one
  await page.click("#btn-render");
  await page.waitForSelector("#preview-holder svg", { timeout: 240000 });
  const svgHtml = await page.innerHTML("#preview-holder");
  check("wireviz render produces svg", svgHtml.includes("<svg"), "len=" + svgHtml.length);
  check("render includes pinlabels", /DCD/.test(svgHtml));
  check("render embeds uploaded image", /data:image\/png;base64/.test(svgHtml));

  // 10b. BOM tab populated from the real render
  await page.click('.tabs .tab[data-tab="bom"]');
  await page.waitForSelector("#bom-holder table", { timeout: 5000 });
  const bomRows = await page.locator("#bom-holder tbody tr").count();
  check("bom tab has rows", bomRows >= 2, "rows=" + bomRows);
  const dl3Promise = page.waitForEvent("download", { timeout: 10000 });
  await page.click("#btn-download-bom");
  const dl3 = await dl3Promise;
  check("bom tsv downloads", /\.bom\.tsv$/.test(dl3.suggestedFilename()), dl3.suggestedFilename());

  // 10c. standalone HTML export
  await page.click('.tabs .tab[data-tab="preview"]');
  const dl4Promise = page.waitForEvent("download", { timeout: 10000 });
  await page.click("#btn-export-html");
  const dl4 = await dl4Promise;
  check("html export downloads", /\.html$/.test(dl4.suggestedFilename()), dl4.suggestedFilename());
  const htmlPath = await dl4.path();
  const htmlOut = fs.readFileSync(htmlPath, "utf8");
  check("html export embeds diagram+bom", htmlOut.includes("<svg") && htmlOut.includes("Bill of Materials"));

  // 11. yaml apply round-trip
  await page.click('.tabs .tab[data-tab="yaml"]');
  await page.click("#btn-apply-yaml");
  await page.waitForTimeout(300);
  const nodeCountAfterApply = await page.locator(".node").count();
  check("yaml apply round-trips", nodeCountAfterApply >= 4, "count=" + nodeCountAfterApply);

  // 12. resizable bottom panel (drag + persist across reload)
  const hBefore = await page.evaluate(() => document.getElementById("bottom-panel").getBoundingClientRect().height);
  const rz = await page.locator("#panel-resizer").boundingBox();
  await page.mouse.move(rz.x + rz.width / 2, rz.y + rz.height / 2);
  await page.mouse.down();
  await page.mouse.move(rz.x + 10, rz.y - 120, { steps: 5 });
  await page.mouse.up();
  const hAfter = await page.evaluate(() => document.getElementById("bottom-panel").getBoundingClientRect().height);
  check("panel resizes by drag", hAfter > hBefore + 80, `before=${hBefore} after=${hAfter}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".node");
  const hPersisted = await page.evaluate(() => document.getElementById("bottom-panel").getBoundingClientRect().height);
  check("panel height persists after reload", Math.abs(hPersisted - hAfter) < 3, `persisted=${hPersisted}`);

  await page.screenshot({ path: "/tmp/opencode/wireviz-gui-test.png" });
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length ? "FAILED: " + failed.length : "ALL PASSED") + " (" + results.length + " checks)");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });
