import { errorMessage as getErrorMessage } from "@/lib/error-message";
import { jsonValue } from "@/lib/json-value";
import { waManager } from "@/modules/whatsapp/manager";
import type { Prisma } from "@prisma/client";
import type { proto } from "@whiskeysockets/baileys";
import { normalizeMessageContent,WAMessage } from "@whiskeysockets/baileys";
import { resolveToPhoneJidBySessionId as resolveToPhoneJid } from "./jid-utils";
import { logger } from "./logger";
import { prisma } from "./prisma";
import { mediaFilename } from "./security/identifiers";
import { downloadSafeMedia } from "./security/incoming-media";
import { writePrivateMedia } from "./security/media-store";
import { safeFetch } from "./security/safe-fetch";
import { signWebhook } from "./security/webhook-signature";
import { deliverWebhookJobs,enqueueWebhookDelivery } from "./webhook-delivery";

// Event types that can trigger webhooks
export type WebhookEventType =
    | "message.received"
    | "message.sent"
    | "message.status"
    | "connection.update"
    | "group.update"
    | "contact.update"
    | "status.update"
    | "group.participant"
    | "message.deleted"
    | "message.edited"
    | "test";

export interface WebhookPayload {
    event: WebhookEventType;
    sessionId: string;
    timestamp: string;
    data: unknown;
}

/**
 * Dispatch webhook to all matching endpoints
 */
export async function dispatchWebhook(
    sessionId: string,
    event: WebhookEventType,
    data: unknown
) {
    try {
        // Get the session to find the userId
        const session = await prisma.session.findUnique({
            where: { sessionId },
            select: { id: true, userId: true }
        });

        if (!session) {
            logger.warn("Webhook", `Dispatch: Session ${sessionId} not found`);
            return;
        }

        // Find all active webhooks for this user/session, shared access, and superadmins
        const accesses = await prisma.sessionAccess.findMany({
            where: { sessionId: session.id },
            select: { userId: true }
        });

        const superadmins = await prisma.user.findMany({
            where: { role: 'SUPERADMIN', disabled: false },
            select: { id: true }
        });

        const userIds = [
            session.userId,
            ...accesses.map(a => a.userId),
            ...superadmins.map(s => s.id)
        ];

        const webhooks = await prisma.webhook.findMany({
            where: {
                isActive: true,
                OR: [
                    { sessionId: null, userId: { in: userIds } }, // Global webhooks
                    { sessionId: session.id, userId: { in: userIds } } // Sharing revocation also revokes event delivery
                ]
            }
        });

        if (webhooks.length === 0) return;

        const payload: WebhookPayload = {
            event,
            sessionId,
            timestamp: new Date().toISOString(),
            data: normalizePayloadData(event, data) // Normalize data before sending
        };

        // Dispatch to all matching webhooks
        for (const webhook of webhooks) {
            // Check if this webhook subscribes to this event
            const events = (webhook.events as string[]) || [];
            if (!events.includes(event) && !events.includes("*")) {
                continue;
            }

            await enqueueWebhookDelivery(webhook.id, payload);
        }
        deliverWebhookJobs().catch(() => logger.error("Webhook", "Immediate delivery failed; worker will retry"));
    } catch (error) {
        logger.error("Webhook", "Dispatch error:", error);
    }
}

/**
 * Normalize payload data to match API format and avoid Circular/BigInt errors
 */
function normalizePayloadData(_event: WebhookEventType, data: unknown): unknown { return data; }

/**
 * JSON Replacer to handle BigInt
 */
function jsonReplacer(key: string, value: unknown) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

/**
 * Send HTTP POST request to webhook endpoint
 * Records delivery log to database
 */
