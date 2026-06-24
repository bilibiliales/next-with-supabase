export const WOLF_AUTH_EMAIL_DOMAIN = "wolf-ai.com";

export function normalizeWolfUsername(username: string) {
  return username.trim().toLowerCase();
}

export function validatedWolfUsername(username: string) {
  const normalizedUsername = normalizeWolfUsername(username);
  if (!normalizedUsername) throw new Error("Username is required.");
  if (normalizedUsername.includes("@")) throw new Error("Enter username only, without @wolf-ai.com.");
  if (/\s/.test(normalizedUsername)) throw new Error("Username cannot contain spaces.");
  return normalizedUsername;
}

export function wolfEmailFromUsername(username: string) {
  return `${normalizeWolfUsername(username)}@${WOLF_AUTH_EMAIL_DOMAIN}`;
}
