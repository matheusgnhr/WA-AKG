import { canAccessSession,getAuthenticatedUser } from "@/lib/api-auth";
import { errorMessage as getErrorMessage } from "@/lib/error-message";
import { waManager } from "@/modules/whatsapp/manager";
import { NextRequest,NextResponse } from "next/server";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const { sessionId } = await params;
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden" }, { status: 403 });
        }

        const instance = waManager.getInstance(sessionId);
        if (!instance || !instance.socket) {
            return NextResponse.json({ status: false, message: "WhatsApp instance not connected" }, { status: 503 });
        }

        // Fetch display name from creds
        const pushname = instance.socket.user?.name || "";
        const myJid = instance.socket.user?.id || "";

        // Fetch status/about safely
        let status = "Hey there! I am using WhatsApp.";
        try {
            const statusResult = await (instance.socket).fetchStatus(myJid);
            const first = statusResult?.[0];
            if (typeof first?.status === 'string') status = first.status;
        } catch (e) {
            console.log("Could not fetch own status:", e);
        }

        // Fetch profile picture safely
        let pictureUrl = "";
        try {
            pictureUrl = await instance.socket.profilePictureUrl(myJid, 'image') || "";
        } catch  {
            // No profile picture set
        }

        return NextResponse.json({
            status: true,
            data: {
                name: pushname,
                pushname: pushname,
                status: status,
                pictureUrl: pictureUrl
            }
        });

    } catch (error) {
        console.error("Fetch profile error:", error);
        return NextResponse.json({ status: false, message: getErrorMessage(error) }, { status: 500 });
    }
}