export async function sendWebhookRequest(url: string, payload: WebhookPayload, secret?: string | null, webhookId?: string) {
    const startedAt = Date.now();
    const body = JSON.stringify(payload, jsonReplacer);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "WA-AKG-Webhook/1.0"
    };

    // Legacy unsigned webhooks also fail closed before making a network request.
    headers["X-Webhook-Signature"] = signWebhook(body, secret);

    let response: Response | undefined;
    let responseBody: string | undefined;
    let errorMessage: string | undefined;

    try {
        response = await safeFetch(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10000)
        }, true);

        responseBody = await response.text().catch(() => undefined);
        if (responseBody && responseBody.length > 1024) {
            responseBody = responseBody.substring(0, 1024);
        }

        if (!response.ok) {
            errorMessage = `Webhook returned ${response.status}: ${response.statusText}`;
        }
    } catch (err) {
        errorMessage = getErrorMessage(err) || "Webhook request failed";
        response = undefined;
    }

    // Calculate response time
    const responseTimeMs = Date.now() - startedAt;

    // Record delivery log
    if (webhookId) {
        recordWebhookLog({
            webhookId,
            event: payload.event,
            status: errorMessage ? "FAILED" : "SUCCESS",
            requestUrl: url,
            requestHeaders: headers,
            requestBody: JSON.parse(JSON.stringify(payload)),
            responseStatusCode: response?.status ?? null,
            responseBody: responseBody ?? null,
            responseTimeMs,
            errorMessage: errorMessage ?? null
        }).catch(err => logger.error("Webhook", "Failed to save webhook log:", err));
    }

    if (errorMessage) {
        throw new Error(errorMessage);
    }

    return response;
}

/**
 * Record a webhook delivery log entry
 */
async function recordWebhookLog(data: {
    webhookId: string;
    event: string;
    status: string;
    requestUrl: string;
    requestHeaders?: Prisma.InputJsonObject;
    requestBody?: Prisma.InputJsonValue;
    responseStatusCode?: number | null;
    responseBody?: string | null;
    responseTimeMs?: number | null;
    errorMessage?: string | null;
}) {
    await prisma.webhookLog.create({
        data: {
            webhookId: data.webhookId,
            event: data.event,
            status: data.status,
            requestUrl: data.requestUrl,
            requestHeaders: data.requestHeaders || undefined,
            requestBody: data.requestBody || undefined,
            responseStatusCode: data.responseStatusCode ?? null,
            responseBody: data.responseBody || null,
            responseTimeMs: data.responseTimeMs ?? null,
            errorMessage: data.errorMessage || null,
        }
    });

    cleanupOldLogs(data.webhookId).catch(err =>
        logger.error("Webhook", "Failed to cleanup old logs:", err)
    );
}

async function cleanupOldLogs(webhookId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.webhookLog.deleteMany({
        where: {
            webhookId,
            createdAt: { lt: thirtyDaysAgo }
        }
    });

    const logs = await prisma.webhookLog.findMany({
        where: { webhookId },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
    });

    if (logs.length > 500) {
        const idsToDelete = logs.slice(500).map(l => l.id);
        await prisma.webhookLog.deleteMany({
            where: { id: { in: idsToDelete } }
        });
    }
}

/**
 * Send a test webhook to verify endpoint works
 * Returns result without throwing
 */
