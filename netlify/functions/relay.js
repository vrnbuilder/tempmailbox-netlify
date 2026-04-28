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

async function mtFetch(path, options = {}) {
  return fetch(`${MAILTM_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
}

function randomWord() {
  const words = [
    "nova", "quick", "safe", "mail", "inbox", "pixel", "green", "fast",
    "alpha", "cloud", "orbit", "fresh", "secure", "clean", "light"
  ];
  return words[Math.floor(Math.random() * words.length)];
}

function randomLocalPart() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${randomWord()}${num}`;
}

function randomPassword() {
  return `Tmb-${crypto.randomUUID()}-${Date.now()}`;
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const action = params.action || "health";

    if (action === "health") {
      return json(200, { ok: true, provider: "mail.tm", ts: Date.now() });
    }

    if (action === "newInbox") {
      const domainRes = await mtFetch("/domains");

      if (!domainRes.ok) {
        const text = await domainRes.text();
        return json(domainRes.status, {
          error: "domains_failed",
          bodySample: text.slice(0, 500),
        });
      }

      const domainData = await domainRes.json();
      const domains = domainData["hydra:member"] || domainData.member || [];

      if (!domains.length) {
        return json(500, { error: "no_domains_available" });
      }

      const usableDomains = domains.filter((d) => d.domain && !d.isPrivate);
      const domain = (usableDomains[0] || domains[0]).domain;

      let account = null;
      let password = null;

      for (let i = 0; i < 10; i++) {
        const address = `${randomLocalPart()}@${domain}`;
        password = randomPassword();

        const accountRes = await mtFetch("/accounts", {
          method: "POST",
          body: JSON.stringify({ address, password }),
        });

        if (accountRes.ok) {
          account = await accountRes.json();
          break;
        }
      }

      if (!account || !account.address) {
        return json(500, { error: "could_not_create_account" });
      }

      const tokenRes = await mtFetch("/token", {
        method: "POST",
        body: JSON.stringify({
          address: account.address,
          password,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        return json(tokenRes.status, {
          error: "token_failed",
          bodySample: text.slice(0, 500),
        });
      }

      const tokenData = await tokenRes.json();

      return json(200, {
        address: account.address,
        inboxId: account.id,
        token: tokenData.token,
        expiresAt: Date.now() + 10 * 60 * 1000,
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
        const text = await res.text();
        return json(res.status, {
          error: "messages_failed",
          bodySample: text.slice(0, 500),
        });
      }

      const data = await res.json();
      const messages = data["hydra:member"] || data.member || [];

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
        const text = await res.text();
        return json(res.status, {
          error: "message_failed",
          bodySample: text.slice(0, 500),
        });
      }

      const msg = await res.json();

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

    return json(400, { error: "unknown_action", action });
  } catch (err) {
    return json(500, {
      error: "server_error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
