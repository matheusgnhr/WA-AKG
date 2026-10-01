import type { Prisma } from '@prisma/client';
/** Produce plain JSON suitable for Prisma (vendor protobuf objects have no JSON index signature). */
export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}
