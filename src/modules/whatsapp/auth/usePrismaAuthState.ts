import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { decryptAuthState,encryptAuthState } from "@/lib/security/secrets";
import { AuthenticationCreds,AuthenticationState,BufferJSON,initAuthCreds,SignalDataTypeMap } from "@whiskeysockets/baileys";

export const createPrismaAuthState = async (sessionId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void>, close: () => Promise<void> }> => {
    let closed = false;
    const pending = new Set<Promise<unknown>>();
    const persist = async (operation: () => Promise<unknown>) => {
        if (closed) return;
        const job = operation();
        pending.add(job);
        try { await job; } finally { pending.delete(job); }
    };

    // Helper to read JSON with Buffer handling
    const readData = async (type: string, id: string) => {
        try {
            const key = `${type}-${id}`;
            const data = await prisma.authState.findUnique({
                where: { sessionId_key: { sessionId, key } }
            });
            if (data && data.value) {
                return JSON.parse(decryptAuthState(data.value, `${sessionId}:${key}`), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            logger.error("Auth", 'Error reading auth state');
            throw error;
        }
    };

    // Helper to write data
    const writeData = async (type: string, id: string, data: unknown) => {
        try {
            const key = `${type}-${id}`;
            const value = encryptAuthState(JSON.stringify(data, BufferJSON.replacer), `${sessionId}:${key}`);

            await persist(() => prisma.authState.upsert({
                where: { sessionId_key: { sessionId, key } },
                create: { sessionId, key, value },
                update: { value }
            }));
        } catch (error) {
             logger.error("Auth", 'Error writing auth state');
             throw error;
        }
    };

    const removeData = async (type: string, id: string) => {
        try {
            const key = `${type}-${id}`;
             await persist(() => prisma.authState.deleteMany({
                where: { sessionId, key }
            }));
        } catch (error) {
            logger.error("Auth", "Error deleting auth state");
            throw error;
        }
    }


    const creds: AuthenticationCreds = (await readData('creds', 'me')) || initAuthCreds();

    return {
        close: async () => { closed = true; await Promise.allSettled([...pending]); },
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(type, id);
                        if (type === 'app-state-sync-key' && value) {
                            value = BufferJSON.reviver(null, value);
                        }
                        if (value) {
                            data[id] = value;
                        }
                    }));
                    return data;
                },
                set: async (data) => {
                     const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        const categoryData = data[category as keyof typeof data];
                        if (!categoryData) continue;

                        for (const id in categoryData) {
                            const value = categoryData[id];
                             if (value) {
                                tasks.push(writeData(category, id, value));
                            } else {
                                tasks.push(removeData(category, id));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', 'me', creds);
        }
    }
}
