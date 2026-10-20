import { LegalPage, Lang, Todo } from "@/components/legal";
import { RETENTION_DAYS } from "@/lib/retention";

export const metadata = { title: "Datenschutzerklärung / Privacy policy" };

export default function Datenschutz() {
  return (
    <LegalPage title="Datenschutzerklärung / Privacy policy">
      <p><Todo>Gesamten Text anwaltlich prüfen (DSGVO, TDDDG) / full text needs lawyer review</Todo></p>
      <Lang id="de">
        <h2>Datenschutzerklärung</h2>
        <h3>1. Verantwortlicher</h3>
        <p>Zoldenburg UG (haftungsbeschränkt), Anschrift siehe <a href="/impressum">Impressum</a>. E-Mail: <a href="mailto:kontakt@zoldenburg.com">kontakt@zoldenburg.com</a>.
          Datenschutzbeauftragter: <Todo>falls erforderlich benennen, sonst Satz streichen</Todo></p>
        <h3>2. Grundsatz</h3>
        <p>Wir speichern keine Chat-Inhalte, keine IP-Adressen, keine User-Agents und keine E-Mail-Adressen. Ihr Chatverlauf liegt nur in Ihrem Browser.
          Eine vollständige, automatisch mit dem Code abgeglichene Liste aller gespeicherten Felder und Fristen finden Sie unter <a href="/privacy/metadata">/privacy/metadata</a>.</p>
        <h3>3. Nutzung ohne Konto</h3>
        <p>Beim ersten Aufruf erzeugen wir eine zufällige Konto-ID und legen sie signiert in einem technisch notwendigen Cookie (<code>pai_session</code>) ab
          (§ 25 Abs. 2 Nr. 2 TDDDG). Auf dem Server speichern wir zu dieser ID nur Erstellungszeitpunkt, Tag der letzten Nutzung, Tarif und Zähler für die Nutzungsgrenzen.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des Dienstes) und lit. f (Missbrauchsschutz durch Nutzungsgrenzen).</p>
        <h3>4. Chat-Inhalte</h3>
        <p>Ihre Nachrichten werden über unseren Server an den gewählten KI-Anbieter weitergeleitet und die Antwort zurückgestreamt. Inhalte werden dabei nur im Arbeitsspeicher
          verarbeitet, weder gespeichert noch protokolliert. Standardmäßig nutzen wir nur Anbieter, deren Modelle in vertraulichen Rechenumgebungen (TEE) laufen oder die vertraglich keine Daten aufbewahren.
          Empfänger: <Todo>Liste der Inferenz-Anbieter mit Sitz, AVV und ggf. Drittlandtransfer (Art. 44 ff. DSGVO), z. B. NEAR AI Cloud</Todo>.
          Im Ghost-Chat wird der Verlauf auch in Ihrem Browser nicht gespeichert.</p>
        <p>Anonymisierte Frontier-Modelle (optional): Modelle mit der Kennzeichnung „ANONYMIZED“ (z. B. GPT, Claude, Gemini) laufen nicht in einer TEE und werden nie automatisch ausgewählt.
          Wählen Sie eines aus, leiten wir Ihre Nachricht über Venice (<Todo>Firma, Sitz, AVV und Drittlandtransfer (Art. 44 ff. DSGVO) für Venice ergänzen</Todo>) an den jeweiligen
          Modellanbieter weiter (<Todo>OpenAI, Anthropic, Google u. a.: Rolle, Sitz, Aufbewahrung und Drittlandtransfer prüfen</Todo>). Die Anfrage läuft unter unserem Konto bei Venice;
          Ihre Konto-ID, Ihre IP-Adresse und Ihr Session-Token werden nicht übermittelt. Venice und der Modellanbieter erhalten aber den Inhalt Ihrer Nachricht und der Antwort,
          und wir können technisch nicht nachweisen, was sie damit tun. Geben Sie in diesen Chats keine Angaben ein, die Sie identifizieren.</p>
        <h3>5. Passkeys (optional)</h3>
        <p>Wenn Sie einen Passkey hinzufügen, speichern wir dessen ID, den öffentlichen Schlüssel, einen Signaturzähler und die Verbindungsart. Biometrische Daten verlassen Ihr Gerät nicht. Für jeden Browser, in dem Sie sich anmelden, speichern wir eine zufällige Geräte-ID mit Erstellungszeitpunkt und dem Tag der letzten Nutzung (kein Gerätename, Modell oder User-Agent); Abmelden oder Entfernen des Geräts unter Einstellungen → Account löscht sie.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>
        <h3>6. Zahlungen über Stripe</h3>
        <p>Bezahlte Tarife werden über Stripe abgewickelt (<Todo>Stripe Payments Europe, Ltd., Irland – Rolle als eigener Verantwortlicher/Auftragsverarbeiter prüfen</Todo>).
          Zahlungs- und Kontaktdaten geben Sie direkt bei Stripe ein; wir erhalten keine Kartendaten. Wir speichern nur Stripe-Kunden- und Abo-ID, Tarif, Status und Laufzeitende.
          Von Stripe gesendete Ereignisse können weitere Angaben (z. B. E-Mail) enthalten; diese werden weder gespeichert noch protokolliert.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b und c DSGVO. Datenschutzhinweise von Stripe: <a href="https://stripe.com/de/privacy" rel="noopener noreferrer">stripe.com/de/privacy</a>.</p>
        <h3>7. Hosting und Server-Logs</h3>
        <p>Hosting: <Todo>Hetzner Online GmbH, Gunzenhausen, Rechenzentrum in Deutschland; AVV abschließen</Todo>. Unsere Anwendung protokolliert nur Metadaten (Route, Modell, Status, Dauer, Längen als Zahlen), nie Inhalte oder IP-Adressen.
          <Todo>Reverse-Proxy so konfigurieren, dass keine IP-Adressen geloggt werden, und hier bestätigen</Todo></p>
        <h3>8. Speicherdauer</h3>
        <p>Konten ohne aktives Abo werden {RETENTION_DAYS} Tage nach der letzten Nutzung automatisch gelöscht. Zähler laufen nach spätestens 2 Tagen ab. Einzelheiten: <a href="/privacy/metadata">/privacy/metadata</a>.
          <Todo>handels- und steuerrechtliche Aufbewahrungspflichten (Rechnungen bei Stripe) ergänzen</Todo></p>
        <h3>9. Ihre Rechte</h3>
        <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) sowie auf Beschwerde bei einer Aufsichtsbehörde (Art. 77 DSGVO),
          z. B. beim Bayerischen Landesamt für Datenschutzaufsicht (BayLDA), Ansbach. Auskunft und Datenübertragbarkeit: In den Einstellungen (⚙︎) unter „Account“ laden Sie mit „Download my data“ alle bei uns gespeicherten Daten Ihres Kontos als JSON-Datei herunter. Löschung: „Delete account“ löscht Ihr Konto, Tarif, Passkeys, angemeldete Geräte und Abo-Daten sofort sowie Ihren Kundendatensatz bei Stripe (gesetzlich aufzubewahrende Rechnungen verbleiben bei Stripe). Da wir Sie nicht namentlich kennen, erfolgt die Zuordnung über Ihr Session-Cookie bzw. Ihren Passkey (Art. 11 DSGVO); senden Sie uns Ihr Session-Token nicht per E-Mail.
          Eine automatisierte Entscheidungsfindung oder Profilbildung findet nicht statt.</p>
      </Lang>
      <Lang id="en">
        <h2>Privacy policy</h2>
        <h3>1. Controller</h3>
        <p>Zoldenburg UG (haftungsbeschränkt), address see <a href="/impressum">legal notice</a>. Email: <a href="mailto:kontakt@zoldenburg.com">kontakt@zoldenburg.com</a>.</p>
        <h3>2. Principle</h3>
        <p>We do not store chat content, IP addresses, user agents or email addresses. Your chat history lives only in your browser.
          A complete list of every stored field and its retention, checked against the code automatically, is at <a href="/privacy/metadata">/privacy/metadata</a>.</p>
        <h3>3. Using the service without an account</h3>
        <p>On first visit we create a random account id and keep it, signed, in a strictly necessary cookie (<code>pai_session</code>, § 25(2) no. 2 TDDDG).
          On the server we keep only its creation time, the day of last use, your plan, and usage counters. Legal basis: Art. 6(1)(b) GDPR (providing the service) and (f) (abuse prevention via usage limits).</p>
        <h3>4. Chat content</h3>
        <p>Your messages are relayed through our server to the selected AI provider and the reply is streamed back. Content is processed in memory only; it is never stored or logged.
          By default we only offer providers that run models in confidential computing environments (TEE) or retain no data by contract.
          Recipients: <Todo>list of inference providers with location, DPA and any third-country transfer</Todo>. Ghost chats are not stored even in your browser.</p>
        <p>Anonymized frontier models (optional): models labelled “ANONYMIZED” (e.g. GPT, Claude, Gemini) do not run in a TEE and are never selected automatically.
          If you pick one, we relay your message via Venice (<Todo>Venice company, location, DPA and third-country transfer (Art. 44 ff. GDPR)</Todo>) to the model vendor
          (<Todo>OpenAI, Anthropic, Google etc.: confirm role, location, retention and third-country transfer</Todo>). The request runs under our Venice account;
          your account id, IP address and session token are not sent. Venice and the model vendor do receive the content of your message and the reply,
          and we cannot technically prove what they do with it. Do not enter details that identify you in these chats.</p>
        <h3>5. Passkeys (optional)</h3>
        <p>If you add a passkey we store its id, public key, signature counter and transport type. Biometric data never leaves your device. Each browser you sign in to gets a random device id with its creation time and the day it was last used (no device name, model or user agent); signing out or removing the device under Settings → Account deletes it. Legal basis: Art. 6(1)(b) GDPR.</p>
        <h3>6. Payments via Stripe</h3>
        <p>Paid plans are processed by Stripe (<Todo>Stripe Payments Europe, Ltd., Ireland – confirm role</Todo>). You enter payment and contact details directly with Stripe; we never receive card data.
          We store only Stripe customer and subscription ids, plan, status and period end. Events sent by Stripe can contain further details (e.g. email); we neither store nor log them.
          Legal basis: Art. 6(1)(b) and (c) GDPR.</p>
        <h3>7. Hosting and server logs</h3>
        <p>Hosting: <Todo>Hetzner Online GmbH, data centre in Germany; sign DPA</Todo>. Our application logs metadata only (route, model, status, duration, sizes as numbers), never content or IP addresses.</p>
        <h3>8. Retention</h3>
        <p>Accounts without an active subscription are deleted automatically {RETENTION_DAYS} days after last use. Counters expire within 2 days. Details: <a href="/privacy/metadata">/privacy/metadata</a>.</p>
        <h3>9. Your rights</h3>
        <p>You have the rights of access, rectification, erasure, restriction, portability and objection (Art. 15–21 GDPR) and may complain to a supervisory authority (Art. 77 GDPR).
          Access and portability: in Settings (⚙︎) under &quot;Account&quot;, &quot;Download my data&quot; gives you everything we store for your account as a JSON file. Erasure: &quot;Delete account&quot; immediately deletes your account, plan, passkeys, signed-in devices and subscription records, and your customer record at Stripe (invoices Stripe must keep by law remain there). As we do not know who you are, your session cookie or passkey identifies your account (Art. 11 GDPR); do not email us your session token. There is no automated decision-making or profiling.</p>
      </Lang>
    </LegalPage>
  );
}
