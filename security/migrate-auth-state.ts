// Offline, explicit migration. Stop the gateway and back up the database first.
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
import { prisma } from '../src/lib/prisma';
import { decryptAuthState, encryptAuthState } from '../src/lib/security/secrets';

async function main() {
  const apply = process.argv.includes('--apply');
  let legacy = 0, encrypted = 0;
  const rows = await prisma.authState.findMany();
  // Validate every record before mutating any of them. Never print credentials.
  const changes = rows.flatMap(row => {
    const context = `${row.sessionId}:${row.key}`;
    if (typeof row.value === 'string' && row.value.startsWith('v1:')) {
      JSON.parse(decryptAuthState(row.value, context)); encrypted++; return [];
    }
    if (row.value === null || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('Unexpected legacy credential shape; migration stopped');
    legacy++;
    return [{ id: row.id, value: encryptAuthState(JSON.stringify(row.value), context) }];
  });
  if (apply && changes.length) {
    await prisma.$transaction(changes.map(row => prisma.authState.update({ where: { id: row.id }, data: { value: row.value } })));
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', legacy, encrypted }));
}
main().catch(() => { console.error('Credential migration failed; inspect database shape/key configuration without exposing values'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
