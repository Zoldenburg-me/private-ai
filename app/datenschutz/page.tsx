import { LegalPage, Lang, Todo } from "@/components/legal";
import { RETENTION_DAYS } from "@/lib/retention";
import { AUDIT_LOG_DAYS } from "@/lib/store/types";

export const metadata = { title: "Datenschutzerklärung / Privacy policy" };

export default function Datenschutz() {
  return (
    <LegalPage title="Datenschutzerklärung / Privacy policy">
      <p><Todo>Gesamten Text anwaltlich prüfen (DSGVO, TDDDG) / full text needs lawyer review</Todo></p>
      <Lang id="de">
        <h2>Datenschutzerklärung</h2>
        <h3>1. Verantwortlicher</h3>
        <p>Zoldenburg UG (haftungsbeschränkt), Anschrift siehe <a href="/impressum">Impressum</a>. E-Mail: <a href="mailto:kontakt@zoldenburg.com">kontakt@zoldenburg.com</a>.
          Datenschutzbeauftragter: Tony Thomas, erreichbar unter derselben E-Mail-Adresse. <Todo>Prüfen, ob eine Benennungspflicht besteht (Art. 37 DSGVO, § 38 BDSG), und die Benennung bestätigen</Todo></p>
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
          Empfänger: NEAR AI Cloud, Phala, Tinfoil, Privatemode (Bochum) und RedPill (<Todo>je Firma, Sitz, AVV und ggf. Drittlandtransfer (Art. 44 ff. DSGVO) ergänzen; RedPill: nachgelagerte Anbieter nennen</Todo>).
          Im Ghost-Chat wird der Verlauf auch in Ihrem Browser nicht gespeichert.</p>
        <p>Inkognito-Modelle (optional): Modelle in der Gruppe „Incognito“ laufen nicht in einer TEE und werden nie automatisch ausgewählt. Wählen Sie eines aus, geht Ihre Nachricht
          unter unserem Konto an einen dieser Dienste; Ihre Konto-ID, Ihre IP-Adresse und Ihr Session-Token werden nicht übermittelt:</p>
        <ul>
          <li>„PRIVATE“ über Venice (Venice.ai, 1309 Coffeen Ave, Ste 14343, Sheridan, WY 82801, USA; Verarbeitung in den USA;
            <Todo>AVV mit Venice abschließen und die Garantie für die Übermittlung in die USA (z. B. Standardvertragsklauseln) eintragen; Venice nennt öffentlich keine</Todo>): Venice betreibt das Modell selbst und speichert nach eigenen Angaben weder Anfrage noch Antwort.</li>
          <li>„ANONYMIZED“ über Venice: Venice leitet die Nachricht an den jeweiligen Modellanbieter weiter (<Todo>OpenAI, Anthropic, Google u. a.: Rolle, Sitz, Aufbewahrung und Drittlandtransfer prüfen</Todo>).</li>
          <li>„ANONYMIZED“ über Liquid Inference (AI.exchange; <Todo>Firma, Sitz und Drittlandtransfer (Art. 44 ff. DSGVO) für Liquid Inference ergänzen</Todo>): Liquid vergibt die Anfrage an einen
            Anbieter auf seiner Börse. Liquid sagt in seinem Auftragsverarbeitungsvertrag (AVV) zu, keine Daten aufzubewahren; zusätzlich verlangen wir bei jeder Anfrage, dass nur Angebote ohne
            Datenaufbewahrung teilnehmen (<Todo>AVV mit Liquid: Datum eintragen; Anbieter auf Liquid: Rolle und Drittlandtransfer prüfen</Todo>).</li>
        </ul>
        <p>Diese Dienste erhalten den Inhalt Ihrer Nachricht und der Antwort, und wir können technisch nicht nachweisen, was sie damit tun. Geben Sie in diesen Chats keine Angaben ein, die Sie identifizieren.</p>
        <p>Websuche (standardmäßig an, abschaltbar): Braucht eine Frage aktuelle Informationen, darf das Modell Suchanfragen formulieren. Wo die Suche läuft, hängt vom Anbieter ab.
          Bei Modellen auf NEAR AI Cloud führt NEAR die Suche in der Enklave des Modells aus: Nur die Suchanfrage verlässt die Enklave, von dort an die Brave Search API (<Todo>Brave als Unterauftragsverarbeiter von NEAR: in der AVV mit NEAR prüfen</Todo>).
          Suchanfrage und Treffer kommen wie die Antwort durch unseren Server zu Ihnen; wir speichern und protokollieren sie nicht.
          Bei allen anderen Modellen sendet unser Server die Suchanfrage an die Brave Search API
          (<Todo>Brave Software, Inc.: Sitz, AVV und Drittlandtransfer (Art. 44 ff. DSGVO) ergänzen</Todo>). Das gilt auf jeder Datenschutzstufe, auch für Modelle in einer Enklave (Max):
          Die Suchanfrage verlässt dann die Enklave. Übermittelt wird nur der Text der Suchanfrage, nicht Ihr Chatverlauf,
          Ihre Konto-ID, Ihre IP-Adresse oder Ihr Session-Token. Die Suchanfrage kann aber Inhalte Ihrer Nachricht wiedergeben. Wir speichern und protokollieren sie nicht.
          Sie schalten die Websuche unter Einstellungen → Account → „Privacy &amp; tools“ oder im „+“-Menü der Chatleiste aus; im Ghost-Chat ist sie aus, bis Sie sie dort einschalten.
          Diese Einstellung speichern wir nur in Ihrem Browser. <Todo>Rechtsgrundlage der standardmäßig aktiven Websuche prüfen (Vorschlag: Art. 6 Abs. 1 lit. b DSGVO)</Todo></p>
        <p>Bilderzeugung (Pro und Max, nur bei eingeschalteter Websuche, nicht bei Modellen auf NEAR AI Cloud): Bitten Sie um ein Bild, darf das Modell eine Bildbeschreibung formulieren. Unser Server sendet diese Beschreibung an ein Bildmodell
          von NEAR AI Cloud, das in einer attestierten Enklave läuft, auch wenn Sie für den Chat einen anderen Anbieter gewählt haben. Übermittelt wird nur die Beschreibung, nicht Ihr Chatverlauf,
          Ihre Konto-ID, Ihre IP-Adresse oder Ihr Session-Token; die Beschreibung kann aber Inhalte Ihrer Nachricht wiedergeben. Das Bild kommt durch unseren Server zu Ihnen;
          wir speichern und protokollieren weder Beschreibung noch Bild, und auch Ihr Browser speichert das Bild nicht im Chatverlauf. <Todo>AVV mit NEAR: Bilderzeugung abgedeckt?</Todo></p>
        <p>Dateien anhängen (optional): Bilder, PDFs und Textdateien, die Sie an eine Nachricht anhängen, werden in Ihrem Browser gelesen (Bilder verkleinert, PDFs in Text umgewandelt)
          und als Teil der Nachricht an den gewählten Anbieter gesendet, genau wie getippter Text, bei Dokumenten mit dem Dateinamen. Beim Verkleinern entfallen die Metadaten der Bilder
          (z. B. EXIF-Standortangaben). Ist die Websuche an, kann das Modell auch Inhalte angehängter Dateien in Suchanfragen übernehmen. Wir speichern und protokollieren Anhänge nicht.
          In Ihrem Chatverlauf im Browser (und in Ihren verschlüsselten Backups) bleiben der Text angehängter Dokumente und die Dateinamen, von Bildern nur der Dateiname.
          <Todo>Rechtsgrundlage für Anhänge prüfen, auch für besondere Kategorien (Art. 9 DSGVO) und Daten Dritter in Bildern und Dokumenten</Todo></p>
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
        <p>Netzwerk: Alle Aufrufe von hiddensee.app laufen über Cloudflare (Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA; DNS und Cloudflare Tunnel).
          Cloudflare beendet die verschlüsselte Verbindung (TLS) und verarbeitet dabei Ihre IP-Adresse und den Inhalt der Anfragen, auch Ihre Nachrichten, auf dem Weg zu unserem Server.
          Grundlage ist das Cloudflare Data Processing Addendum (Auftragsverarbeitung, Art. 28 DSGVO); die Übermittlung in die USA stützt sich auf Cloudflares Zertifizierung unter dem
          EU-U.S. Data Privacy Framework (Art. 45 DSGVO), hilfsweise auf Standardvertragsklauseln. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (sichere Bereitstellung ohne offene Ports).
          <Todo>Annahme des Cloudflare-DPA im Cloudflare-Konto bestätigen</Todo></p>
        <h3>8. Speicherdauer</h3>
        <p>Konten ohne aktives Abo werden {RETENTION_DAYS} Tage nach der letzten Nutzung automatisch gelöscht. Zähler laufen nach spätestens 2 Tagen ab. Ändert ein Betreiber Ihr Konto (z. B. Tarif setzen, Gerät abmelden, Konto löschen), protokollieren wir Aktion, Zeitpunkt und Ihre Konto-ID {AUDIT_LOG_DAYS} Tage lang (Art. 6 Abs. 1 lit. f DSGVO, Nachvollziehbarkeit); löschen Sie Ihr Konto, wird die ID aus dem Protokoll entfernt. Einzelheiten: <a href="/privacy/metadata">/privacy/metadata</a>.
          Rechnungen zu bezahlten Tarifen (bei Stripe) werden 10 Jahre aufbewahrt (handels- und steuerrechtliche Aufbewahrungspflicht, Art. 6 Abs. 1 lit. c DSGVO). <Todo>Frist (§ 147 AO, § 257 HGB) und Rolle von Stripe rechtlich prüfen</Todo></p>
        <h3>9. Ihre Rechte</h3>
        <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) sowie auf Beschwerde bei einer Aufsichtsbehörde (Art. 77 DSGVO),
          z. B. beim Bayerischen Landesamt für Datenschutzaufsicht (BayLDA), Ansbach. Auskunft und Datenübertragbarkeit: In den Einstellungen (⚙︎) unter „Account“ laden Sie mit „Download my data“ alle bei uns gespeicherten Daten Ihres Kontos als JSON-Datei herunter. Löschung: „Delete account“ löscht Ihr Konto, Tarif, Passkeys, angemeldete Geräte und Abo-Daten sofort sowie Ihren Kundendatensatz bei Stripe (gesetzlich aufzubewahrende Rechnungen verbleiben bei Stripe). Da wir Sie nicht namentlich kennen, erfolgt die Zuordnung über Ihr Session-Cookie bzw. Ihren Passkey (Art. 11 DSGVO); senden Sie uns Ihr Session-Token nicht per E-Mail.
          Eine automatisierte Entscheidungsfindung oder Profilbildung findet nicht statt.</p>
      </Lang>
      <Lang id="en">
        <h2>Privacy policy</h2>
        <h3>1. Controller</h3>
        <p>Zoldenburg UG (haftungsbeschränkt), address see <a href="/impressum">legal notice</a>. Email: <a href="mailto:kontakt@zoldenburg.com">kontakt@zoldenburg.com</a>.
          Data protection officer: Tony Thomas, reachable at the same email address. <Todo>check whether a designation is required (Art. 37 GDPR, § 38 BDSG) and confirm it</Todo></p>
        <h3>2. Principle</h3>
        <p>We do not store chat content, IP addresses, user agents or email addresses. Your chat history lives only in your browser.
          A complete list of every stored field and its retention, checked against the code automatically, is at <a href="/privacy/metadata">/privacy/metadata</a>.</p>
        <h3>3. Using the service without an account</h3>
        <p>On first visit we create a random account id and keep it, signed, in a strictly necessary cookie (<code>pai_session</code>, § 25(2) no. 2 TDDDG).
          On the server we keep only its creation time, the day of last use, your plan, and usage counters. Legal basis: Art. 6(1)(b) GDPR (providing the service) and (f) (abuse prevention via usage limits).</p>
        <h3>4. Chat content</h3>
        <p>Your messages are relayed through our server to the selected AI provider and the reply is streamed back. Content is processed in memory only; it is never stored or logged.
          By default we only offer providers that run models in confidential computing environments (TEE) or retain no data by contract.
          Recipients: NEAR AI Cloud, Phala, Tinfoil, Privatemode (Bochum) and RedPill (<Todo>company, location, DPA and any third-country transfer (Art. 44 ff. GDPR) for each; RedPill: name the providers it forwards to</Todo>). Ghost chats are not stored even in your browser.</p>
        <p>Incognito models (optional): models in the “Incognito” group do not run in a TEE and are never selected automatically. If you pick one, your message goes
          to one of these services under our account; your account id, IP address and session token are not sent:</p>
        <ul>
          <li>“PRIVATE” via Venice (Venice.ai, 1309 Coffeen Ave, Ste 14343, Sheridan, WY 82801, USA; processed in the US;
            <Todo>sign a DPA with Venice and add the safeguard for the transfer to the US (e.g. standard contractual clauses); Venice publishes none</Todo>): Venice runs the model itself and, by its own account, stores neither the request nor the reply.</li>
          <li>“ANONYMIZED” via Venice: Venice relays the message to the model vendor (<Todo>OpenAI, Anthropic, Google etc.: confirm role, location, retention and third-country transfer</Todo>).</li>
          <li>“ANONYMIZED” via Liquid Inference (AI.exchange; <Todo>Liquid Inference company, location and third-country transfer (Art. 44 ff. GDPR)</Todo>): Liquid awards the request to a provider
            on its exchange. Liquid commits in its data processing agreement (DPA) to retain no data; on every request we also require that only offers without data retention take part
            (<Todo>DPA with Liquid: add its date; providers on Liquid: confirm role and third-country transfer</Todo>).</li>
        </ul>
        <p>These services receive the content of your message and the reply, and we cannot technically prove what they do with it. Do not enter details that identify you in these chats.</p>
        <p>Web search (on by default, can be switched off): when a question needs current information, the model may write search queries. Where the search runs depends on the provider.
          For models on NEAR AI Cloud, NEAR runs the search inside the model’s enclave: only the query leaves the enclave, from there to the Brave Search API (<Todo>Brave as NEAR’s sub-processor: confirm in the DPA with NEAR</Todo>).
          The query and the results reach you through our server like the reply; we neither store nor log them.
          For all other models, our server sends the query to the Brave Search API
          (<Todo>Brave Software, Inc.: location, DPA and third-country transfer (Art. 44 ff. GDPR)</Todo>). This applies at every privacy level, including enclave models (Max):
          the search query then leaves the enclave. Only the query text is sent, not your chat history,
          account id, IP address or session token. The query can still repeat parts of your message. We neither store nor log it.
          Switch web search off under Settings → Account → “Privacy &amp; tools” or in the chat bar’s “+” menu; in ghost chat it is off until you turn it on there.
          We keep this setting only in your browser. <Todo>Confirm the legal basis for web search being on by default (proposal: Art. 6(1)(b) GDPR)</Todo></p>
        <p>Image generation (Pro and Max, only with web search on, not for models on NEAR AI Cloud): when you ask for an image, the model may write an image description. Our server sends that description to an image model
          on NEAR AI Cloud that runs in an attested enclave, even when you picked another provider for the chat. Only the description is sent, not your chat history,
          account id, IP address or session token; the description can still repeat parts of your message. The image reaches you through our server;
          we neither store nor log the description or the image, and your browser does not keep the image in your chat history either. <Todo>DPA with NEAR: does it cover image generation?</Todo></p>
        <p>Attaching files (optional): images, PDFs and text files you attach to a message are read in your browser (images scaled down, PDFs turned into text) and sent to the
          selected provider as part of the message, just like typed text; documents go with their file name. Scaling images down drops their metadata (such as EXIF location).
          With web search on, the model may also put content from attached files into search queries. We neither store nor log attachments. Your chat history in the browser
          (and your encrypted backups) keeps the text and file names of attached documents, and only the file name of images.
          <Todo>Confirm the legal basis for attachments, including special categories (Art. 9 GDPR) and third parties&apos; data in images and documents</Todo></p>
        <h3>5. Passkeys (optional)</h3>
        <p>If you add a passkey we store its id, public key, signature counter and transport type. Biometric data never leaves your device. Each browser you sign in to gets a random device id with its creation time and the day it was last used (no device name, model or user agent); signing out or removing the device under Settings → Account deletes it. Legal basis: Art. 6(1)(b) GDPR.</p>
        <h3>6. Payments via Stripe</h3>
        <p>Paid plans are processed by Stripe (<Todo>Stripe Payments Europe, Ltd., Ireland – confirm role</Todo>). You enter payment and contact details directly with Stripe; we never receive card data.
          We store only Stripe customer and subscription ids, plan, status and period end. Events sent by Stripe can contain further details (e.g. email); we neither store nor log them.
          Legal basis: Art. 6(1)(b) and (c) GDPR.</p>
        <h3>7. Hosting and server logs</h3>
        <p>Hosting: <Todo>Hetzner Online GmbH, data centre in Germany; sign DPA</Todo>. Our application logs metadata only (route, model, status, duration, sizes as numbers), never content or IP addresses.</p>
        <p>Network: every request to hiddensee.app passes through Cloudflare (Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA; DNS and Cloudflare Tunnel).
          Cloudflare terminates the encrypted connection (TLS) and so processes your IP address and the content of requests, including your messages, on their way to our server.
          This is covered by the Cloudflare Data Processing Addendum (processing on our behalf, Art. 28 GDPR); the transfer to the US relies on Cloudflare&apos;s certification under the
          EU-U.S. Data Privacy Framework (Art. 45 GDPR), with standard contractual clauses as fallback. Legal basis: Art. 6(1)(f) GDPR (secure delivery without open ports).
          <Todo>confirm the Cloudflare DPA is accepted in the Cloudflare account</Todo></p>
        <h3>8. Retention</h3>
        <p>Accounts without an active subscription are deleted automatically {RETENTION_DAYS} days after last use. Counters expire within 2 days. If an operator changes your account (e.g. sets a plan, signs out a device, deletes the account), we log the action, its time and your account id for {AUDIT_LOG_DAYS} days (Art. 6(1)(f) GDPR, accountability); deleting your account removes the id from that log. Details: <a href="/privacy/metadata">/privacy/metadata</a>.
          Invoices for paid plans (held at Stripe) are kept for 10 years (commercial and tax retention duty, Art. 6(1)(c) GDPR). <Todo>legal review of the period (§ 147 AO, § 257 HGB) and Stripe&apos;s role</Todo></p>
        <h3>9. Your rights</h3>
        <p>You have the rights of access, rectification, erasure, restriction, portability and objection (Art. 15–21 GDPR) and may complain to a supervisory authority (Art. 77 GDPR).
          Access and portability: in Settings (⚙︎) under &quot;Account&quot;, &quot;Download my data&quot; gives you everything we store for your account as a JSON file. Erasure: &quot;Delete account&quot; immediately deletes your account, plan, passkeys, signed-in devices and subscription records, and your customer record at Stripe (invoices Stripe must keep by law remain there). As we do not know who you are, your session cookie or passkey identifies your account (Art. 11 GDPR); do not email us your session token. There is no automated decision-making or profiling.</p>
      </Lang>
    </LegalPage>
  );
}
