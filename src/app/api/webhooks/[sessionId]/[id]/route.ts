import { canAccessDatabaseSession } from "@/lib/security/session-access";
import { validateSafeUrl } from "@/lib/security/safe-fetch";
import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, resolveSession } from "@/lib/api-auth";

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; id: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }
    
    const { sessionId, id } = await params;

    const session = await resolveSession(sessionId);
    const hasAccess = !!session && await canAccessDatabaseSession(user.id, user.role, session.id);
    if (!hasAccess) {
        return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
    }

    try {
        const body = await request.json();
        const { name, url, secret, events, isActive } = body;
        try { if (url !== undefined) validateSafeUrl(url, true); } catch { return NextResponse.json({ status: false, message: "Unsafe webhook URL" }, { status: 400 }); }
        if (secret !== undefined && (typeof secret !== "string" || secret.length < 32)) return NextResponse.json({ status: false, message: "Webhook secret must have at least 32 characters" }, { status: 400 });

        if (!session) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        // Verify ownership and session context
        const existing = await prisma.webhook.findFirst({
            where: {
                id,
                OR: [
                    { sessionId: session.id },
                    { sessionId: null, userId: user.id }
                ]
            }
        });

        if (!existing) {
            return NextResponse.json({ status: false, message: "Webhook not found", error: "Webhook not found" }, { status: 404 });
        }

        const effectiveSecret = secret === undefined ? existing.secret : secret;
        if ((isActive ?? existing.isActive) && (typeof effectiveSecret !== 'string' || effectiveSecret.length < 32)) {
            return NextResponse.json({ status: false, message: "Active webhooks require a secret of at least 32 characters" }, { status: 400 });
        }

        const webhook = await prisma.webhook.update({
            where: { id },
            data: {
                ...(name !== undefined && { name }),
                ...(url !== undefined && { url }),
                ...(secret !== undefined && { secret }),
                ...(events !== undefined && { events }),
                ...(isActive !== undefined && { isActive })
            }
        });

        return NextResponse.json(webhook);
    } catch (error) {
        console.error("Update webhook error:", error);
        return NextResponse.json({ status: false, message: "Failed to update webhook", error: "Failed to update webhook" }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; id: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }
    
    const { sessionId, id } = await params;

    const session = await resolveSession(sessionId);
    const hasAccess = !!session && await canAccessDatabaseSession(user.id, user.role, session.id);
    if (!hasAccess) {
        return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
    }

    try {

        if (!session) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        const existing = await prisma.webhook.findFirst({
            where: {
                id,
                OR: [
                    { sessionId: session.id },
                    { sessionId: null, userId: user.id }
                ]
            }
        });

        if (!existing) {
            return NextResponse.json({ status: false, message: "Webhook not found", error: "Webhook not found" }, { status: 404 });
        }

        await prisma.webhook.delete({ where: { id } });

        return NextResponse.json({ status: true, message: "Operation successful" });
    } catch (error) {
        console.error("Delete webhook error:", error);
        return NextResponse.json({ status: false, message: "Failed to delete webhook", error: "Failed to delete webhook" }, { status: 500 });
    }
}
