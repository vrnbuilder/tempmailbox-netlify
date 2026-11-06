// Local regression test for untrusted email rendering (audit findings F1, F10).
//
//   node tests/email-rendering.test.js [path/to/index.html]
//
// Needs Node and an installed Edge or Chrome. Set BROWSER to a browser's path
// to choose one; Firefox also works. It installs nothing and contacts nothing
// outside this computer: a loopback server stands in for the relay, and the
// browser cannot reach any other host. All addresses, tokens and messages
// below are fake, and the payloads only set a local flag.

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const INDEX = path.resolve(process.argv[2] || path.join(__dirname, "..", "index.html"));
const TIMEOUT_MS = 150000;
const SAFE_MARKER = "safe-marker";

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

function browserArgs(browser, profile, url) {
  if (/firefox/i.test(path.basename(browser))) {
    // Firefox has no host-blocking switch, so send other hosts to a closed port.
    const prefs = {
      "network.proxy.type": 1,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": 9,
      "network.proxy.ssl": "127.0.0.1",
      "network.proxy.ssl_port": 9,
      "network.proxy.no_proxies_on": "127.0.0.1",
      "network.proxy.allow_hijacking_localhost": false,
      "network.captive-portal-service.enabled": false,
      "network.connectivity-service.enabled": false,
      "app.update.enabled": false,
      "browser.shell.checkDefaultBrowser": false,
      "datareporting.policy.dataSubmissionEnabled": false,
      "toolkit.telemetry.enabled": false,
    };
    const lines = Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    fs.writeFileSync(path.join(profile, "user.js"), `${lines.join("\n")}\n`);
    return ["-headless", "-no-remote", "-profile", profile, url];
  }

  return [
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
    url,
  ];
}

// On Windows, Edge's launcher exits and the real browser outlives it, so stop
// processes by this run's unique profile folder. That leaves the user's own
// browser windows alone.
function stopBrowser(child, profile) {
  child.kill();
  if (process.platform !== "win32") return;
  const command = "Get-CimInstance Win32_Process | " +
    `Where-Object { $_.CommandLine -like '*${profile}*' } | ` +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore" });
}

