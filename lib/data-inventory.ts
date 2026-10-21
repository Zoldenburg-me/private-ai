import { RETENTION_DAYS } from "./retention";
import { AUDIT_LOG_DAYS, ERASURE_LEDGER_DAYS } from "./store/types";

/**
 * Single source of truth for /privacy/metadata: every field we store, where, and for how long.
 * tests/data-inventory.test.ts fails if a DB column, Redis key or log field is added without
 * being listed here, so the public page cannot drift from the code.
 */
export interface DataField { store: "postgres" | "redis" | "server-log" | "browser"; container: string; field: string; en: string; de: string; retentionEn: string; retentionDe: string }

const ACCOUNT_EN = `until ${RETENTION_DAYS} days after the account was last seen (no active subscription), or until you delete the account (Settings → Account → Delete account)`;
const ACCOUNT_DE = `bis ${RETENTION_DAYS} Tage nach der letzten Nutzung (ohne aktives Abo) oder bis Sie das Konto löschen (Einstellungen → Account → Delete account)`;
const acc = (container: string, field: string, en: string, de: string): DataField => ({ store: "postgres", container, field, en, de, retentionEn: ACCOUNT_EN, retentionDe: ACCOUNT_DE });

export const DATA_INVENTORY: DataField[] = [
  acc("sessions", "id", "Random opaque account id (128 bit). Not derived from you.", "Zufällige, nicht ableitbare Konto-ID (128 Bit)."),
  acc("sessions", "created_at", "When the anonymous account was created.", "Zeitpunkt der Erstellung des anonymen Kontos."),
  acc("sessions", "last_seen_on", "Day (not time) of last use; used only for the retention limit.", "Tag (keine Uhrzeit) der letzten Nutzung; nur für die Löschfrist."),
  acc("entitlements", "account_id", "Opaque account id the plan belongs to.", "Konto-ID, zu der der Tarif gehört."),
  acc("entitlements", "tier", "Plan: free, pro or max.", "Tarif: free, pro oder max."),
  acc("entitlements", "source", "Where the plan came from: stripe or manual.", "Herkunft des Tarifs: stripe oder manuell."),
  acc("entitlements", "expires_at", "End of the paid period plus 3 days grace.", "Ende des bezahlten Zeitraums plus 3 Tage Kulanz."),
  acc("entitlements", "updated_at", "Last change of the plan.", "Letzte Änderung des Tarifs."),
  acc("subscriptions", "stripe_subscription_id", "Stripe subscription id (no card data).", "Stripe-Abo-ID (keine Kartendaten)."),
  acc("subscriptions", "account_id", "Opaque account id the subscription belongs to.", "Konto-ID, zu der das Abo gehört."),
  acc("subscriptions", "stripe_customer_id", "Stripe customer id, needed for the billing portal.", "Stripe-Kunden-ID, nötig für das Kundenportal."),
  acc("subscriptions", "tier", "Plan bought.", "Gebuchter Tarif."),
  acc("subscriptions", "status", "Stripe status, e.g. active or canceled.", "Stripe-Status, z. B. active oder canceled."),
  acc("subscriptions", "current_period_end", "End of the current billing period.", "Ende des aktuellen Abrechnungszeitraums."),
  acc("subscriptions", "updated_at", "Last status change.", "Letzte Statusänderung."),
  acc("passkey_credentials", "credential_id", "Id of your passkey (chosen by your device).", "ID Ihres Passkeys (vom Gerät erzeugt)."),
  acc("passkey_credentials", "account_id", "Opaque account id the passkey unlocks.", "Konto-ID, die der Passkey entsperrt."),
  acc("passkey_credentials", "public_key", "Public key only; the private key never leaves your device.", "Nur der öffentliche Schlüssel; der private bleibt auf Ihrem Gerät."),
  acc("passkey_credentials", "counter", "Signature counter (detects cloned authenticators).", "Signaturzähler (erkennt geklonte Authenticatoren)."),
  acc("passkey_credentials", "transports", "How the device talks to the passkey, e.g. internal, usb.", "Verbindungsart, z. B. internal, usb."),
  acc("passkey_credentials", "created_at", "When the passkey was added.", "Zeitpunkt des Hinzufügens."),
  acc("devices", "id", "Random id of a signed-in browser (128 bit). No device name, model or user agent.", "Zufällige ID eines angemeldeten Browsers (128 Bit). Kein Gerätename, Modell oder User-Agent."),
  acc("devices", "account_id", "Opaque account id the browser is signed in to.", "Konto-ID, bei der der Browser angemeldet ist."),
  acc("devices", "created_at", "When you signed in on that browser.", "Zeitpunkt der Anmeldung in diesem Browser."),
  acc("devices", "last_seen_on", "Day (not time) the browser was last used. Signing out or removing the device deletes the row.", "Tag (keine Uhrzeit) der letzten Nutzung. Abmelden oder Entfernen des Geräts löscht die Zeile."),
  { store: "postgres", container: "erasures", field: "id_hash", en: "One-way hash (SHA-256) of the id of an account you deleted, so that restoring a backup deletes it again. Cannot be turned back into the id.", de: "Einweg-Hash (SHA-256) der ID eines gelöschten Kontos, damit es beim Einspielen einer Sicherung erneut gelöscht wird. Lässt sich nicht in die ID zurückrechnen.", retentionEn: `${ERASURE_LEDGER_DAYS} days after the deletion`, retentionDe: `${ERASURE_LEDGER_DAYS} Tage nach der Löschung` },
  { store: "postgres", container: "erasures", field: "deleted_on", en: "Day (not time) the account was deleted.", de: "Tag (keine Uhrzeit) der Löschung.", retentionEn: `${ERASURE_LEDGER_DAYS} days after the deletion`, retentionDe: `${ERASURE_LEDGER_DAYS} Tage nach der Löschung` },
  ...([
    ["id", "Random id of a provider API key (ours, not yours).", "Zufällige ID eines Anbieter-API-Schlüssels (unserer, nicht Ihrer)."],
    ["provider", "Which inference provider the key is for.", "Für welchen Inferenz-Anbieter der Schlüssel gilt."],
    ["ciphertext", "Our provider API key, AES-256-GCM encrypted; the decryption key is not in the database.", "Unser Anbieter-API-Schlüssel, AES-256-GCM-verschlüsselt; der Entschlüsselungsschlüssel liegt nicht in der Datenbank."],
    ["suffix", "Last 4 characters of the key, so operators can tell keys apart.", "Letzte 4 Zeichen des Schlüssels, damit Betreiber Schlüssel unterscheiden können."],
    ["status", "active or disabled.", "aktiv oder deaktiviert."],
    ["created_at", "When the key was added (rotation time).", "Zeitpunkt des Hinzufügens (Rotation)."],
    ["disabled_at", "When the key was disabled or replaced.", "Zeitpunkt der Deaktivierung oder Ersetzung."],
    ["last_used_at", "When the key was last used for a chat request (no user id).", "Letzte Nutzung des Schlüssels für eine Chat-Anfrage (ohne Nutzer-ID)."],
  ] as const).map(([field, en, de]): DataField => ({
    store: "postgres", container: "provider_keys", field, en: `${en} No personal data.`, de: `${de} Keine personenbezogenen Daten.`,
    retentionEn: "until an operator removes the key", retentionDe: "bis ein Betreiber den Schlüssel entfernt",
  })),
  ...([
    ["id", "Sequence number of the entry.", "Laufende Nummer des Eintrags."],
    ["at", "When the operator action happened.", "Zeitpunkt der Betreiber-Aktion."],
    ["admin_id", "Opaque account id of the operator who acted (operators only, never a regular user); kept for accountability even if that operator account is later deleted.", "Konto-ID des handelnden Betreibers (nur Betreiber, nie normale Nutzer); bleibt zur Nachvollziehbarkeit auch nach Löschung dieses Betreiberkontos erhalten."],
    ["action", "What was done, e.g. set_entitlement, revoke_device, delete_account, add_key.", "Was getan wurde, z. B. set_entitlement, revoke_device, delete_account, add_key."],
    ["account_id", "Opaque account id the action was about; removed when that account is deleted.", "Konto-ID, die die Aktion betraf; wird mit dem Konto gelöscht."],
    ["target", "Id of a device, key or invite acted on, or for a deleted account the one-way hash from the erasure ledger.", "ID des betroffenen Geräts, Schlüssels oder Einladungscodes, bei gelöschten Konten der Einweg-Hash aus dem Löschprotokoll."],
    ["detail", "Short non-secret detail, e.g. the plan set. Never a key, code or content.", "Kurzes, nicht geheimes Detail, z. B. der gesetzte Tarif. Nie ein Schlüssel, Code oder Inhalt."],
  ] as const).map(([field, en, de]): DataField => ({
    store: "postgres", container: "admin_audit", field, en: `${en} Operator audit log; no IP addresses or user agents.`, de: `${de} Prüfprotokoll der Betreiber; keine IP-Adressen oder User-Agents.`,
    retentionEn: `${AUDIT_LOG_DAYS} days`, retentionDe: `${AUDIT_LOG_DAYS} Tage`,
  })),
  ...([
    ["id", "Random id of an invite code.", "Zufällige ID eines Einladungscodes."],
    ["code_hash", "SHA-256 of the invite code; the code itself is not stored.", "SHA-256 des Einladungscodes; der Code selbst wird nicht gespeichert."],
    ["max_uses", "How many signups the code allows.", "Wie viele Registrierungen der Code erlaubt."],
    ["uses", "How many times it was used (a number; not by whom).", "Wie oft er benutzt wurde (eine Zahl; nicht von wem)."],
    ["created_at", "When the code was created.", "Zeitpunkt der Erstellung."],
    ["revoked_at", "When the code was revoked.", "Zeitpunkt des Widerrufs."],
  ] as const).map(([field, en, de]): DataField => ({
    store: "postgres", container: "invite_codes", field, en: `${en} Not linked to any account.`, de: `${de} Mit keinem Konto verknüpft.`,
    retentionEn: "until an operator deletes it", retentionDe: "bis ein Betreiber ihn löscht",
  })),
  { store: "postgres", container: "schema_migrations", field: "name, applied_at", en: "Database schema version. No personal data.", de: "Version des Datenbankschemas. Keine personenbezogenen Daten.", retentionEn: "permanent", retentionDe: "dauerhaft" },
  { store: "redis", container: "pai:d:{account}:<day>", field: "counter", en: "Messages sent today (a number).", de: "Heute gesendete Nachrichten (eine Zahl).", retentionEn: "expires after 2 days", retentionDe: "läuft nach 2 Tagen ab" },
  { store: "redis", container: "pai:m:{account}:<minute>", field: "counter", en: "Requests in the current minute (a number).", de: "Anfragen in der aktuellen Minute (eine Zahl).", retentionEn: "expires after 2 minutes", retentionDe: "läuft nach 2 Minuten ab" },
  { store: "redis", container: "pai:f:{account}", field: "timestamps", en: "Times of failed requests (error budget).", de: "Zeitpunkte fehlgeschlagener Anfragen (Fehlerbudget).", retentionEn: "30 seconds", retentionDe: "30 Sekunden" },
  { store: "redis", container: "pai:once:webauthn:reg:<challenge>", field: "account id", en: "Pending passkey registration challenge.", de: "Offene Passkey-Registrierungs-Challenge.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:once:webauthn:auth:<challenge>", field: "flag, or account and device id", en: "Pending passkey login challenge; holds the account and device id only when confirming an action on the signed-in browser.", de: "Offene Passkey-Login-Challenge; enthält Konto- und Geräte-ID nur bei der Bestätigung einer Aktion im angemeldeten Browser.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:once:webauthn:stepup:<account>:<device>", field: "flag", en: "Marks a passkey confirmation on this browser in the last 5 minutes, needed to add/remove a passkey or device or delete the account. Valid only for the browser that confirmed it. For operators, also marks a confirmation in the admin session (device part adm.<session>).", de: "Markiert eine Passkey-Bestätigung in diesem Browser in den letzten 5 Minuten; nötig zum Hinzufügen/Entfernen eines Passkeys oder Geräts oder Löschen des Kontos. Gilt nur für den bestätigenden Browser. Bei Betreibern auch eine Bestätigung in der Admin-Sitzung (Geräteteil „adm.<Sitzung>“).", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:once:invite:<account>", field: "invite code hash", en: "While you create an account with an invite code from the admin panel: the SHA-256 of that code, so its use is counted only once the passkey exists.", de: "Während Sie mit einem Einladungscode aus dem Admin-Bereich ein Konto anlegen: der SHA-256-Hash des Codes, damit die Nutzung erst gezählt wird, wenn der Passkey existiert.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:rl:{<route or account>}:<window>", field: "counter", en: "Abuse limit: requests per window for a route (all users together) or for an account id. Never an IP address.", de: "Missbrauchsschutz: Anfragen je Zeitfenster für eine Route (alle Nutzer zusammen) oder eine Konto-ID. Nie eine IP-Adresse.", retentionEn: "expires with its window (at most 1 hour)", retentionDe: "läuft mit dem Zeitfenster ab (höchstens 1 Stunde)" },
  ...([
    ["route", "API route called", "aufgerufene API-Route"], ["provider", "inference provider id", "ID des Inferenz-Anbieters"], ["model", "model id", "Modell-ID"],
    ["status", "HTTP status", "HTTP-Status"], ["ms", "duration in ms", "Dauer in ms"], ["tier", "plan", "Tarif"], ["event", "event name, e.g. gated", "Ereignisname, z. B. gated"],
    ["inputChars", "length of input (a number)", "Länge der Eingabe (eine Zahl)"], ["outputBytes", "size of the reply (a number)", "Größe der Antwort (eine Zahl)"],
    ["tool", "name of the agent tool used, e.g. web_search (never the search query)", "Name des genutzten Agenten-Werkzeugs, z. B. web_search (nie die Suchanfrage)"], ["steps", "number of agent steps (a number)", "Anzahl der Agenten-Schritte (eine Zahl)"],
  ] as const).map(([field, en, de]): DataField => ({
    store: "server-log", container: "stdout (metadata log)", field, en: `${en}; never the content`, de: `${de}; nie der Inhalt`,
    retentionEn: "rotated, at most 30 MB per container (TODO: confirm host log retention)", retentionDe: "rotierend, höchstens 30 MB je Container (TODO: Log-Aufbewahrung des Hosts bestätigen)",
  })),
  { store: "browser", container: "cookie pai_admin", field: "admin session token", en: "Operators only: signed operator account id, a random session id and the expiry. HttpOnly, sent only to /api/admin.", de: "Nur Betreiber: signierte Konto-ID des Betreibers, eine zufällige Sitzungs-ID und das Ablaufdatum. HttpOnly, nur an /api/admin gesendet.", retentionEn: "2 hours", retentionDe: "2 Stunden" },
  { store: "browser", container: "cookie pai_session", field: "session token", en: "Signed opaque account id, plus the device id once you are signed in. HttpOnly, strictly necessary.", de: "Signierte Konto-ID, nach der Anmeldung zusätzlich die Geräte-ID. HttpOnly, technisch notwendig.", retentionEn: "1 year or until you clear it", retentionDe: "1 Jahr oder bis Sie es löschen" },
  { store: "browser", container: "localStorage pai.ui.sidebar-collapsed", field: "sidebar collapsed (1/0)", en: "Whether you collapsed the chat sidebar on a wide screen; a display setting, nothing about you or your chats. Not written in ghost chat.", de: "Ob Sie die Chat-Seitenleiste auf einem breiten Bildschirm eingeklappt haben; eine Anzeigeeinstellung, nichts über Sie oder Ihre Chats. Im Ghost-Chat nicht geschrieben.", retentionEn: "until you clear site data", retentionDe: "bis Sie die Website-Daten löschen" },
  { store: "browser", container: "localStorage pai.chats.v1 / pai.personas.v1", field: "chats, personas", en: "Your chat history and personas, only in your browser; never sent to us for storage. Not written in ghost chat.", de: "Ihr Chatverlauf und Ihre Personas, nur in Ihrem Browser; nie bei uns gespeichert. Im Ghost-Chat nicht geschrieben.", retentionEn: "until you delete them", retentionDe: "bis Sie sie löschen" },
];

/** What we explicitly do NOT store. */
export const NOT_STORED = {
  en: ["prompts or replies (chat content)", "IP addresses", "user agents / device fingerprints", "email addresses, names, usernames", "card or bank data (Stripe handles payment)", "analytics or tracking cookies"],
  de: ["Prompts oder Antworten (Chat-Inhalte)", "IP-Adressen", "User-Agents / Geräte-Fingerprints", "E-Mail-Adressen, Namen, Benutzernamen", "Karten- oder Bankdaten (Zahlung über Stripe)", "Analyse- oder Tracking-Cookies"],
};
