-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin';
