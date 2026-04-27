// localStorage-backed credential persistence. Stored cleartext in the
// app's webview storage directory — same threat model as a config file
// in your home directory. For a localhost ProtonMail Bridge setup this
// is fine; promote to a passphrase-locked Stronghold vault before
// shipping to anyone whose threat model includes local file access.

const KEY = "mail-bubbles:account-v1";

export interface StoredAccount {
  host: string;
  port: string;
  username: string;
  password: string;
}

export function saveAccount(a: StoredAccount): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(a));
}

export function loadAccount(): StoredAccount | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAccount>;
    if (
      typeof parsed.host === "string" &&
      typeof parsed.port === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.password === "string"
    ) {
      return {
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAccount(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}

export function hasStoredAccount(): boolean {
  return loadAccount() !== null;
}
