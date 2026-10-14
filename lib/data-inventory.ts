import { RETENTION_DAYS } from "./retention";

/**
 * Single source of truth for /privacy/metadata: every field we store, where, and for how long.
 * tests/data-inventory.test.ts fails if a DB column, Redis key or log field is added without
 * being listed here, so the public page cannot drift from the code.
 */
export interface DataField { store: "postgres" | "redis" | "server-log" | "browser"; container: string; field: string; en: string; de: string; retentionEn: string; retentionDe: string }

const ACCOUNT_EN = `until ${RETENTION_DAYS} days after the account was last seen (no active subscription), or until you delete the account (Account → Delete account)`;
const ACCOUNT_DE = `bis ${RETENTION_DAYS} Tage nach der letzten Nutzung (ohne aktives Abo) oder bis Sie das Konto löschen (Konto → Konto löschen)`;
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
  { store: "postgres", container: "schema_migrations", field: "name, applied_at", en: "Database schema version. No personal data.", de: "Version des Datenbankschemas. Keine personenbezogenen Daten.", retentionEn: "permanent", retentionDe: "dauerhaft" },
  { store: "redis", container: "pai:d:{account}:<day>", field: "counter", en: "Messages sent today (a number).", de: "Heute gesendete Nachrichten (eine Zahl).", retentionEn: "expires after 2 days", retentionDe: "läuft nach 2 Tagen ab" },
  { store: "redis", container: "pai:m:{account}:<minute>", field: "counter", en: "Requests in the current minute (a number).", de: "Anfragen in der aktuellen Minute (eine Zahl).", retentionEn: "expires after 2 minutes", retentionDe: "läuft nach 2 Minuten ab" },
  { store: "redis", container: "pai:f:{account}", field: "timestamps", en: "Times of failed requests (error budget).", de: "Zeitpunkte fehlgeschlagener Anfragen (Fehlerbudget).", retentionEn: "30 seconds", retentionDe: "30 Sekunden" },
  { store: "redis", container: "pai:once:webauthn:reg:<challenge>", field: "account id", en: "Pending passkey registration challenge.", de: "Offene Passkey-Registrierungs-Challenge.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:once:webauthn:auth:<challenge>", field: "flag or account id", en: "Pending passkey login challenge; holds the account id only when confirming an action on the signed-in account.", de: "Offene Passkey-Login-Challenge; enthält die Konto-ID nur bei der Bestätigung einer Aktion im angemeldeten Konto.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:once:webauthn:stepup:<account>", field: "flag", en: "Marks a passkey login in the last 5 minutes, needed to add/remove a passkey or delete the account.", de: "Markiert einen Passkey-Login der letzten 5 Minuten; nötig zum Hinzufügen/Entfernen eines Passkeys oder Löschen des Kontos.", retentionEn: "used once or 5 minutes", retentionDe: "einmalig bzw. 5 Minuten" },
  { store: "redis", container: "pai:rl:{<route or account>}:<window>", field: "counter", en: "Abuse limit: requests per window for a route (all users together) or for an account id. Never an IP address.", de: "Missbrauchsschutz: Anfragen je Zeitfenster für eine Route (alle Nutzer zusammen) oder eine Konto-ID. Nie eine IP-Adresse.", retentionEn: "expires with its window (at most 1 hour)", retentionDe: "läuft mit dem Zeitfenster ab (höchstens 1 Stunde)" },
  ...([
    ["route", "API route called", "aufgerufene API-Route"], ["provider", "inference provider id", "ID des Inferenz-Anbieters"], ["model", "model id", "Modell-ID"],
    ["status", "HTTP status", "HTTP-Status"], ["ms", "duration in ms", "Dauer in ms"], ["tier", "plan", "Tarif"], ["event", "event name, e.g. gated", "Ereignisname, z. B. gated"],
    ["inputChars", "length of input (a number)", "Länge der Eingabe (eine Zahl)"], ["outputBytes", "size of the reply (a number)", "Größe der Antwort (eine Zahl)"],
  ] as const).map(([field, en, de]): DataField => ({
    store: "server-log", container: "stdout (metadata log)", field, en: `${en}; never the content`, de: `${de}; nie der Inhalt`,
    retentionEn: "rotated, at most 30 MB per container (TODO: confirm host log retention)", retentionDe: "rotierend, höchstens 30 MB je Container (TODO: Log-Aufbewahrung des Hosts bestätigen)",
  })),
  { store: "browser", container: "cookie pai_session", field: "session token", en: "Signed opaque account id. HttpOnly, strictly necessary.", de: "Signierte Konto-ID. HttpOnly, technisch notwendig.", retentionEn: "1 year or until you clear it", retentionDe: "1 Jahr oder bis Sie es löschen" },
  { store: "browser", container: "localStorage pai.chats.v1 / pai.personas.v1", field: "chats, personas", en: "Your chat history and personas, only in your browser; never sent to us for storage. Not written in ghost chat.", de: "Ihr Chatverlauf und Ihre Personas, nur in Ihrem Browser; nie bei uns gespeichert. Im Ghost-Chat nicht geschrieben.", retentionEn: "until you delete them", retentionDe: "bis Sie sie löschen" },
];

/** What we explicitly do NOT store. */
export const NOT_STORED = {
  en: ["prompts or replies (chat content)", "IP addresses", "user agents / device fingerprints", "email addresses, names, usernames", "card or bank data (Stripe handles payment)", "analytics or tracking cookies"],
  de: ["Prompts oder Antworten (Chat-Inhalte)", "IP-Adressen", "User-Agents / Geräte-Fingerprints", "E-Mail-Adressen, Namen, Benutzernamen", "Karten- oder Bankdaten (Zahlung über Stripe)", "Analyse- oder Tracking-Cookies"],
};
