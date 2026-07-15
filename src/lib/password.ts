import argon2 from "argon2";

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return argon2.hash(plainTextPassword, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  });
}

export async function verifyPassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  if (!passwordHash.startsWith("$argon2")) return false;
  try {
    return await argon2.verify(passwordHash, plainTextPassword);
  } catch {
    return false;
  }
}