// Each payload is parsed after a visible marker, so a test can also confirm
// that the safe text around it survives.
function dangerousPayloads(fire, tracker) {
  const onError = (name) => `<img src=x onerror="${fire(name)}">`;
  return [
    ["img onerror", onError("img")],
    ["unterminated img", `<img src=x onerror="${fire("unterminated")}"`],
    ["remote image", `<img src="${tracker("d-img")}">`],
    ["image srcset", `<img srcset="${tracker("d-srcset")} 1x">`],
    ["picture source", `<picture><source srcset="${tracker("d-picture")}"><img></picture>`],
    ["input image", `<input type="image" src="${tracker("d-input")}">`],
    ["css import", `<style>@import "${tracker("d-import")}";</style>`],
    ["css url in style", `<style>p { background: url("${tracker("d-style")}") }</style>`],
    ["css url inline", `<div style="background:url('${tracker("d-inline")}')">x</div>`],
    ["css font", `<style>@font-face { font-family: x; src: url("${tracker("d-font")}") } p { font-family: x }</style>`],
    ["stylesheet", `<link rel="stylesheet" href="${tracker("d-link")}">`],
    ["preload", `<link rel="preload" as="image" href="${tracker("d-preload")}">`],
    ["prefetch", `<link rel="prefetch" href="${tracker("d-prefetch")}">`],
    ["script src", `<script src="${tracker("d-script")}"></script>`],
    ["inline script", `<script>${fire("script")}</script>`],
    ["iframe src", `<iframe src="${tracker("d-iframe")}"></iframe>`],
    ["iframe srcdoc", `<iframe srcdoc="<script>parent.__xssFired='srcdoc'</script>"></iframe>`],
    ["iframe javascript", `<iframe src="javascript:parent.__xssFired='iframe-js'"></iframe>`],
    ["object", `<object data="${tracker("d-object")}"></object>`],
    ["embed", `<embed src="${tracker("d-embed")}">`],
    ["audio", `<audio src="${tracker("d-audio")}" autoplay></audio>`],
    ["video poster", `<video poster="${tracker("d-poster")}"></video>`],
    ["video source", `<video autoplay><source src="${tracker("d-source")}"></video>`],
    ["video onerror", `<video src=x onerror="${fire("video")}"></video>`],
    ["svg onload", `<svg onload="${fire("svg-onload")}"></svg>`],
    ["svg script", `<svg><script>${fire("svg-script")}</script></svg>`],
    ["svg image", `<svg><image href="${tracker("d-svg-image")}"></image></svg>`],
    ["svg use", `<svg><use href="${tracker("d-svg-use")}#x"></use></svg>`],
    ["svg animate", `<svg><animate onbegin="${fire("svg-animate")}" attributeName="x" dur="1s"></animate></svg>`],
    ["svg foreignObject", `<svg><foreignObject>${onError("svg-foreign")}</foreignObject></svg>`],
    ["svg link", `<svg><a href="javascript:${fire("svg-a")}"><text>x</text></a></svg>`],
    ["math link", `<math><a href="javascript:${fire("math-a")}">x</a></math>`],
    ["details ontoggle", `<details open ontoggle="${fire("details")}">x</details>`],
    ["marquee onstart", `<marquee onstart="${fire("marquee")}">x</marquee>`],
    ["body onload", `<body onload="${fire("body")}">`],
    ["autofocus onfocus", `<input autofocus onfocus="${fire("focus")}">`],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=${tracker("d-refresh")}">`],
    ["base href", `<base href="${tracker("d-base")}/"><img src="relative.png">`],
    ["form submit", `<form action="${tracker("d-form")}"><input type="submit"></form>${onError("form")}`],
    ["noscript", `<noscript>${onError("noscript")}</noscript>`],
    ["template", `<template>${onError("template")}</template>`],
    ["comment breakout", `<!-->${onError("comment")}-->`],
    ["cdata", `<![CDATA[${onError("cdata")}]]>`],
    ["xmp", `<xmp>${onError("xmp")}</xmp>`],
    ["textarea", `<textarea>${onError("textarea")}</textarea>`],
    ["title", `<title>${onError("title")}</title>`],
    ["noembed", `<noembed>${onError("noembed")}</noembed>`],
    ["plaintext", `<plaintext>${onError("plaintext")}`],
    ["split tag", `<scr<script>ipt>${fire("split")}</scr</script>ipt>`],
    ["null byte", `<scr\u0000ipt>${fire("null")}</scr\u0000ipt>`],
    ["mutation select", `<select><template><style><!--</style><a rel="-->${onError("mxss-select").replace(/"/g, "'")}">`],
    ["mutation form", `<form><math><mtext></form><form><mglyph><style></math>${onError("mxss-form")}`],
    ["mutation table", `<math><mtext><table><mglyph><style>${onError("mxss-table")}`],
  ];
}

