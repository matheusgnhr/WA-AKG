import { KeyedLock } from "@/lib/security/keyed-lock";
import { assertSessionId, newSessionId } from "@/lib/security/identifiers";
import { prisma } from "@/lib/prisma";
import { WhatsAppInstance } from "./instance";
import { Server } from "socket.io";
import { logger } from "@/lib/logger";

export class WhatsAppManager {
    private static instance: WhatsAppManager;
    private sessions: Map<string, WhatsAppInstance> = new Map();
    public io: Server | null = null;

    private constructor() {}

    public static getInstance(): WhatsAppManager {
        if (!WhatsAppManager.instance) {
            WhatsAppManager.instance = new WhatsAppManager();
        }
        return WhatsAppManager.instance;
    }

    setup(io: Server) {
        this.io = io;
    }

    async unreservedSessionCount(): Promise<number> {
        const rows = await prisma.$queryRaw<Array<{ missing: bigint }>>`SELECT COUNT(*) AS missing FROM Session s LEFT JOIN SessionIdentifier i ON i.id = s.sessionId LEFT JOIN SessionIdentifier canonical ON canonical.id = s.id WHERE i.id IS NULL OR canonical.id IS NULL`;
        return Number(rows[0]?.missing || 0);
    }

    async loadSessions() {
        if (!this.io) throw new Error("Socket.IO not initialized in WhatsAppManager");
        const sessions = await prisma.session.findMany({
            where: {
                status: { not: "LOGGED_OUT" }, user: { disabled: false }
            },
            select: { id: true, sessionId: true, userId: true, status: true }
        });

        let started = 0;
        for (const session of sessions) {
            // Only auto-init sessions that were CONNECTED before (have auth creds)
            const authCount = await prisma.authState.count({
                where: { sessionId: session.sessionId }
            });
            if (authCount === 0) {
                // No credentials — session was created but never connected
                // Set to STOPPED so it doesn't spam reconnect
                await prisma.session.update({
                    where: { sessionId: session.sessionId },
                    data: { status: "STOPPED" }
                }).catch(() => {});
                continue;
            }

            const instance = new WhatsAppInstance(session.sessionId, session.userId, this.io, session.id);
            instance.onRemovedFromManager = () => this.removeInstance(session.sessionId);
            this.sessions.set(session.sessionId, instance);
            await instance.init();
            started++;
        }
        logger.success("Manager", `Loaded ${started} sessions (${sessions.length - started} idle skipped).`);
    }

    async createSession(userId: string, name: string, customSessionId?: string) {
        if (!this.io && (global as any).io) {
            this.io = (global as any).io;
        }

        if (!this.io) {
            logger.error("Manager", "Socket.IO not initialized in WhatsAppManager");
            throw new Error("Socket.IO not initialized");
        }

        const sessionId = customSessionId || newSessionId();
        assertSessionId(sessionId);
        const conflict = await prisma.session.findFirst({ where: { OR: [{ id: sessionId }, { sessionId }] } });
        if (conflict) throw new Error("Session identifier already in use");

        const session = await prisma.$transaction(async db => {
        // Serialize account closure with creation at the database boundary.
        const owner = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM User WHERE id = ${userId} AND disabled = false FOR UPDATE`;
        if (!owner.length) throw new Error("Account unavailable");
        await db.sessionIdentifier.create({ data: { id: sessionId } });
        const created = await db.session.create({
            data: {
                userId,
                name,
                sessionId,
                status: "STOPPED", // Default: stopped, user must click Start
                botConfig: {
                    create: {
                        enabled: false,
                        botMode: "OWNER",
                        autoReplyMode: "ALL"
                    }
                }
            }
        });
        if (created.id !== sessionId) await db.sessionIdentifier.create({ data: { id: created.id } });
        return created;
        });

        // Don't init socket — user clicks Start manually
        logger.info("Manager", `Session ${sessionId} created (STOPPED). User must click Start to connect.`);
        return session;
    }

    public getInstance(sessionId: string) {
        return this.sessions.get(sessionId);
    }

    /** Remove instance from memory manager (cleanup after stop/logout) */
    public removeInstance(sessionId: string) {
        const inst = this.sessions.get(sessionId);
        if (inst) {
            logger.info("Manager", `Removing session ${sessionId} from memory.`);
            this.sessions.delete(sessionId);
        }
    }

    private lifecycle = new KeyedLock();

    async deleteSession(sessionId: string) {
        return this.lifecycle.run(sessionId, () => this.deleteSessionUnlocked(sessionId));
    }

    private async deleteSessionUnlocked(sessionId: string) {
        const instance = this.sessions.get(sessionId);
        if (instance) {
            await instance.shutdown();
            this.sessions.delete(sessionId);
        }
        const removed = await prisma.$transaction(async db => {
            await db.sessionIdentifier.upsert({ where: { id: sessionId }, create: { id: sessionId }, update: {} });
            await db.authState.deleteMany({ where: { sessionId } });
            const removed = await db.session.delete({ where: { sessionId } });
            await db.sessionIdentifier.upsert({ where: { id: removed.id }, create: { id: removed.id }, update: {} });
            return removed;
        });
        this.io?.in(`session:${removed.id}`).socketsLeave(`session:${removed.id}`);
    }

    async stopSession(sessionId: string) {
        return this.lifecycle.run(sessionId, () => this.stopSessionUnlocked(sessionId));
    }

    private async stopSessionUnlocked(sessionId: string) {
        const instance = this.sessions.get(sessionId);
        if (instance) {
            await instance.shutdown();
            instance.status = "STOPPED";
            this.io?.to(`session:${instance.databaseSessionId}`).emit("connection.update", { status: "STOPPED", qr: null });
            await prisma.session.update({
                where: { sessionId },
                data: { status: "STOPPED" }
            }).catch(() => {});
            // Remove from memory immediately
            this.sessions.delete(sessionId);
        }
    }

    async startSession(sessionId: string) {
        return this.lifecycle.run(sessionId, () => this.startSessionUnlocked(sessionId));
    }

    private async startSessionUnlocked(sessionId: string) {
        const session = await prisma.session.findUnique({ where: { sessionId }, include: { user: { select: { disabled: true } } } });
        if (!session || session.user.disabled) throw new Error("Session unavailable");
        // If already running, do nothing
        const existingInstance = this.sessions.get(sessionId);
        if (existingInstance?.socket && !existingInstance.isStopped) {
            return;
        }


        // Create fresh instance
        let instance = this.sessions.get(sessionId);
        if (!instance) {
            instance = new WhatsAppInstance(sessionId, session.userId, this.io!, session.id);
            instance.onRemovedFromManager = () => this.removeInstance(sessionId);
            this.sessions.set(sessionId, instance);
        } else {
            // Reset stopped flag for retry
            instance.isStopped = false;
        }

        await instance.init();
    }

    async restartSession(sessionId: string) {
        await this.stopSession(sessionId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.startSession(sessionId);
    }

    async requestPairingCode(sessionId: string, phoneNumber: string) {
        const instance = this.sessions.get(sessionId);
        if (!instance) throw new Error("Instance not found or not running");
        return await instance.requestPairingCode(phoneNumber);
    }
}

const globalForWhatsapp = global as unknown as { waManager: WhatsAppManager };

export const waManager = globalForWhatsapp.waManager || WhatsAppManager.getInstance();

globalForWhatsapp.waManager = waManager;
