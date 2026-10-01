import { canAccessSession,getAuthenticatedUser } from "@/lib/api-auth";
import { errorMessage as getErrorMessage } from "@/lib/error-message";
import { waManager } from "@/modules/whatsapp/manager";
import { NextRequest,NextResponse } from "next/server";

// GET: Fetch group invite code
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; jid: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, jid } = await params;
        const decodedJid = decodeURIComponent(jid);

        // Check verification
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const instance = waManager.getInstance(sessionId);
        if (!instance?.socket) {
            return NextResponse.json({ status: false, message: "Session not ready", error: "Session not ready" }, { status: 503 });
        }

        // Get invite code
        const inviteCode = await instance.socket.groupInviteCode(decodedJid);

        return NextResponse.json({
            success: true,
            inviteCode,
            inviteUrl: `https://chat.whatsapp.com/${inviteCode}`
        });

    } catch (error) {
        console.error("Fetch invite code error:", error);

        if (getErrorMessage(error)?.includes("not-admin") || getErrorMessage(error)?.includes("forbidden")) {
            return NextResponse.json({ status: false, message: "Bot must be admin to fetch invite code", error: "Bot must be admin to fetch invite code" }, { status: 403 });
        }

        return NextResponse.json({ status: false, message: "Failed to fetch invite code", error: "Failed to fetch invite code" }, { status: 500 });
    }
}

// PUT: Revoke group invite code
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; jid: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, jid } = await params;
        const decodedJid = decodeURIComponent(jid);

        // Check verification
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const instance = waManager.getInstance(sessionId);
        if (!instance?.socket) {
            return NextResponse.json({ status: false, message: "Session not ready", error: "Session not ready" }, { status: 503 });
        }

        // Revoke invite code
        const newInviteCode = await instance.socket.groupRevokeInvite(decodedJid);

        return NextResponse.json({
            success: true,
            message: "Invite code revoked successfully",
            newInviteCode,
            inviteUrl: `https://chat.whatsapp.com/${newInviteCode}`
        });

    } catch (error) {
        console.error("Revoke invite code error:", error);

        if (getErrorMessage(error)?.includes("not-admin") || getErrorMessage(error)?.includes("forbidden")) {
            return NextResponse.json({ status: false, message: "Bot must be admin to revoke invite code", error: "Bot must be admin to revoke invite code" }, { status: 403 });
        }

        return NextResponse.json({ status: false, message: "Failed to revoke invite code", error: "Failed to revoke invite code" }, { status: 500 });
    }
}