export async function testWebhook(webhookId: string, url: string, secret?: string | null): Promise<{
    success: boolean;
    statusCode?: number;
    responseBody?: string;
    responseTimeMs: number;
    error?: string;
}> {
    const startedAt = Date.now();

    if (typeof secret !== 'string' || secret.length < 32) {
        return { success: false, responseTimeMs: Date.now() - startedAt, error: 'Webhook secret must have at least 32 characters' };
    }

    const testPayload: WebhookPayload = {
        event: "test",
        sessionId: "test",
        timestamp: new Date().toISOString(),
        data: {
            message: "This is a test webhook from WA-AKG",
            timestamp: new Date().toISOString()
        }
    };

    const body = JSON.stringify(testPayload, jsonReplacer);
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "WA-AKG-Webhook/1.0"
    };

    headers["X-Webhook-Signature"] = signWebhook(body, secret);

    try {
        const response = await safeFetch(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10000)
        }, true);

        const responseTimeMs = Date.now() - startedAt;
        let responseBody = await response.text().catch(() => undefined);
        if (responseBody && responseBody.length > 1024) {
            responseBody = responseBody.substring(0, 1024);
        }

        // Record test log
        await recordWebhookLog({
            webhookId,
            event: "test",
            status: response.ok ? "SUCCESS" : "FAILED",
            requestUrl: url,
            requestHeaders: headers,
            requestBody: jsonValue(testPayload),
            responseStatusCode: response.status,
            responseBody: responseBody || null,
            responseTimeMs,
            errorMessage: response.ok ? null : `Webhook returned ${response.status}: ${response.statusText}`
        });

        if (!response.ok) {
            return {
                success: false,
                statusCode: response.status,
                responseBody,
                responseTimeMs,
                error: `Returned ${response.status}: ${response.statusText}`
            };
        }

        return {
            success: true,
            statusCode: response.status,
            responseBody,
            responseTimeMs
        };
    } catch (err) {
        const responseTimeMs = Date.now() - startedAt;
        const errorMsg = getErrorMessage(err) || "Request failed";

        // Record failed test log
        await recordWebhookLog({
            webhookId,
            event: "test",
            status: "FAILED",
            requestUrl: url,
            requestHeaders: headers,
            requestBody: jsonValue(testPayload),
            responseStatusCode: null,
            responseBody: null,
            responseTimeMs,
            errorMessage: errorMsg
        });

        return {
            success: false,
            error: errorMsg,
            responseTimeMs
        };
    }
}

/**
 * Helper to download and save media
 */
export async function downloadAndSaveMedia(message: WAMessage, sessionId: string): Promise<string | null> {
    try {
        const messageContent = normalizeMessageContent(message.message);
        if (!messageContent) {
            logger.debug("Media", "No content normalized");
            return null;
        }

        const messageType = Object.keys(messageContent)[0];

        if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType)) {
            logger.debug("Media", `Message type ${messageType} is not a downloadable media.`);
            return null;
        }

        logger.info("Media", `Attempting to download ${messageType}...`);

        let buffer: Buffer | null = null;

        buffer = await downloadSafeMedia(message);

        if (!buffer) {
            logger.warn("Media", "Buffer is empty/null");
            return null;
        }

        logger.success("Media", `Downloaded ${buffer.length} bytes.`);

        const dbSession = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
        if (!dbSession) throw new Error('Unknown media session');
        const filename = mediaFilename(`media_${dbSession.id}`, message.key.id, messageType);
        await writePrivateMedia(filename, buffer);

        // Return URL path using API route for reliable serving
        const fileUrl = `/api/media/${filename}`;
        logger.success("Media", `Success. URL: ${fileUrl}`);
        return fileUrl;

    } catch (e) {
        logger.error("Media", "Failed to download media:", e);
        return null;
    }
}

/**
 * Get WA-AKG's own clean phone JID for a session
 * Strips device suffix (e.g. :47@s.whatsapp.net → @s.whatsapp.net)
 */
function getOwnJid(sessionId: string): string | null {
    try {
        const instance = waManager.getInstance(sessionId);
        const jid = instance?.socket?.user?.id || null;
        if (!jid) return null;
        // Strip device suffix (e.g. :47) — Baileys includes device ID in user.id
        return jid.replace(/:\d+(?=@)/g, '');
    } catch {
        return null;
    }
}