function buildMessages(origin) {
  const fire = (where) => `window.__xssFired='${where}'`;
  const tracker = (name) => `${origin}/__tracker/${name}`;
  const sender = { from: "sender@example.test", to: "inbox@example.test" };
  const nested = `${"<div>".repeat(3000)}Deep text${"</div>".repeat(3000)}`;
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
    {
      id: "complete-plain",
      subject: "Complete plain text",
      ...sender,
      body: "Complete plain-text message.\nVisit https://example.test/plain-link now.",
      htmlBody: `<p>The styled version adds a great deal of extra marketing text that makes it far longer than the plain text.</p>
        <a href="https://example.test/html-link">HTML only link</a>`,
    },
    {
      id: "preview-ellipsis",
      subject: "Truncated with ellipsis",
      ...sender,
      body: "The first part of the mess…",
      htmlBody: `<p>The first part of the message, followed by the rest.</p><a href="https://example.test/rest">Finish</a>`,
    },
    {
      id: "preview-whitespace",
      subject: "Truncated with odd spacing",
      ...sender,
      body: "Hello there friend",
      htmlBody: "<p>Hello&nbsp;there\n &zwnj;friend, and welcome to the service.</p>",
    },
    {
      id: "short-complete",
      subject: "Short but not a preview",
      ...sender,
      body: "Hi",
      htmlBody: "<p>Completely different and much longer HTML text.</p>",
    },
    {
      id: "identical",
      subject: "Same text in both versions",
      ...sender,
      body: "Same text",
      htmlBody: "<p>Same   text</p>",
    },
    {
      id: "hidden-lead",
      subject: "Preview from hidden text",
      ...sender,
      body: "Hidden lead in",
      htmlBody: `<div style="display:none">Hidden lead in text</div><p>The visible message.</p>`,
    },
    {
      id: "mixed",
      subject: "Mixed content",
      ...sender,
      body: "See https://example.test/a for details.",
      htmlBody: `<p>Please open <a href="https://example.test/b">this page</a> or https://example.test/c today.</p>`,
    },
    {
      id: "html-link-only",
      subject: "Same text, extra HTML link",
      ...sender,
      body: "Press the button",
      htmlBody: `<p><a href="https://example.test/button">Press the button</a></p>`,
    },
    {
      id: "clobber-document",
      subject: "Clobbered document",
      ...sender,
      body: "",
      htmlBody: `<img name="body" alt="Clobbered alt"><form name="body"></form><p>Real document text</p>`,
    },
    {
      id: "clobber-form",
      subject: "Clobbered form",
      ...sender,
      body: "",
      htmlBody: `<form><input name="childNodes"><input name="nodeType"><input name="localName">
        <input name="getAttribute"><input name="hasAttribute"><p>Text inside form</p>
        <a href="https://example.test/in-form">Form link</a></form>`,
    },
    {
      id: "deep-nesting",
      subject: "Deep nesting",
      ...sender,
      body: "",
      htmlBody: nested,
    },
    {
      id: "url-schemes",
      subject: "URL schemes",
      ...sender,
      body: "",
      htmlBody: `<p>Scheme list</p>
        <a href="javascript:${fire("js")}">a</a>
        <a href="JaVaScRiPt:${fire("js-case")}">b</a>
        <a href=" java&#9;script:${fire("js-tab")}">c</a>
        <a href="vbscript:msgbox(1)">d</a>
        <a href="data:text/html,<script>${fire("data")}</script>">e</a>
        <a href="data:image/svg+xml,<svg onload='${fire("data-svg")}'/>">f</a>
        <a href="file:///C:/Windows/win.ini">g</a>
        <a href="blob:https://example.test/1">h</a>
        <a href="ftp://example.test/x">i</a>
        <a href="mailto:someone@example.test">j</a>
        <a href="tel:+100">k</a>
        <a href="//example.test/protocol-relative">l</a>
        <a href="/relative">m</a>
        <a href="#fragment">n</a>
        <a href="https://example.test/allowed">Allowed</a>`,
    },
    ...dangerousPayloads(fire, tracker).map(([name, payload], index) => ({
      id: `dangerous-${index}`,
      subject: `Dangerous: ${name}`,
      ...sender,
      body: "",
      htmlBody: `<p>${SAFE_MARKER}</p>${payload}`,
    })),
  ];
}

