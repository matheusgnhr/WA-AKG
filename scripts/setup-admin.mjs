import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
    const nextEnv = await import('@next/env');
    nextEnv.default.loadEnvConfig(process.cwd());
    const email = process.argv[2];
    const password = process.env.ADMIN_PASSWORD;

    if (!email) {
        console.error("Please provide email. Usage: node scripts/setup-admin.mjs <email> (set ADMIN_PASSWORD in the environment)");
        process.exit(1);
    }

    const existingUser = await prisma.user.findUnique({
        where: { email }
    });

    if (existingUser) {
        if (existingUser.role !== 'SUPERADMIN') throw new Error('Refusing to promote an existing public account; verify identity with a separate administrative procedure');
        console.log("Administrative account already exists; no credentials changed.");
    } else {
        if (!password || password.length < 16 || /change-this|password|admin123/i.test(password)) {
            console.error("Password required for new user. Usage: node scripts/setup-admin.mjs <email> (set ADMIN_PASSWORD in the environment)");
            process.exit(1);
        }

        console.log(`Creating new SUPERADMIN user ${email}...`);
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await prisma.user.create({
            data: {
                email,
                name: "Super Admin",
                password: hashedPassword,
                role: 'SUPERADMIN'
            }
        });
        console.log("Super Admin created successfully!");
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
