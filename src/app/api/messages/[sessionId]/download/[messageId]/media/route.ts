import { resolveSession } from "@/lib/security/session-access";
import { parseMediaFilename } from "@/lib/security/identifiers";
import { readPrivateMedia } from "@/lib/security/media-store";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

// GET: Download media from message
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; messageId: string }> }
) {
    const { sessionId, messageId } = await params;
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        // Check if user can access this session
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        // Find message in database
        const message = await prisma.message.findUnique({
            where: { id: messageId },
        });

        if (!message) {
            return NextResponse.json({ status: false, message: "Message not found", error: "Message not found" }, { status: 404 });
        }

        const session = await resolveSession(sessionId);
        if (!session || message.sessionId !== session.id) {
            return NextResponse.json({ status: false, message: "Message does not belong to this session", error: "Message does not belong to this session" }, { status: 403 });
        }

        if (!message.mediaUrl) {
            return NextResponse.json({ status: false, message: "Message has no media", error: "Message has no media" }, { status: 404 });
        }

        // Stored URLs are API references, never arbitrary local paths or external redirects.
        const prefix = '/api/media/';
        if (!message.mediaUrl.startsWith(prefix)) return NextResponse.json({ status: false, message: 'Invalid media reference' }, { status: 400 });
        const fileName = decodeURIComponent(message.mediaUrl.slice(prefix.length));
        const parsed = parseMediaFilename(fileName);
        if (!parsed || parsed.sessionId !== `media_${session.id}`) return NextResponse.json({ status: false, message: 'Forbidden media reference' }, { status: 403 });
        const fileBuffer = await readPrivateMedia(fileName);
        const mimeType = message.type === 'IMAGE' ? 'image/jpeg' 
            : message.type === 'VIDEO' ? 'video/mp4'
            : message.type === 'AUDIO' ? 'audio/mpeg'
            : message.type === 'DOCUMENT' ? 'application/pdf'
            : 'application/octet-stream';

        // Extract filename from path


        return new NextResponse(new Uint8Array(fileBuffer), {
            headers: {
                'Content-Type': mimeType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        });

    } catch (error) {
        console.error("Download media error:", error);
        return NextResponse.json({ status: false, message: "Failed to download media", error: "Failed to download media" }, { status: 500 });
    }
}