// Runs inside the page. Results go back to the loopback server.
function pageDriver(rows, marker) {
  const total = rows.length;
  const rowOf = (id) => rows.findIndex((row) => row.id === id);
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

  // Watches the whole page, so active content cannot hide outside the panes.
  const activeAdded = [];
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        for (const item of [node, ...node.querySelectorAll("*")]) {
          const handler = item.getAttributeNames().some((name) => name.toLowerCase().startsWith("on"));
          if (item.matches(FORBIDDEN) || handler) activeAdded.push(item.localName);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  let windowsOpened = 0;
  window.open = () => {
    windowsOpened += 1;
    return null;
  };

  const shownUrls = () => [...byId("msgBody").querySelectorAll(".break-all")].map((node) => node.textContent);
  const copyButtons = () => [...byId("msgBody").querySelectorAll("button")].filter((node) => node.textContent === "Copy link");
  const switchButton = () => [...byId("msgBody").querySelectorAll("button")].find((node) => node.textContent.startsWith("Show "));
  const shownBody = () => {
    const box = byId("msgBody").querySelector(".whitespace-pre-wrap");
    return box ? box.textContent : "";
  };

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

  async function open(index, label, settle = 250) {
    const before = byId("msgBody").textContent;
    const row = byId("inboxList").children[index];
    if (!row) {
      check(`${label}: inbox row exists`, false, `missing row ${index}`);
      return "";
    }
    row.click();
    await until(() => byId("msgBody").textContent !== before);
    await sleep(settle);
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
    await until(() => byId("inboxList").children.length === total);
    await sleep(250);
    check("Refresh lists every message", byId("inboxList").children.length === total, byId("inboxList").children.length);
    checkDomSafe("inbox list");

    const listText = byId("inboxList").textContent;
    check("list shows subject markup as text", listText.includes("<b>bold</b>"), listText.slice(0, 200));
    check("list shows sender markup as text", listText.includes("<svg onload="), listText.slice(0, 200));
    check("list falls back for an empty subject", listText.includes("(no subject)"), listText.slice(0, 200));

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
    check("complete plain text beats thin HTML", betterText.includes("complete plain-text alternative"), betterText);

    const malformed = await open(5, "malformed");
    check("malformed HTML opens without error", !byId("alert").textContent.includes("Could not open"), byId("alert").textContent);
    check("malformed HTML leaves no script text", !malformed.includes("__xssFired='svg'"), malformed);

    const many = await open(6, "many-links");
    check("link list is capped at 20", byId("msgBody").querySelectorAll("button").length === 20, byId("msgBody").querySelectorAll("button").length);
    check("hidden links are counted", many.includes("5 more link(s) not shown."), many);

    const empty = await open(7, "empty");
    check("empty message has a fallback", empty.includes("No message body."), empty);

    // Message version selection.
    await open(rowOf("complete-plain"), "complete-plain");
    check("complete plain text is preferred over longer HTML", shownBody().includes("Complete plain-text message.") && !shownBody().includes("styled version"), shownBody());
    check("links match the plain-text version", shownUrls().join() === "https://example.test/plain-link", shownUrls().join());
    check("link source is named as plain text", byId("msgBody").textContent.includes("Links in the plain-text version"), byId("msgBody").textContent);
    check("reader is told the HTML version differs", byId("msgBody").textContent.includes("The HTML version differs"), byId("msgBody").textContent);

    const toHtml = switchButton();
    check("a switch to the HTML version is offered", toHtml && toHtml.textContent === "Show HTML version as text", toHtml && toHtml.textContent);
    if (toHtml) {
      toHtml.click();
      await sleep(50);
      checkDomSafe("switched to HTML version");
      check("switch shows the HTML version", shownBody().includes("styled version") && !shownBody().includes("Complete plain-text"), shownBody());
      check("links follow the HTML version", shownUrls().join() === "https://example.test/html-link", shownUrls().join());
      check("link source is named as HTML", byId("msgBody").textContent.includes("Links in the HTML version"), byId("msgBody").textContent);

      const toPlain = switchButton();
      check("a switch back is offered", toPlain && toPlain.textContent === "Show plain-text version", toPlain && toPlain.textContent);
      if (toPlain) {
        toPlain.click();
        await sleep(50);
        check("switch back restores plain text", shownBody().includes("Complete plain-text message."), shownBody());
        check("links return to plain text", shownUrls().join() === "https://example.test/plain-link", shownUrls().join());
      }
    }

    await open(rowOf("preview-ellipsis"), "preview-ellipsis");
    check("truncated preview with an ellipsis uses HTML", shownBody().includes("followed by the rest"), shownBody());
    check("truncated preview shows the HTML link", shownUrls().join() === "https://example.test/rest", shownUrls().join());
    check("no switch when the preview adds nothing", !switchButton(), switchButton() && switchButton().textContent);

    await open(rowOf("preview-whitespace"), "preview-whitespace");
    check("preview is matched across spacing and invisible characters", shownBody().includes("welcome to the service"), shownBody());

    await open(rowOf("short-complete"), "short-complete");
    check("shorter text alone is not treated as a preview", shownBody() === "Hi", shownBody());
    check("short plain text still offers the HTML version", Boolean(switchButton()), "no switch");

    await open(rowOf("identical"), "identical");
    check("identical versions show the text", shownBody() === "Same text", shownBody());
    check("identical versions offer no switch", !switchButton(), switchButton() && switchButton().textContent);

    await open(rowOf("hidden-lead"), "hidden-lead");
    check("undetectable preview falls back to plain text", shownBody() === "Hidden lead in", shownBody());
    check("undetectable preview keeps the HTML version reachable", Boolean(switchButton()), "no switch");

    await open(rowOf("mixed"), "mixed");
    check("mixed message shows only plain-text links", shownUrls().join() === "https://example.test/a", shownUrls().join());
    if (switchButton()) {
      switchButton().click();
      await sleep(50);
      check("mixed message HTML links are complete", shownUrls().join() === "https://example.test/b,https://example.test/c", shownUrls().join());
    } else {
      check("mixed message offers the HTML version", false, "no switch");
    }

    await open(rowOf("html-link-only"), "html-link-only");
    check("a link only in HTML keeps the HTML version reachable", Boolean(switchButton()), "no switch");

    // DOM clobbering by named elements in the parsed email.
    await open(rowOf("clobber-document"), "clobber-document");
    check("named elements cannot replace the document body", shownBody().includes("Real document text"), shownBody());

    await open(rowOf("clobber-form"), "clobber-form");
    check("named inputs cannot hide form text", shownBody().includes("Text inside form"), shownBody());
    check("named inputs cannot hide form links", shownUrls().join() === "https://example.test/in-form", shownUrls().join());

    await open(rowOf("deep-nesting"), "deep-nesting");
    check("deeply nested HTML opens", shownBody().includes("Deep text"), byId("alert").textContent);

    await open(rowOf("url-schemes"), "url-schemes");
    check("only http and https links are offered", shownUrls().join() === "https://example.test/allowed", shownUrls().join());

    // Dangerous HTML.
    for (const [index, row] of rows.entries()) {
      if (!row.id.startsWith("dangerous-")) continue;
      await open(index, row.subject, 120);
      check(`${row.subject}: surrounding text survives`, shownBody().includes(marker), shownBody());
      check(`${row.subject}: no link offered`, copyButtons().length === 0, shownUrls().join());
    }

    await sleep(1000);
    check("no active element was added anywhere on the page", activeAdded.length === 0, [...new Set(activeAdded)].join(","));
    check("no window was opened", windowsOpened === 0, windowsOpened);
    check("the page did not navigate", location.href === start, location.href);

    const fetched = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/__tracker/"));
    check("browser timing shows no remote email content", fetched.length === 0, fetched.map((entry) => entry.name).join(", "));

    // Proves the tracker would have seen a request. The server expects this one.
    await new Promise((resolve) => {
      const image = new Image();
      image.onload = image.onerror = resolve;
      image.src = "/__tracker/positive-control";
    });

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
      const rows = messages.map(({ id, subject }) => ({ id, subject }));
      res.end(`(${pageDriver.toString()})(${JSON.stringify(rows)}, ${JSON.stringify(SAFE_MARKER)});`);
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
  const child = spawn(browser, browserArgs(browser, profile, `${origin}/`), { stdio: "ignore" });

  const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  const pageResults = await Promise.race([reported, timedOut]);

  stopBrowser(child, profile);
  server.close();
  server.closeAllConnections();
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* browser may still hold it */ }
  }, 1000);

  const POSITIVE_CONTROL = "/__tracker/positive-control";
  const remoteHits = trackerHits.filter((hit) => hit !== POSITIVE_CONTROL);

  const results = [
    ...staticChecks(source),
    ...(pageResults || [{ name: "browser reported results", pass: false, detail: "timed out" }]),
    { name: "no remote email content was requested", pass: remoteHits.length === 0, detail: remoteHits.join(", ") },
    { name: "tracker detection works (positive control)", pass: trackerHits.includes(POSITIVE_CONTROL), detail: "control request not seen" },
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
