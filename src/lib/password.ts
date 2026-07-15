import argon2 from "argon2";

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
