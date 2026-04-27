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
    const action = params.action;

    if (!MAILSLURP_API_KEY) {
      return json(500, { error: "missing_api_key" });
    }

    // ---------------- NEW INBOX ----------------
    if (action === "newInbox") {
      const res = await msFetch(`${MAILSLURP_BASE}/inboxes`, {
        method: "POST",
      });

      const data = await res.json();

      return json(200, {
        address: data.emailAddress,
        inboxId: data.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    }

    // ---------------- GET MESSAGES (FIXED) ----------------
    if (action === "getMessages") {
      const inboxId = params.inboxId;
      if (!inboxId) {
        return json(400, { error: "missing_inboxId" });
      }

      // Correct endpoint
      const res = await msFetch(
        `${MAILSLURP_BASE}/inboxes/${inboxId}/emails/paginated?page=0&size=20&sort=DESC`
      );

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "fetch_failed",
          body: text.slice(0, 300),
        });
      }

      const data = await res.json();

      const items = (data.content || []).map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        createdAt: e.createdAt,
      }));

      return json(200, items);
    }

    // ---------------- READ MESSAGE ----------------
    if (action === "readMessage") {
      const id = params.id;

      const res = await msFetch(`${MAILSLURP_BASE}/emails/${id}`);
      const email = await res.json();

      return json(200, {
        id: email.id,
        subject: email.subject,
        from: email.from,
        to: email.to,
        createdAt: email.createdAt,
        body: email.body,
        htmlBody: email.htmlBody,
      });
    }

    return json(400, { error: "unknown_action" });
  } catch (err) {
    return json(500, {
      error: "server_error",
      detail: err.message,
    });
  }
};
