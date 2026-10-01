import { canAccessSession,getAuthenticatedUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { antispam } from "@/modules/whatsapp/antispam";
import { antiSpamDefaults, validAntiSpamConfig } from "@/modules/whatsapp/antispam-config";
import { NextRequest,NextResponse } from "next/server";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params;

    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const session = await (prisma).session.findUnique({
            where: { sessionId },
            select: { id: true, botConfig: true }
        });

        if (!session) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        // Return config or default if null
        const botConfig = session.botConfig || {
            enabled: true,
            botMode: 'OWNER',
            botAllowedJids: [],
            botBlockedJids: [],
            autoReplyMode: 'ALL',
            autoReplyAllowedJids: [],
            autoReplyBlockedJids: [],
            enableSticker: true,
            enablePing: true,
            enableUptime: true,
            botName: "WA-AKG Bot",
            removeBgApiKey: null,
            enableVideoSticker: true,
            maxStickerDuration: 10,
            prefix: "#",
            antiSpamEnabled: false,
            spamLimit: 5,
            spamInterval: 10,
            spamDelayMin: 1000,
            spamDelayMax: 3000,
            welcomeMessage: null,
            autoRead: false,
            alwaysOnline: false
        };

        return NextResponse.json({ status: true, message: "Bot config fetched successfully", data: botConfig });
    } catch (error) {
        console.error("Get Bot Config Error:", error);
        return NextResponse.json({ status: false, message: "Internal Server Error", error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params;

    try {
        const user = await getAuthenticatedUser(request);
        if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });

        const body = await request.json();

        const config = await prisma.$transaction(async db => {
        // Find session DB ID
        await db.$queryRaw`SELECT id FROM Session WHERE sessionId = ${sessionId} FOR UPDATE`;
        const session = await db.session.findUnique({
            where: { sessionId },
            select: { id: true, botConfig: true }
        });

        if (!session) return null;

        if (!body || typeof body !== 'object' || Array.isArray(body)
            || !validAntiSpamConfig({ ...antiSpamDefaults, ...session.botConfig, ...body })) {
            throw new Error('INVALID_ANTISPAM_CONFIG');
        }

        // Upsert Config
        return await db.botConfig.upsert({
            where: { sessionId: session.id },
            create: {
                sessionId: session.id,
                enabled: body.enabled ?? true,
                botMode: body.botMode || 'OWNER',
                botAllowedJids: body.botAllowedJids || [],
                botBlockedJids: body.botBlockedJids || [],
                autoReplyMode: body.autoReplyMode || 'ALL',
                autoReplyAllowedJids: body.autoReplyAllowedJids || [],
                autoReplyBlockedJids: body.autoReplyBlockedJids || [],

                enableSticker: body.enableSticker ?? true,
                enableVideoSticker: body.enableVideoSticker ?? true,
                maxStickerDuration: body.maxStickerDuration || 10,
                enablePing: body.enablePing ?? true,
                enableUptime: body.enableUptime ?? true,
                removeBgApiKey: body.removeBgApiKey || null,
                prefix: body.prefix || "#",
                antiSpamEnabled: body.antiSpamEnabled ?? false,
                spamLimit: body.spamLimit ?? 5,
                spamInterval: body.spamInterval ?? 10,
                spamDelayMin: body.spamDelayMin ?? 1000,
                spamDelayMax: body.spamDelayMax ?? 3000,
                welcomeMessage: body.welcomeMessage || null,
                autoRead: body.autoRead ?? false,
                alwaysOnline: body.alwaysOnline ?? false,
            },
            update: {
                botMode: body.botMode,
                botAllowedJids: body.botAllowedJids,
                botBlockedJids: body.botBlockedJids,
                autoReplyMode: body.autoReplyMode,
                autoReplyAllowedJids: body.autoReplyAllowedJids,
                autoReplyBlockedJids: body.autoReplyBlockedJids,
                botName: body.botName,
                enableSticker: body.enableSticker,
                enableVideoSticker: body.enableVideoSticker,
                maxStickerDuration: body.maxStickerDuration,
                enablePing: body.enablePing,
                enableUptime: body.enableUptime,
                removeBgApiKey: body.removeBgApiKey || null,
                prefix: body.prefix,
                antiSpamEnabled: body.antiSpamEnabled,
                spamLimit: body.spamLimit,
                spamInterval: body.spamInterval,
                spamDelayMin: body.spamDelayMin,
                spamDelayMax: body.spamDelayMax,
                welcomeMessage: body.welcomeMessage,
                autoRead: body.autoRead,
                alwaysOnline: body.alwaysOnline,
            }
        });

        });
        if (!config) return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });

        antispam.clearCache(sessionId);

        return NextResponse.json({ status: true, message: "Bot config updated successfully", data: config });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_ANTISPAM_CONFIG') {
            return NextResponse.json({ status: false, message: "Invalid anti-spam limits or delay bounds", error: "Invalid configuration" }, { status: 400 });
        }
        console.error("Update Bot Config Error:", error);
        return NextResponse.json({ status: false, message: "Failed to update config", error: "Failed to update config" }, { status: 500 });
    }
}
