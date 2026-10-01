import { getAuthenticatedUser } from "@/lib/api-auth";
import { errorMessage as getErrorMessage } from "@/lib/error-message";
import type { SystemMetrics } from "@/lib/monitor-types";
import { NextRequest,NextResponse } from "next/server";
import si from "systeminformation";

// Ensure this route is dynamic
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    try {
        const auth = await getAuthenticatedUser(req);
        if (!auth) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        // Global monitor needs SUPERADMIN
        if (auth.role !== "SUPERADMIN") {
            return NextResponse.json({ status: false, message: "Forbidden - Superadmin only" }, { status: 403 });
        }

        // Fetch system stats in parallel for speed
        const [cpu, mem, os, , fsSize, networkStats] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.osInfo(),
            si.diskLayout(),
            si.fsSize(),
            si.networkStats()
        ]);

        // Calculate Process (Node.js) Memory
        const processMemory = process.memoryUsage();

        const data: SystemMetrics = {
            cpu: {
                load: cpu.currentLoad,
                cores: cpu.cpus.map(c => c.load),
            },
            memory: {
                total: mem.total,
                used: mem.active,
                free: mem.available,
                swapTotal: mem.swaptotal,
                swapUsed: mem.swapused,
            },
            disk: fsSize.map(disk => ({
                fs: disk.fs,
                mount: disk.mount,
                size: disk.size,
                used: disk.used,
                usePercent: disk.use
            })),
            network: networkStats.map(net => ({
                iface: net.iface,
                rx_sec: net.rx_sec,
                tx_sec: net.tx_sec,
                state: net.operstate
            })).filter(net => net.state === "up" || net.rx_sec > 0 || net.tx_sec > 0),
            os: {
                platform: os.platform,
                distro: os.distro,
                release: os.release,
                uptime: si.time().uptime
            },
            process: {
                uptime: process.uptime(),
                heapTotal: processMemory.heapTotal,
                heapUsed: processMemory.heapUsed,
                rss: processMemory.rss,
            }
        };

        return NextResponse.json({
            status: true,
            message: "System metrics fetched successfully",
            data
        });

    } catch (error) {
        console.error("Monitor API Error:", error);
        return NextResponse.json({ status: false, message: getErrorMessage(error) }, { status: 500 });
    }
}
