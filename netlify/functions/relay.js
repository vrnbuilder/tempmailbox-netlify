// netlify/functions/relay.js
// mail.tm backend relay for TempMailBox

const MAILTM_BASE = "https://api.mail.tm";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

async function readBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function mtFetch(path, options = {}) {
  return fetch(`${MAILTM_BASE}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
}

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data["hydra:member"])) return data["hydra:member"];
  if (Array.isArray(data.member)) return data.member;
  return [];
}

function randomLocalPart() {
  const words = [
    "nova", "quick", "safe", "pixel", "green", "fast",
    "alpha", "cloud", "orbit", "fresh", "clean", "box",
    "drop", "mail", "inbox", "light", "swift", "blue"
  ];

  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}${num}`;
}

function randomPassword() {
  return `Tmb-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const action = params.action || "health";

    if (action === "health") {
      return json(200, {
        ok: true,
        provider: "mail.tm",
        ts: Date.now(),
      });
    }

    if (action === "newInbox") {
      const domainRes = await mtFetch("/domains");

      if (!domainRes.ok) {
        const body = await readBody(domainRes);
        return json(domainRes.status, {
          error: "domains_failed",
          detail: body,
        });
      }

      const domainData = await readBody(domainRes);
      const allDomains = extractArray(domainData);

      const domains = allDomains.filter((d) => {
        return d && d.domain && d.isActive !== false && d.isPrivate !== true;
      });

      if (!domains.length) {
        return json(500, {
          error: "no_domains_available",
          detail: domainData,
        });
      }

      let lastError = null;

      for (const domainObj of domains) {
        const domain = domainObj.domain;

        for (let i = 0; i < 12; i++) {
          const address = `${randomLocalPart()}@${domain}`;
          const password = randomPassword();

          const accountRes = await mtFetch("/accounts", {
            method: "POST",
            body: JSON.stringify({
              address,
              password,
            }),
          });

          if (!accountRes.ok) {
            lastError = await readBody(accountRes);
            continue;
          }

          const account = await readBody(accountRes);

          const tokenRes = await mtFetch("/token", {
            method: "POST",
            body: JSON.stringify({
              address,
              password,
            }),
          });

          if (!tokenRes.ok) {
            lastError = await readBody(tokenRes);
            continue;
          }

          const tokenData = await readBody(tokenRes);

          if (!tokenData.token) {
            lastError = tokenData;
            continue;
          }

          return json(200, {
            address,
            inboxId: account.id,
            token: tokenData.token,
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
        }
      }

      return json(500, {
        error: "could_not_create_account",
        detail: lastError,
      });
    }

    if (action === "getMessages") {
      const token = params.token;

      if (!token) {
        return json(400, { error: "missing_token" });
      }

      const res = await mtFetch("/messages", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const body = await readBody(res);
        return json(res.status, {
          error: "messages_failed",
          detail: body,
        });
      }

      const data = await readBody(res);
      const messages = extractArray(data);

      const items = messages.map((m) => ({
        id: m.id,
        from: m.from && m.from.address ? m.from.address : "",
        subject: m.subject || "(no subject)",
        createdAt: m.createdAt || "",
      }));

      return json(200, items);
    }

    if (action === "readMessage") {
      const token = params.token;
      const id = params.id;

      if (!token || !id) {
        return json(400, { error: "missing_token_or_id" });
      }

      const res = await mtFetch(`/messages/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const body = await readBody(res);
        return json(res.status, {
          error: "message_failed",
          detail: body,
        });
      }

      const msg = await readBody(res);

      const htmlBody = Array.isArray(msg.html)
        ? msg.html.join("")
        : msg.html || null;

      const textBody = Array.isArray(msg.text)
        ? msg.text.join("\n")
        : msg.text || msg.intro || "";

      return json(200, {
        id: msg.id,
        subject: msg.subject || "(no subject)",
        from: msg.from && msg.from.address ? msg.from.address : "",
        to: Array.isArray(msg.to)
          ? msg.to.map((x) => x.address).join(", ")
          : "",
        createdAt: msg.createdAt || "",
        body: textBody,
        htmlBody,
      });
    }

    return json(400, {
      error: "unknown_action",
      action,
    });
  } catch (err) {
    return json(500, {
      error: "server_error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
