// Local regression test for untrusted email rendering (audit findings F1, F10).
//
//   node tests/email-rendering.test.js [path/to/index.html]
//
// Needs Node and an installed Edge or Chrome (or set BROWSER to its path).
// It installs nothing and contacts nothing outside this computer: a loopback
// server stands in for the relay, and the browser's DNS is blocked for every
// other host. All addresses, tokens and messages below are fake, and the
// payloads only set a local flag.

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const INDEX = path.resolve(process.argv[2] || path.join(__dirname, "..", "index.html"));
const TIMEOUT_MS = 60000;

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

// On Windows, killing the launcher leaves the browser's child processes running.
function stopBrowser(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

function buildMessages(origin) {
  const fire = (where) => `window.__xssFired='${where}'`;
  const tracker = (name) => `${origin}/__tracker/${name}`;
  const manyLinks = Array.from({ length: 25 }, (_, i) =>
    `<a href="https://example.test/link/${i}">Link ${i}</a>`
  ).join(" ");

  return [
    {
      id: "metadata",
      subject: `<img src=x onerror="${fire("subject")}">Subject & <b>bold</b>`,
      from: `"><script>${fire("from")}</script><svg onload="${fire("from-svg")}">@example.test`,
      to: `<iframe srcdoc="<script>parent.__xssFired='to'</script>"></iframe>@example.test`,
      body: "Plain body",
      htmlBody: null,
    },
    {
      id: "html-only",
      subject: "HTML only",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: "",
      htmlBody: `<html><head><title>Hidden title</title>
        <link rel="stylesheet" href="${tracker("stylesheet")}">
        <style>@import url("${tracker("import")}"); body { background: url("${tracker("css")}") }</style></head>
        <body background="${tracker("body")}" onload="${fire("body-onload")}">
        <!-- hidden comment -->
        <p onclick="${fire("onclick")}">Visible paragraph &amp; &lt;script&gt;literal&lt;/script&gt;</p>
        <script>${fire("script")}</script>
        <img src="${tracker("pixel")}" srcset="${tracker("srcset")} 2x" alt="Logo alt" onerror="${fire("img")}">
        <video poster="${tracker("poster")}" src="${tracker("video")}"></video>
        <iframe src="${tracker("iframe")}"></iframe>
        <span style="display:none">Hidden preheader</span>
        <a href="https://example.test/verify?a=1&amp;b=2">Confirm account</a>
        <a href="javascript:${fire("js-link")}">Bad script link</a>
        <a href="data:text/html,<script>${fire("data")}</script>">Bad data link</a>
        <a href="/relative">Relative link</a>
        </body></html>`,
    },
    {
      id: "plain-text",
      subject: "Plain text",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: `<b>not bold</b> & 5 < 6 "double" 'single'\nSecond line https://example.test/plain?x=1.`,
      htmlBody: null,
    },
    {
      id: "preview-body",
      subject: "Short preview body",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: "Short preview",
      htmlBody: "<p>Short preview and the full message that follows it.</p>",
    },
    {
      id: "image-only-html",
      subject: "Better text version",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: "The complete plain-text alternative is longer here.",
      htmlBody: "<p>Tiny</p>",
    },
    {
      id: "malformed",
      subject: "Malformed",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: "",
      htmlBody: `<scr<script>ipt>${fire("split")}</scr</script>ipt>
        <noscript><img src=x onerror="${fire("noscript")}"></noscript>
        <svg><script>${fire("svg")}</script></svg>
        <math><mtext><table><mglyph><style><img src=x onerror="${fire("mxss")}">
        <img src=x onerror="${fire("unterminated")}"`,
    },
    {
      id: "many-links",
      subject: "Many links",
      from: "sender@example.test",
      to: "inbox@example.test",
      body: "",
      htmlBody: `<p>Link list</p>${manyLinks}`,
    },
    {
      id: "empty",
      subject: "",
      from: "",
      to: "",
      body: "",
      htmlBody: null,
    },
  ];
}

// Runs inside the page. Results go back to the loopback server.
function pageDriver() {
  const results = [];
  const check = (name, pass, detail) =>
    results.push({ name, pass: Boolean(pass), detail: pass ? "" : String(detail || "") });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const byId = (id) => document.getElementById(id);

  async function until(test, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (test()) return true;
      await sleep(25);
    }
    return false;
  }

  const copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => { copied.push(value); } },
  });

  const FORBIDDEN = "img,script,iframe,frame,a,style,link,svg,math,object,embed,video,audio,source,form,base,meta";

  function checkDomSafe(label) {
    for (const id of ["inboxList", "msgBody"]) {
      const root = byId(id);
      const bad = [...root.querySelectorAll(FORBIDDEN)].map((node) => node.localName);
      check(`${label}: #${id} has no active or remote elements`, bad.length === 0, bad.join(","));

      const handlers = [...root.querySelectorAll("*")].flatMap((node) =>
        node.getAttributeNames().filter((name) => name.toLowerCase().startsWith("on"))
      );
      check(`${label}: #${id} has no event-handler attributes`, handlers.length === 0, handlers.join(","));
    }
    check(`${label}: no payload executed`, window.__xssFired === undefined, window.__xssFired);
  }

  async function open(index, label) {
    const before = byId("msgBody").textContent;
    const row = byId("inboxList").children[index];
    if (!row) {
      check(`${label}: inbox row exists`, false, `missing row ${index}`);
      return "";
    }
    row.click();
    await until(() => byId("msgBody").textContent !== before);
    await sleep(250);
    checkDomSafe(label);
    return byId("msgBody").textContent;
  }

  async function run() {
    const start = location.href;

    await until(() => byId("emailText").textContent.includes("@"));
    const firstAddress = byId("emailText").textContent;
    check("address generation shows an address", firstAddress === "first@example.test", firstAddress);

    await until(() => /^\d\d:\d\d$/.test(byId("countdown").textContent));
    const initial = byId("countdown").textContent;
    check("countdown starts near ten minutes", /^(10:00|09:5\d)$/.test(initial), initial);
    await sleep(1200);
    check("countdown ticks down", byId("countdown").textContent !== initial, byId("countdown").textContent);

    byId("btnCopy").click();
    await until(() => copied.length > 0);
    check("Copy copies the address", copied[0] === firstAddress, copied[0]);

    byId("btnExtend").click();
    const extended = byId("countdown").textContent;
    check("Extend adds ten minutes", /^(20:00|19:5\d)$/.test(extended), extended);

    byId("btnRefresh").click();
    await until(() => byId("inboxList").children.length === 8);
    await sleep(250);
    check("Refresh lists every message", byId("inboxList").children.length === 8, byId("inboxList").children.length);
    checkDomSafe("inbox list");

    const listText = byId("inboxList").textContent;
    check("list shows subject markup as text", listText.includes("<b>bold</b>"), listText.slice(0, 200));
    check("list shows sender markup as text", listText.includes("<svg onload="), listText.slice(0, 200));
    check("list falls back for an empty subject", listText.includes("(no subject)"), listText.slice(-200));

    byId("btnRefresh").click();
    await sleep(100);
    check("Refresh throttle still applies", byId("alert").textContent.includes("Wait 10 seconds"), byId("alert").textContent);

    const metadata = await open(0, "metadata");
    check("subject markup is visible text", metadata.includes("<b>bold</b>"), metadata);
    check("sender markup is visible text", metadata.includes("<script>"), metadata);
    check("recipient markup is visible text", metadata.includes("<iframe srcdoc="), metadata);

    const htmlOnly = await open(1, "html-only");
    check("HTML-only text is extracted", htmlOnly.includes("Visible paragraph &"), htmlOnly);
    check("escaped markup stays literal", htmlOnly.includes("<script>literal</script>"), htmlOnly);
    check("image alt text is kept", htmlOnly.includes("Logo alt"), htmlOnly);
    check("link label is kept", htmlOnly.includes("Confirm account"), htmlOnly);
    check("link URL is shown", htmlOnly.includes("https://example.test/verify?a=1&b=2"), htmlOnly);
    check("hidden text is left out", !htmlOnly.includes("Hidden preheader"), htmlOnly);
    check("head title is left out", !htmlOnly.includes("Hidden title"), htmlOnly);
    check("CSS text is left out", !htmlOnly.includes("@import"), htmlOnly);
    check("comments are left out", !htmlOnly.includes("hidden comment"), htmlOnly);
    check("javascript: URL is not offered", !htmlOnly.includes("javascript:"), htmlOnly);
    check("data: URL is not offered", !htmlOnly.includes("data:text"), htmlOnly);

    const linkButtons = [...byId("msgBody").querySelectorAll("button")];
    check("only the http link gets a Copy button", linkButtons.length === 1, linkButtons.length);
    if (linkButtons[0]) {
      copied.length = 0;
      linkButtons[0].click();
      await until(() => copied.length > 0);
      check("Copy link copies the exact URL", copied[0] === "https://example.test/verify?a=1&b=2", copied[0]);
      check("Copy link does not navigate", location.href === start, location.href);
    }

    const plain = await open(2, "plain-text");
    check("plain text keeps special characters", plain.includes(`<b>not bold</b> & 5 < 6 "double" 'single'`), plain);
    const bodyBox = byId("msgBody").querySelector(".whitespace-pre-wrap");
    check("plain text keeps line breaks", bodyBox && bodyBox.textContent.includes("\nSecond line"), bodyBox && bodyBox.textContent);
    check("link trailing punctuation is trimmed", [...byId("msgBody").querySelectorAll(".break-all")].some((node) => node.textContent === "https://example.test/plain?x=1"), plain);

    const preview = await open(3, "preview-body");
    check("full HTML text beats a short preview", preview.includes("the full message that follows"), preview);

    const betterText = await open(4, "image-only-html");
    check("longer plain text beats thin HTML", betterText.includes("complete plain-text alternative"), betterText);

    const malformed = await open(5, "malformed");
    check("malformed HTML opens without error", !byId("alert").textContent.includes("Could not open"), byId("alert").textContent);
    check("malformed HTML leaves no script text", !malformed.includes("__xssFired='svg'"), malformed);

    const many = await open(6, "many-links");
    check("link list is capped at 20", byId("msgBody").querySelectorAll("button").length === 20, byId("msgBody").querySelectorAll("button").length);
    check("hidden links are counted", many.includes("5 more link(s) not shown."), many);

    const empty = await open(7, "empty");
    check("empty message has a fallback", empty.includes("No message body."), empty);

    byId("btnNew").click();
    await until(() => byId("emailText").textContent === "second@example.test");
    check("New Address replaces the address", byId("emailText").textContent === "second@example.test", byId("emailText").textContent);
    check("New Address resets the message pane", byId("msgBody").textContent.trim() === "Select a message to read it.", byId("msgBody").textContent);
    check("New Address resets the inbox list", byId("inboxList").children.length === 1, byId("inboxList").children.length);

    await sleep(500);
    check("no payload executed by the end", window.__xssFired === undefined, window.__xssFired);
  }

  run()
    .catch((err) => check("driver finished", false, err && err.message))
    .finally(() => fetch("/__report", { method: "POST", body: JSON.stringify(results) }));
}

