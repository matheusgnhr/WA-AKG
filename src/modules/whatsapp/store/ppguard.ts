import { logger } from "@/lib/logger";
import type { WASocket } from "@whiskeysockets/baileys";

export async function bindPpGuard(sock: WASocket, sessionId: string) {
    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            if (update.imgUrl) {
                logger.info("PPGuard", `Session ${sessionId}: contact ${update.id} changed profile pic to ${update.imgUrl}`);
                // Verify logic: Fetch old imgUrl from DB and compare?
                // For now, simpler: Just notify self if it's a specific target?
                // Or just log it.
                // To properly implement Guard, we need to store 'lastProfilePic' in Contact table.

                // For "Fun" feature, let's just send a message to self
                // const me = sock.user?.id;
                // if (me) {
                //    await sock.sendMessage(me, { text: `Session ${sessionId}: contact ${update.id} changed PP!` });
                // }
            }
        }
    });
}
