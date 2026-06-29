import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "maya@acmestudio.com" },
    update: {},
    create: {
      email: "maya@acmestudio.com",
      name: "Maya Chen",
      passwordHash: await bcrypt.hash("password123", 12),
    },
  });

  console.log(`Seeded local administrator ${user.email}. No sample campaigns were created.`);
}

main().finally(() => prisma.$disconnect());
