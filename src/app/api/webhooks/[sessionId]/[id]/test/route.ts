import { canAccessDatabaseSession } from "@/lib/security/session-access";
import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, resolveSession } from "@/lib/api-auth";
import { testWebhook } from "@/lib/webhook";

export async function POST(
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

    // Resolve session by either CUID or WhatsApp sessionId

    if (!session) {
        return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
    }

    // Verify webhook access
    const webhook = await prisma.webhook.findFirst({
        where: {
            id,
            OR: [
                { sessionId: session.id },
                { sessionId: null, userId: user.id }
            ]
        }
    });

    if (!webhook) {
        return NextResponse.json({ status: false, message: "Webhook not found", error: "Webhook not found" }, { status: 404 });
    }

    const result = await testWebhook(webhook.id, webhook.url, webhook.secret);

    return NextResponse.json({
        status: true,
        message: result.success ? "Webhook test successful" : "Webhook test failed",
        data: result
    });
}
