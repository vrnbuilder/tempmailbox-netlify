// netlify/functions/relay.js
// MailSlurp-based backend for TempMailBox

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

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const action = params.action || "health";

    if (!MAILSLURP_API_KEY && action !== "health") {
      return json(500, { error: "missing_api_key" });
    }

    if (action === "health") {
      return json(200, { ok: true, ts: Date.now() });
    }

    if (action === "newInbox") {
      // Create a new disposable inbox
      const res = await fetch(`${MAILSLURP_BASE}/inboxes`, {
        method: "POST",
        headers: {
          "x-api-key": MAILSLURP_API_KEY,
          "content-type": "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "create_inbox_failed",
          status: res.status,
          bodySample: text.slice(0, 400),
        });
      }

      const data = await res.json();
      const address = data.emailAddress;
      const inboxId = data.id;

      const [login, domain] = String(address).split("@");
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

      return json(200, {
        address,
        login,
        domain,
        inboxId,
        expiresAt,
      });
    }

    if (action === "getMessages") {
      const inboxId = params.inboxId;
      if (!inboxId) {
        return json(400, { error: "missing_inboxId" });
      }

      const url = new URL(`${MAILSLURP_BASE}/emails`);
      url.searchParams.set("inboxId", inboxId);
      url.searchParams.set("size", "50");
      url.searchParams.set("sort", "DESC");

      const res = await fetch(url.toString(), {
        headers: {
          "x-api-key": MAILSLURP_API_KEY,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "list_emails_failed",
          status: res.status,
          bodySample: text.slice(0, 400),
        });
      }

      const emails = await res.json();

      const mapped = emails.map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        createdAt: e.createdAt,
        read: e.read,
        hasAttachments: Array.isArray(e.attachments) && e.attachments.length > 0,
        attachmentIds: e.attachments || [],
      }));

      return json(200, mapped);
    }

    if (action === "readMessage") {
      const id = params.id;
      if (!id) {
        return json(400, { error: "missing_id" });
      }

      const res = await fetch(`${MAILSLURP_BASE}/emails/${id}`, {
        headers: { "x-api-key": MAILSLURP_API_KEY },
      });

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "get_email_failed",
          status: res.status,
          bodySample: text.slice(0, 400),
        });
      }

      const email = await res.json();

      return json(200, {
        id: email.id,
        subject: email.subject,
        from: email.from,
        to: email.to,
        createdAt: email.createdAt,
        body: email.body,
        htmlBody: email.htmlBody || null,
        attachmentIds: email.attachments || [],
      });
    }

    if (action === "download") {
      const id = params.id;
      const attachmentId = params.attachmentId;
      const fileName = params.file || "attachment.bin";

      if (!id || !attachmentId) {
        return json(400, { error: "missing_id_or_attachmentId" });
      }

      const res = await fetch(
        `${MAILSLURP_BASE}/emails/${id}/attachments/${attachmentId}`,
        {
          headers: { "x-api-key": MAILSLURP_API_KEY },
        }
      );

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "download_failed",
          status: res.status,
          bodySample: text.slice(0, 400),
        });
      }

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      return {
        statusCode: 200,
        headers: {
          "content-type":
            res.headers.get("content-type") || "application/octet-stream",
          "content-disposition": `attachment; filename="${fileName}"`,
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
        body: buf.toString("base64"),
        isBase64Encoded: true,
      };
    }

    // Unknown action
    return json(400, { error: "unknown_action", action });
  } catch (err) {
    return json(500, {
      error: "server_error",
      detail: String(err && err.message ? err.message : err),
    });
  }
};
