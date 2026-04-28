// netlify/functions/relay.js

const MAILSLURP_API_KEY = process.env.MAILSLURP_API_KEY;
const MAILSLURP_BASE = "https://api.mailslurp.com";

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

async function msFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "x-api-key": MAILSLURP_API_KEY,
      ...(options.headers || {}),
    },
  });
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const action = params.action || "health";

    if (!MAILSLURP_API_KEY && action !== "health") {
      return json(500, { error: "missing_api_key" });
    }

    if (action === "health") {
      return json(200, { ok: true, service: "TempMailBox relay", ts: Date.now() });
    }

    if (action === "newInbox") {
      const res = await msFetch(`${MAILSLURP_BASE}/inboxes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "TempMailBox",
          description: "Temporary inbox created by TempMailBox",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),

          // Important: asks MailSlurp for shorter generated address
          useShortAddress: true,

          // Helps avoid the default ugly/blocked domain pool when available
          useDomainPool: true,

          inboxType: "HTTP",
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "create_inbox_failed",
          status: res.status,
          bodySample: text.slice(0, 500),
        });
      }

      const data = await res.json();

      if (!data.emailAddress || !data.id) {
        return json(500, {
          error: "bad_inbox_response",
          bodySample: JSON.stringify(data).slice(0, 500),
        });
      }

      return json(200, {
        address: data.emailAddress,
        inboxId: data.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    }

    if (action === "getMessages") {
      const inboxId = params.inboxId;

      if (!inboxId) {
        return json(400, { error: "missing_inboxId" });
      }

      const res = await msFetch(
        `${MAILSLURP_BASE}/inboxes/${inboxId}/emails/paginated?page=0&size=20&sort=DESC`
      );

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "fetch_failed",
          status: res.status,
          bodySample: text.slice(0, 500),
        });
      }

      const data = await res.json();

      const items = (data.content || []).map((e) => ({
        id: e.id,
        from: e.from || "",
        subject: e.subject || "(no subject)",
        createdAt: e.createdAt || "",
      }));

      return json(200, items);
    }

    if (action === "readMessage") {
      const id = params.id;

      if (!id) {
        return json(400, { error: "missing_id" });
      }

      const res = await msFetch(`${MAILSLURP_BASE}/emails/${id}`);

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "get_email_failed",
          status: res.status,
          bodySample: text.slice(0, 500),
        });
      }

      const email = await res.json();

      return json(200, {
        id: email.id,
        subject: email.subject || "(no subject)",
        from: email.from || "",
        to: Array.isArray(email.to) ? email.to.join(", ") : email.to || "",
        createdAt: email.createdAt || "",
        body: email.body || "",
        htmlBody: email.htmlBody || null,
        attachmentIds: email.attachments || [],
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
