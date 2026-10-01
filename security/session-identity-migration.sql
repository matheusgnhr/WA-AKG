-- Apply explicitly before the hardened gateway is exposed. Back up the database first.
-- The table must survive session/user deletion. Existing public IDs are permanently reserved.
CREATE TABLE IF NOT EXISTS `SessionIdentifier` (
  `id` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT IGNORE INTO `SessionIdentifier` (`id`) SELECT `sessionId` FROM `Session`;
INSERT IGNORE INTO `SessionIdentifier` (`id`) SELECT `id` FROM `Session`;
ALTER TABLE `SystemConfig` ALTER COLUMN `enableRegistration` SET DEFAULT false;
UPDATE `Webhook` SET `isActive` = false WHERE `secret` IS NULL OR CHAR_LENGTH(`secret`) < 32;
-- Weak legacy plaintext API keys must be rotated, never silently reused.
UPDATE `User` SET `apiKey` = NULL WHERE `apiKey` IS NOT NULL AND `apiKey` NOT REGEXP '^sha256:[a-f0-9]{64}$';
