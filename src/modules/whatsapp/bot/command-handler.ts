import { errorMessage as getErrorMessage } from "@/lib/error-message";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { downloadSafeMedia } from "@/lib/security/incoming-media";
import { safeFetch } from "@/lib/security/safe-fetch";
import Sticker from "@/lib/security/sticker";
import type { WAMessage,WASocket } from "@whiskeysockets/baileys";
import sharp from "sharp";


// Map to track start times for uptime
const startTimes = new Map<string, number>();

// Default bot config
// Default bot config
const DEFAULT_CONFIG = {
    enabled: true,
    botMode: 'OWNER',
    botAllowedJids: [] as string[], botBlockedJids: [] as string[],
    autoReplyMode: 'ALL',
    autoReplyAllowedJids: [] as string[],
    enableSticker: true,
    enableVideoSticker: true,
    maxStickerDuration: 10,
    enablePing: true,
    enableUptime: true,
    botName: "WA-AKG Bot",
    prefix: "#",
    removeBgApiKey: null as string | null
};

export function setSessionStartTime(sessionId: string) {
    if (!startTimes.has(sessionId)) {
        startTimes.set(sessionId, Date.now());
    }
}

export async function handleBotCommand(
    sock: WASocket | undefined,
    sessionId: string,
    msg: WAMessage
) {
    if (!sock || !msg.message || !msg.key.remoteJid) return;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe || false;

    // Get text content
    let text = "";
    const messageContent = msg.message;

    if (messageContent.conversation) {
        text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage?.text) {
        text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage?.caption) {
        text = messageContent.imageMessage.caption;
    } else if (messageContent.videoMessage?.caption) {
        text = messageContent.videoMessage.caption;
    }

    // Quick check: skip non-command messages early (common prefixes)
    // We'll do a proper prefix check after loading config
    if (!text || text.length === 0) return;

    // Fetch session first
    const session = await prisma.session.findUnique({
        where: { sessionId },
        select: { id: true }
    });

    if (!session) return;

    // Fetch BotConfig separately
    const botConfig = await (prisma).botConfig.findUnique({
        where: { sessionId: session.id }
    });

    const config = botConfig || DEFAULT_CONFIG;

    if (!config.enabled) return;

    // Now check prefix with loaded config
    const prefix = (config).prefix || "#";
    if (!text.startsWith(prefix)) return;

    // Verify Access Permissions
    const botMode = (config).botMode || 'OWNER'; // Default to OWNER if missing

    // Check Permission
    let canExecute = false;

    if (fromMe) {
        canExecute = true; // Owner always allowed
    } else {
        if (botMode === 'ALL') {
            canExecute = true;
        } else if (botMode === 'SPECIFIC') {
            const allowedJids = (config).botAllowedJids || [];
            // Standardized Sender Logic (matches webhook & store)
            const isGroup = msg.key.remoteJid?.endsWith("@g.us") || false;
            const remoteJidAlt = msg.key.remoteJidAlt;
            let senderJid = (isGroup ? (msg.key.participant || msg.participant) : msg.key.remoteJid) || "";

            if (!isGroup && remoteJidAlt) {
                senderJid = remoteJidAlt;
            }

            if (Array.isArray(allowedJids)) {
                canExecute = allowedJids.some(jid => typeof jid === "string" && senderJid.includes(jid));
            }
        } else if (botMode === 'BLACKLIST') {
            const blockedJids = (config).botBlockedJids || [];
            const isGroup = msg.key.remoteJid?.endsWith("@g.us") || false;
            const remoteJidAlt = msg.key.remoteJidAlt;
            let senderJid = (isGroup ? (msg.key.participant || msg.participant) : msg.key.remoteJid) || "";

            if (!isGroup && remoteJidAlt) {
                senderJid = remoteJidAlt;
            }

            // If blacklist, allowed by default UNLESS in blocked list
            canExecute = true;
            if (Array.isArray(blockedJids)) {
                const isBlocked = blockedJids.some(jid => typeof jid === "string" && senderJid.includes(jid));
                if (isBlocked) canExecute = false;
            }
        }
    }

    if (!canExecute) return;

    const [command, ...args] = text.trim().split(" ");
    const cmd = command.toLowerCase().slice(prefix.length); // remove prefix

    try {
        switch (cmd) {
            case "ping": {
                if (!config.enablePing) return;
                await sock.sendMessage(remoteJid, { text: "Pong! 🏓" }, { quoted: msg });
                break;
            }

            case "id": {
                await sock.sendMessage(remoteJid, {
                    text: `*Chat ID:* \`${remoteJid}\``
                }, { quoted: msg });
                break;
            }

            case "uptime": {
                if (!config.enableUptime) return;

                const start = startTimes.get(sessionId) || Date.now();
                const uptimeMs = Date.now() - start;
                const hours = Math.floor(uptimeMs / 3600000);
                const minutes = Math.floor((uptimeMs % 3600000) / 60000);
                const seconds = Math.floor((uptimeMs % 60000) / 1000);

                await sock.sendMessage(remoteJid, {
                    text: `*Session Uptime:* ${hours}h ${minutes}m ${seconds}s`
                }, { quoted: msg });
                break;
            }

            case "sticker":
            case "s":
            case "stiker": {
                if (!config.enableSticker) return;

                // Check if message has image or video
                let mediaMsg: WAMessage | null = msg;

                // If quoted, check quoted
                const quoted = messageContent.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted) {
                    mediaMsg = {
                        key: {
                            remoteJid,
                            id: messageContent.extendedTextMessage?.contextInfo?.stanzaId,
                        },
                        message: quoted
                    } as WAMessage;
                }

                const msgContent = mediaMsg.message;
                const isImage = !!msgContent?.imageMessage;
                const isVideo = !!msgContent?.videoMessage;

                if (!isImage && !isVideo) {
                    await sock.sendMessage(remoteJid, { text: "❌ Please reply to an image/video or send media with caption #sticker" }, { quoted: msg });
                    return;
                }

                if (msgContent?.extendedTextMessage) {
                    await sock.sendMessage(remoteJid, { text: "❌ Cannot convert text message to sticker." }, { quoted: msg });
                    return;
                }

                // Handle Video Limits
                if (isVideo) {
                    if (!(config).enableVideoSticker) {
                        await sock.sendMessage(remoteJid, { text: "❌ Video stickers are disabled in bot settings." }, { quoted: msg });
                        return;
                    }

                    const seconds = msgContent?.videoMessage?.seconds || 0;
                    const maxDuration = (config).maxStickerDuration || 10;

                    if (seconds > maxDuration) {
                        await sock.sendMessage(remoteJid, { text: `❌ Video too long! Max duration is ${maxDuration} seconds.` }, { quoted: msg });
                        return;
                    }
                }

                await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });

                try {
                    // Download
                    let buffer = await downloadSafeMedia(mediaMsg);

                    // Resize/Compress Logic
                    if (isImage) {
                        try {
                            // Use limitInputPixels: 16_000_000 to handle large images
                            buffer = await sharp(buffer, { limitInputPixels: 16_000_000 })
                                .resize(512, 512, { // Resize to standard 512x512 sticker size directly
                                    fit: 'inside',
                                    withoutEnlargement: true
                                })
                                .toBuffer();
                        } catch (resizeErr) {
                            logger.error("Bot", "Image Resize failed", resizeErr);
                        }
                    }

                    // Check for background removal (Only for Images)
                    const isRemoveBg = args.includes("nobg") || args.includes("removebg");
                    if (isImage && isRemoveBg && config.removeBgApiKey) {
                        try {
                            // Convert Buffer to Uint8Array for Blob compatibility
                            const uint8Array = new Uint8Array(buffer);
                            const blob = new Blob([uint8Array], { type: 'image/png' });

                            const formData = new FormData();
                            formData.append('image_file', blob, 'image.png');
                            formData.append('size', 'auto');

                            const res = await safeFetch('https://api.remove.bg/v1.0/removebg', {
                                method: 'POST',
                                headers: {
                                    'X-Api-Key': config.removeBgApiKey
                                },
                                body: formData
                            });

                            if (res.ok) {
                                const arrayBuffer = await res.arrayBuffer();
                                buffer = Buffer.from(arrayBuffer);
                            } else {
                                const err = await res.json();
                                throw new Error(`RemoveBG Error: ${(err).errors?.[0]?.title || res.statusText}`);
                            }
                        } catch (bgError) {
                            logger.error("Bot", "RemoveBG Failed:", bgError);
                            await sock.sendMessage(remoteJid, { text: `⚠️ Remove BG failed: ${getErrorMessage(bgError)}. Sending normal sticker...` }, { quoted: msg });
                        }
                    } else if (isImage && isRemoveBg && !config.removeBgApiKey) {
                        await sock.sendMessage(remoteJid, { text: `⚠️ Remove BG API Key not configured in dashboard. Sending normal sticker...` }, { quoted: msg });
                    }


                    // Convert
                    const sticker = new Sticker(buffer as Buffer, {
                        pack: (config).botName || "WA-AKG Bot",
                        author: "By " + ((config).botName || "WA-AKG Bot"),
                        type: "full", // full, crop, circle
                        quality: 15 // Extreme quality reduction for size
                    });

                    const stickerBuffer = await sticker.toBuffer();

                    // Send
                    await sock.sendMessage(remoteJid, { sticker: stickerBuffer }, { quoted: msg });
                    await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });

                } catch (e) {
                    logger.error("Bot", "Sticker generation failed", e);
                    await sock.sendMessage(remoteJid, { text: "❌ Failed to create sticker. Error: " + getErrorMessage(e) }, { quoted: msg });
                }
                break;
            }

            case "menu":
            case "help": {
                const botName = (config).botName || "WA-AKG Bot";
                const menu = `
🤖 *${botName} Menu* 🤖

📌 *Commands:*
• *${prefix}sticker* / *${prefix}s*: Convert Image/Video to Sticker
  - Supports Images, GIFs, and Videos (max ${(config).maxStickerDuration || 10}s)
  - Use *${prefix}sticker nobg* to remove background (Images only)
• *${prefix}ping*: Check Bot Status
• *${prefix}uptime*: Check Session Uptime
• *${prefix}id*: Get Chat ID

_Made with ❤️_
`;
                await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
                break;
            }

            default:
                // Ignore unknown commands
                break;
        }
    } catch (e) {
        logger.error("Bot", "Bot command error", e);
    }
}