export async function onMessageReceived(sessionId: string, message: WAMessage, existingFileUrl?: string | null) {
    // Re-calculate fields to match store logic EXACTLY
    const remoteJid = message.key?.remoteJid || "";
    const fromMe = message.key?.fromMe || false;
    const isGroup = remoteJid.endsWith("@g.us");
    const participant = isGroup ? (message.key?.participant || message.participant) : undefined;

    // Extract Alt JID (e.g. Phone Number JID when remoteJid is LID)
    const remoteJidAlt = message.key?.remoteJidAlt || null;

    // --- Consistent JID Normalization ---
    // Always prefer @s.whatsapp.net format over @lid
    const normalizedFrom = await resolveToPhoneJid(remoteJid, sessionId, remoteJidAlt);

    // "sender" is who sent it. In DM: remoteJid. In Group: participant.
    const senderJid: string = isGroup ? (participant || "") : remoteJid;
    const normalizedSender = await resolveToPhoneJid(senderJid, sessionId);
    let sender = normalizedSender;

    // Enrich Participant Data if Group
    let participantDetail = await resolveToPhoneJid(participant || "", sessionId);

    if (isGroup && typeof sender === 'string') {
        try {
            const session = await prisma.session.findUnique({
                where: { sessionId },
                select: { id: true }
            });

            if (session) {
                const group = await prisma.group.findUnique({
                    where: {
                        sessionId_jid: {
                            sessionId: session.id,
                            jid: remoteJid
                        }
                    },
                    select: { participants: true }
                });

                if (group && group.participants) {
                    const parts = Array.isArray(group.participants) ? group.participants : [];
                    const found = parts.find(p => p && typeof p === "object" && !Array.isArray(p) && (p.id === senderJid || p.id === participant || p.id === normalizedSender));
                    if (found) {
                        sender = found as typeof sender;
                        participantDetail = found as typeof participantDetail;
                    }
                }
            }
        } catch (e) {
            logger.error("Store", "Failed to enrich participant", e);
        }
    }

    // Download media if available (or use existing)
    let fileUrl: string | null = existingFileUrl || null;
    if (!fileUrl) {
        try {
            fileUrl = await downloadAndSaveMedia(message, sessionId);
        } catch (e) {
            logger.error("Media", "Error handling media download", e);
        }
    }

    const normalized = extractMessageContent(message);
    const quoted = await extractQuotedMessageAsync(message, sessionId);

    dispatchWebhook(sessionId, "message.received", {
        key: {
            id: message.key?.id,
            remoteJid: normalizedFrom,
            fromMe: fromMe,
            participant: participantDetail
        },
        pushName: message.pushName,
        messageTimestamp: message.messageTimestamp == null ? undefined : Number(message.messageTimestamp),

        // Simplified Fields — always @s.whatsapp.net format
        from: normalizedFrom,       // Sender — who sent it (#O in DM), consistent: "from" = who sent it
        receiver: getOwnJid(sessionId), // WA-AKG's own number (#M)
        sender: sender,             // Who Sent It (normalized JID or enriched Object)
        isGroup: isGroup,           // Boolean
        chatType: getChatType(remoteJid), // PERSONAL | GROUP | STATUS | NEWSLETTER

        // Message Content
        type: normalized.type,
        content: normalized.content,
        fileUrl: fileUrl,
        caption: normalized.caption,
        quoted: quoted,

    });
}

/**
 * Helper to dispatch message sent event
 */
export async function onMessageSent(sessionId: string, message: WAMessage, existingFileUrl?: string | null) {
    const normalized = extractMessageContent(message);
    const quoted = await extractQuotedMessageAsync(message, sessionId);
    const remoteJid = message.key?.remoteJid || "";
    const isGroup = remoteJid.endsWith("@g.us");
    const remoteJidAlt = message.key?.remoteJidAlt || null;

    // Download media for sent messages too
    let fileUrl: string | null = existingFileUrl || null;
    if (!fileUrl) {
        try {
            fileUrl = await downloadAndSaveMedia(message, sessionId);
        } catch  { /* ignore */ }
    }

    // --- Consistent JID Normalization (same as onMessageReceived) ---
    const normalizedFrom = await resolveToPhoneJid(remoteJid, sessionId, remoteJidAlt);

    // For sent messages, sender is "ME" (self)
    // But we still normalize the participant JID if in a group
    const rawSender = message.key?.participant || (message.key?.fromMe ? "ME" : remoteJid);
    const sender = rawSender === "ME" ? "ME" : await resolveToPhoneJid(rawSender, sessionId);

    dispatchWebhook(sessionId, "message.sent", {
        key: {
            id: message.key?.id,
            remoteJid: normalizedFrom,
            fromMe: message.key?.fromMe || true,
            participant: isGroup ? sender : undefined
        },

        // Simplified Fields — always @s.whatsapp.net format
        from: getOwnJid(sessionId), // Sender — WA-AKG's own number (#M), consistent: "from" = who sent it
        receiver: normalizedFrom,   // Who the message was sent TO — other party (#O) in DM, group JID in group chat
        sender: sender,             // "ME" or normalized JID
        isGroup: isGroup,           // Boolean
        chatType: getChatType(remoteJid), // PERSONAL | GROUP | STATUS | NEWSLETTER

        type: normalized.type,
        content: normalized.content,
        fileUrl: fileUrl,
        caption: normalized.caption,
        quoted: quoted,

        timestamp: Date.now()
    });
}

