import { getSocketServer } from "@/lib/security/realtime";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { generateApiKey, hashApiKey } from "@/lib/security/secrets";

// Get current user's API key
export async function GET() {
    const activeUser = await getAuthenticatedUser();
    if (!activeUser) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });

    try {
        const user = await prisma.user.findUnique({
            where: { id: activeUser.id },
            select: { apiKey: true }
        });

        return NextResponse.json({ status: true, message: "API key fetched", data: { apiKey: null, configured: !!user?.apiKey } });
    } catch (error) {
        return NextResponse.json({ status: false, message: "Failed to fetch API key", error: "Failed to fetch API key" }, { status: 500 });
    }
}

// Generate new API key
export async function POST() {
    const activeUser = await getAuthenticatedUser();
    if (!activeUser) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });

    try {
        const newApiKey = generateApiKey();

        await prisma.user.update({
            where: { id: activeUser.id },
            data: { apiKey: hashApiKey(newApiKey) }
        });

        getSocketServer()?.in(`user:${activeUser.id}`).disconnectSockets(true);
        return NextResponse.json({ status: true, message: "API key generated", data: { apiKey: newApiKey } });
    } catch (error) {
        console.error("Generate API key error:", error);
        return NextResponse.json({ status: false, message: "Failed to generate API key", error: "Failed to generate API key" }, { status: 500 });
    }
}

// Delete/revoke API key
export async function DELETE() {
    const activeUser = await getAuthenticatedUser();
    if (!activeUser) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });

    try {
        await prisma.user.update({
            where: { id: activeUser.id },
            data: { apiKey: null }
        });

        getSocketServer()?.in(`user:${activeUser.id}`).disconnectSockets(true);
        return NextResponse.json({ status: true, message: "API key revoked" });
    } catch (error) {
        return NextResponse.json({ status: false, message: "Failed to revoke API key", error: "Failed to revoke API key" }, { status: 500 });
    }
}