function staticChecks(source) {
  const sinks = /\.(innerHTML|outerHTML)\s*\+?=|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|srcdoc/g;
  const found = source.match(sinks) || [];
  return [{
    name: "index.html has no HTML-parsing page sinks",
    pass: found.length === 0,
    detail: found.join(", "),
  }];
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error("No Edge or Chrome found. Set BROWSER to its path.");
    process.exit(2);
  }

  const source = fs.readFileSync(INDEX, "utf8");
  const trackerHits = [];
  const unexpected = [];
  let inboxCount = 0;
  let messages = [];
  let finish;
  const reported = new Promise((resolve) => { finish = resolve; });

  const sendJson = (res, value) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(source.replace("</body>", () => `<script src="/__driver.js"></script></body>`));
      return;
    }

    if (url.pathname === "/__driver.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(`(${pageDriver.toString()})();`);
      return;
    }

    if (url.pathname === "/.netlify/functions/relay") {
      const action = url.searchParams.get("action");
      if (action === "newInbox") {
        inboxCount += 1;
        sendJson(res, {
          address: inboxCount === 1 ? "first@example.test" : "second@example.test",
          inboxId: `local-inbox-${inboxCount}`,
          token: "local-fake-token",
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
      } else if (action === "getMessages") {
        sendJson(res, messages.map(({ id, from, subject }) => ({
          id,
          from,
          subject: subject || "(no subject)",
          createdAt: "2026-01-01T00:00:00Z",
        })));
      } else if (action === "readMessage") {
        const msg = messages.find((item) => item.id === url.searchParams.get("id"));
        sendJson(res, { ...msg, createdAt: "2026-01-01T00:00:00Z" });
      } else {
        sendJson(res, { error: "unknown_action" });
      }
      return;
    }

    if (url.pathname.startsWith("/__tracker/")) {
      trackerHits.push(url.pathname);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/__report" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(204);
        res.end();
        finish(JSON.parse(body));
      });
      return;
    }

    if (url.pathname !== "/favicon.ico") unexpected.push(url.pathname);
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  messages = buildMessages(origin);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "email-render-test-"));
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--user-data-dir=${profile}`,
    `${origin}/`,
  ], { stdio: "ignore" });

  const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  const pageResults = await Promise.race([reported, timedOut]);

  stopBrowser(child);
  server.close();
  server.closeAllConnections();
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* browser may still hold it */ }
  }, 1000);

  const results = [
    ...staticChecks(source),
    ...(pageResults || [{ name: "browser reported results", pass: false, detail: "timed out" }]),
    { name: "no remote email content was requested", pass: trackerHits.length === 0, detail: trackerHits.join(", ") },
    { name: "no unexpected local requests", pass: unexpected.length === 0, detail: unexpected.join(", ") },
  ];

  const failed = results.filter((result) => !result.pass);
  failed.forEach((result) => console.log(`FAIL  ${result.name}${result.detail ? ` -> ${result.detail.slice(0, 160)}` : ""}`));
  console.log(`\n${path.basename(browser)}: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 1200);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
