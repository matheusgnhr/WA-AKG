export interface SystemMetrics {
  cpu: { load: number; cores: number[] };
  memory: { total: number; used: number; free: number; swapTotal: number; swapUsed: number };
  disk: { fs: string; mount: string; size: number; used: number; usePercent: number }[];
  network: { iface: string; rx_sec: number; tx_sec: number; state: string }[];
  os: { platform: string; distro: string; release: string; uptime: number };
  process: { uptime: number; heapTotal: number; heapUsed: number; rss: number };
}
