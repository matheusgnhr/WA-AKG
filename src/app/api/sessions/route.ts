import { getAccessibleSessions,getAuthenticatedUser } from "@/lib/api-auth";
import { errorMessage as getErrorMessage } from "@/lib/error-message";
import { assertSessionId } from "@/lib/security/identifiers";
import { waManager } from "@/modules/whatsapp/manager";
import { Prisma } from "@prisma/client";
import { NextRequest,NextResponse } from "next/server";

export const dynamic = 'force-dynamic';

// GET: Fetch sessions (filtered by user role)
export async function GET(request: NextRequest) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        // Get sessions based on user role
        const sessions = await getAccessibleSessions(user.id, user.role);
        return NextResponse.json({ status: true, message: "Sessions retrieved successfully", data: sessions });
    } catch (error) {
        console.error("Get sessions error:", error);
        return NextResponse.json({ status: false, message: "Failed to fetch sessions", error: "Failed to fetch sessions" }, { status: 500 });
    }
}

// POST: Create new session (always for the authenticated user)
export async function POST(request: NextRequest) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { name, sessionId } = body;
        if (sessionId !== undefined) {
            try { assertSessionId(sessionId); } catch { return NextResponse.json({ status: false, message: "Invalid session identifier" }, { status: 400 }); }
        }

        if (!name) {
            return NextResponse.json({ status: false, message: "Session name is required", error: "Session name is required" }, { status: 400 });
        }

        // Create session for the authenticated user
        const session = await waManager.createSession(user.id, name, sessionId);
        return NextResponse.json({ status: true, message: "Session created successfully", data: session });
    } catch (error) {
        if ((error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && getErrorMessage(error) === 'Session identifier already in use')) return NextResponse.json({ status: false, message: 'Session identifier already in use' }, { status: 409 });
        console.error("Create session error:", error);
        return NextResponse.json({ status: false, message: "Failed to create session", error: "Failed to create session" }, { status: 500 });
    }
}