/**
 * Helper to fire message.sent webhook after any sendMessage call
 * Constructs minimal WAMessage-like object from send result + payload info
 */
export async function fireSentWebhook(
    sessionId: string,
    jid: string,
    payload: { type?: string; text?: string; caption?: string; fileName?: string; mimetype?: string; ptt?: boolean },
    sendResult: WAMessage | proto.IMessageKey | undefined
) {
    try {
        // Handle WAMessage vs MessageKey — Baileys can return either
        const key = sendResult && "key" in sendResult ? sendResult.key : sendResult;
        const webhookMsg: WAMessage = {
            key: {
                id: key?.id,
                remoteJid: key?.remoteJid || jid,
                fromMe: true
            },
            message: { conversation: payload.text || payload.caption || "" },
            messageTimestamp: Math.floor(Date.now() / 1000)
        };

        if (payload.type === 'image') {
            webhookMsg.message = { imageMessage: { caption: payload.caption || "", mimetype: payload.mimetype || "image/jpeg" } };
        } else if (payload.type === 'video') {
            webhookMsg.message = { videoMessage: { caption: payload.caption || "", mimetype: payload.mimetype || "video/mp4" } };
        } else if (payload.type === 'audio' || payload.type === 'voice') {
            webhookMsg.message = { audioMessage: { mimetype: payload.mimetype || 'audio/mp4', ptt: payload.type === 'voice' } };
        } else if (payload.type === 'document') {
            webhookMsg.message = { documentMessage: { caption: payload.caption || "", fileName: payload.fileName || "document", mimetype: payload.mimetype || "application/octet-stream" } };
        } else if (payload.type === 'sticker') {
            webhookMsg.message = { stickerMessage: {} };
        }

        await onMessageSent(sessionId, webhookMsg);
    } catch  {
        // Non-blocking
    }
}

/**
 * Determine chat type from JID
 */
function getChatType(jid: string): "PERSONAL" | "GROUP" | "STATUS" | "NEWSLETTER" | "UNKNOWN" {
    if (!jid) return "UNKNOWN";
    if (jid.endsWith("@g.us")) return "GROUP";
    if (jid.endsWith("@s.whatsapp.net")) return "PERSONAL";
    if (jid.endsWith("@lid")) return "PERSONAL"; // LID is also a personal chat
    if (jid === "status@broadcast") return "STATUS";
    if (jid.endsWith("@newsletter")) return "NEWSLETTER";
    return "UNKNOWN";
}


/**
 * Helper to dispatch connection update event
 */
export function onConnectionUpdate(sessionId: string, status: string, qr?: string) {
    dispatchWebhook(sessionId, "connection.update", {
        status,
        qr: qr || null
    });
}

/**
 * Extract content and type from Baileys message
 */
