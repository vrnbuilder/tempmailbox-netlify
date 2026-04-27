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

async function mailslurpFetch(url, options = {}) {
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
      return json(200, {
        ok: true,
        service: "TempMailBox relay",
        ts: Date.now(),
      });
    }

    if (action === "newInbox") {
      const res = await mailslurpFetch(`${MAILSLURP_BASE}/inboxes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          name: "TempMailBox",
          description: "Temporary inbox created by TempMailBox",
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
      const address = data.emailAddress;
      const inboxId = data.id;

      if (!address || !inboxId) {
        return json(500, {
          error: "bad_inbox_response",
          bodySample: JSON.stringify(data).slice(0, 500),
        });
      }

      const [login, domain] = String(address).split("@");
      const expiresAt = Date.now() + 10 * 60 * 1000;

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

      // Step 1: ask MailSlurp to wait briefly for latest email.
      // If no email arrives, this may timeout/fail — that is OK.
      try {
        const waitUrl = new URL(`${MAILSLURP_BASE}/waitForLatestEmail`);
        waitUrl.searchParams.set("inboxId", inboxId);
        waitUrl.searchParams.set("timeout", "8000");
        waitUrl.searchParams.set("unreadOnly", "false");

        await mailslurpFetch(waitUrl.toString());
      } catch (err) {
        // Ignore wait errors. We still fetch the inbox list below.
      }

      // Step 2: fetch the current email list.
      const listUrl = new URL(`${MAILSLURP_BASE}/emails`);
      listUrl.searchParams.set("inboxId", inboxId);
      listUrl.searchParams.set("size", "50");
      listUrl.searchParams.set("sort", "DESC");

      const res = await mailslurpFetch(listUrl.toString());

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "list_emails_failed",
          status: res.status,
          bodySample: text.slice(0, 500),
        });
      }

      const emails = await res.json();

      const mapped = Array.isArray(emails)
        ? emails.map((e) => ({
            id: e.id,
            from: e.from || "",
            subject: e.subject || "(no subject)",
            createdAt: e.createdAt || e.created || "",
            read: Boolean(e.read),
            hasAttachments:
              Array.isArray(e.attachments) && e.attachments.length > 0,
            attachmentIds: e.attachments || [],
          }))
        : [];

      return json(200, mapped);
    }

    if (action === "readMessage") {
      const id = params.id;

      if (!id) {
        return json(400, { error: "missing_id" });
      }

      const res = await mailslurpFetch(`${MAILSLURP_BASE}/emails/${id}`);

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
        createdAt: email.createdAt || email.created || "",
        body: email.body || "",
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

      const res = await mailslurpFetch(
        `${MAILSLURP_BASE}/emails/${id}/attachments/${attachmentId}`
      );

      if (!res.ok) {
        const text = await res.text();
        return json(res.status, {
          error: "download_failed",
          status: res.status,
          bodySample: text.slice(0, 500),
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
