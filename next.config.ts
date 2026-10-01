import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "bcryptjs", "@whiskeysockets/baileys"],
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default nextConfig;