function extractMessageContent(msg: Pick<WAMessage, "message">): { type: string, content: string, caption?: string } {
    const messageContent = normalizeMessageContent(msg.message);
    let text = "";
    let caption = undefined;
    let messageType = "TEXT";

    if (!messageContent) return { type: "UNKNOWN", content: "" };

    if (messageContent.conversation) {
        text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage?.text) {
        text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
        messageType = "IMAGE";
        caption = messageContent.imageMessage.caption || "";
        text = caption; // Content often used as text display
    } else if (messageContent.videoMessage) {
        messageType = "VIDEO";
        caption = messageContent.videoMessage.caption || "";
        text = caption;
    } else if (messageContent.audioMessage) {
        messageType = "AUDIO";
    } else if (messageContent.documentMessage) {
        messageType = "DOCUMENT";
        text = messageContent.documentMessage.fileName || "";
        caption = messageContent.documentMessage.caption || "";
    } else if (messageContent.stickerMessage) {
        messageType = "STICKER";
    } else if (messageContent.locationMessage) {
        messageType = "LOCATION";
        text = `${messageContent.locationMessage.degreesLatitude},${messageContent.locationMessage.degreesLongitude}`;
    } else if (messageContent.contactMessage) {
        messageType = "CONTACT";
        text = messageContent.contactMessage.displayName || "";
    }

    return { type: messageType, content: text, caption };
}



/**
 * Extract Quoted Message recursively (Async to Lookup DB)
 */
async function extractQuotedMessageAsync(msg: WAMessage, sessionId: string): Promise<unknown> {
    const messageContent = normalizeMessageContent(msg.message);
    if (!messageContent) return null;

    // Check for contextInfo in common message types
    let contextInfo = null;

    if (messageContent.extendedTextMessage) {
        contextInfo = messageContent.extendedTextMessage.contextInfo;
    } else if (messageContent.imageMessage) {
        contextInfo = messageContent.imageMessage.contextInfo;
    } else if (messageContent.videoMessage) {
        contextInfo = messageContent.videoMessage.contextInfo;
    } else if (messageContent.audioMessage) {
        contextInfo = messageContent.audioMessage.contextInfo;
    } else if (messageContent.stickerMessage) {
        contextInfo = messageContent.stickerMessage.contextInfo;
    } else if (messageContent.documentMessage) {
        contextInfo = messageContent.documentMessage.contextInfo;
    } else if (messageContent.contactMessage) {
        contextInfo = messageContent.contactMessage.contextInfo;
    } else if (messageContent.locationMessage) {
        contextInfo = messageContent.locationMessage.contextInfo;
    }

    if (contextInfo && contextInfo.quotedMessage) {
        const quotedMsg = contextInfo.quotedMessage;
        const normalized = extractMessageContent({ message: quotedMsg });

        let fileUrl = null;

        // Lookup Media URL in DB if possible
        if (contextInfo.stanzaId) {
            try {
                // We need the dbSessionId... this is tricky without fetching session again.
                // But we can try to look up by sessionId (baileys ID) and keyId
                // Message table has @@unique([sessionId, keyId]). BUT sessionId there is the CUID, not the string.

                // Fetch CUID First
                const session = await prisma.session.findUnique({
                    where: { sessionId },
                    select: { id: true }
                });

                if (session) {
                    const savedMsg = await prisma.message.findUnique({
                        where: {
                            sessionId_keyId: {
                                sessionId: session.id,
                                keyId: contextInfo.stanzaId
                            }
                        },
                        select: { mediaUrl: true }
                    });

                    if (savedMsg?.mediaUrl) {
                        fileUrl = savedMsg.mediaUrl;
                    }
                }
            } catch (e) {
                logger.error("Media", "Failed to lookup quoted media url", e);
            }
        }

        return {
            key: {
                remoteJid: contextInfo.remoteJid || null, // Group JID
                participant: contextInfo.participant || null, // Sender JID
                fromMe: contextInfo.participant === undefined, // Not reliable, better check participant
                id: contextInfo.stanzaId || null
            },
            type: normalized.type,
            content: normalized.content, // Text or Caption
            caption: normalized.caption,
            fileUrl: fileUrl, // <--- Added!
            // We don't download quoted media automatically unless it was already saved
            // raw: quotedMsg
        };
    }

    return null;
}
