import { prisma } from "../prisma";
const isAdmin = (role: string) => role === "SUPERADMIN";

export async function resolveSession(identifier: string) {
    if (typeof identifier !== "string" || identifier.length > 160) return null;
    const rows = await prisma.session.findMany({ where: { OR: [{ id: identifier }, { sessionId: identifier }] }, take: 2 });
    // Never authorize one identity then operate on another matching row.
    return rows.length === 1 ? rows[0] : null;
}

export async function canAccessSession(userId: string, userRole: string, sessionId: string): Promise<boolean> {
    const session = await resolveSession(sessionId);
    // Legacy transport routes look up instances/rows by public slug. Do not authorize
    // a database-ID alias that those routes would interpret as a different slug.
    if (!session || session.sessionId !== sessionId) return false;
    if (isAdmin(userRole) || session.userId === userId) return true;
    return !!await prisma.sessionAccess.findUnique({ where: { sessionId_userId: { sessionId: session.id, userId } } });
}

export async function isSessionOwner(userId: string, userRole: string, sessionId: string): Promise<boolean> {
    const session = await resolveSession(sessionId);
    return !!session && (isAdmin(userRole) || session.userId === userId);
}


export async function canAccessMedia(userId: string, role: string, canonicalMediaSession: string): Promise<boolean> {
    if (!canonicalMediaSession.startsWith('media_')) return false;
    const session = await prisma.session.findUnique({ where: { id: canonicalMediaSession.slice(6) } });
    if (!session) return false;
    if (role === 'SUPERADMIN' || session.userId === userId) return true;
    return !!await prisma.sessionAccess.findUnique({ where: { sessionId_userId: { sessionId: session.id, userId } } });
}

export async function canAccessDatabaseSession(userId: string, role: string, id: string): Promise<boolean> {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return false;
    if (role === 'SUPERADMIN' || session.userId === userId) return true;
    return !!await prisma.sessionAccess.findUnique({ where: { sessionId_userId: { sessionId: session.id, userId } } });
}
