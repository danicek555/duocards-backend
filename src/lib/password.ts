import argon2 from "argon2";

// A valid argon2id hash (of a throwaway random secret) using the same
// parameters as hashPassword. Verifying a candidate password against it costs
// the same as a real check, so login paths that have no usable hash — unknown
// email, or an account without a password — can spend equal time and not leak
// account existence through response latency.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$Dbi9kAwXu6FzyklTdvRfTg$RjaC8UCO7Xu+EbL12WPHnDHqDfudCvJbb7gIjbGzGWM";

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return argon2.hash(plainTextPassword, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  });
}

// Runs an argon2 verify purely to equalize timing; always resolves false.
export async function verifyDummyPassword(
  plainTextPassword: string,
): Promise<false> {
  try {
    await argon2.verify(DUMMY_PASSWORD_HASH, plainTextPassword);
  } catch {
    // Ignore — the call exists only to consume the same time as a real verify.
  }
  return false;
}

export async function verifyPassword(
  plainTextPassword: string,
  passwordHash: string,
): Promise<boolean> {
  if (!passwordHash.startsWith("$argon2")) {
    return verifyDummyPassword(plainTextPassword);
  }
  try {
    return await argon2.verify(passwordHash, plainTextPassword);
  } catch {
    return false;
  }
}
