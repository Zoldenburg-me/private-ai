import { LegalPage, Lang, Todo, Draft, COMPANY as C } from "@/components/legal";
import { RETENTION_DAYS } from "@/lib/retention";
import { AUDIT_LOG_DAYS } from "@/lib/store/types";

export const metadata = { title: "Privacy policy / Datenschutzerklärung" };

export default function Datenschutz() {
  return (
    <LegalPage>
      <Todo>Full text needs lawyer review (GDPR, TDDDG) / Gesamten Text anwaltlich prüfen</Todo>
      <Lang id="en">
        <h1>Privacy policy</h1>
        <p>This policy explains what personal data we process when you use Hiddensee (the website hiddensee.app, the chat, the API and related services), why, on what legal basis, who receives it, and what rights you have.
          It is short because we collect very little: Hiddensee is built so that we never store what you write.</p>

        <h2>1. Controller and contact</h2>
        <p>{C.name}, {C.street}, {C.city}, Germany. Email: <a href={`mailto:${C.email}`}>{C.email}</a>, fax: <a href={C.faxHref}>{C.fax}</a>. Further details in the <a href="/impressum">legal notice</a>.</p>
        <p>Privacy and data protection contact: <a href={`mailto:${C.email}`}>{C.email}</a>. <Todo>check whether a DPO designation is required (Art. 37 GDPR, § 38 BDSG) and confirm it</Todo></p>

        <h2>2. In short</h2>
        <ul>
          <li>We do not store chat content, IP addresses, user agents or email addresses. Your chat history lives only in your browser.</li>
          <li>You can use Hiddensee without an account, name or email address.</li>
          <li>We use one strictly necessary cookie, and no analytics, tracking or advertising cookies.</li>
          <li>By default your messages go only to models that run in confidential computing environments (TEE) or whose providers retain no data by contract.</li>
          <li>A complete list of every stored field and its retention, checked against the code automatically, is at <a href="/privacy/metadata">/privacy/metadata</a>.</li>
        </ul>

        <h2>3. Using the service without an account</h2>
        <p>On first visit we create a random account id and keep it, signed, in a strictly necessary cookie (<code>pai_session</code>, § 25(2) no. 2 TDDDG).
          On the server we keep only its creation time, the day of last use, your plan, and usage counters. Legal basis: Art. 6(1)(b) GDPR (providing the service) and (f) (abuse prevention via usage limits).</p>

        <h2>4. Chat content and AI providers</h2>
        <p>Your messages are relayed through our server to the selected AI provider and the reply is streamed back. Content is processed in memory only; it is never stored or logged.
          By default we only offer providers that run models in confidential computing environments (TEE) or retain no data by contract.
          Recipients: NEAR AI Cloud, Phala, Tinfoil, Privatemode (Bochum) and RedPill<Todo>company, location, DPA and any third-country transfer (Art. 44 ff. GDPR) for each; RedPill: name the providers it forwards to</Todo>. Ghost chats are not stored even in your browser.</p>
        <h3>Incognito models (optional)</h3>
        <p>Incognito models (optional): models in the “Incognito” group do not run in a TEE and are never selected automatically. If you pick one, your message goes
          to one of these services under our account; your account id, IP address and session token are not sent:</p>
        <ul>
          <li>“PRIVATE” via Venice (Venice.ai, 1309 Coffeen Ave, Ste 14343, Sheridan, WY 82801, USA; processed in the US)<Todo>sign a DPA with Venice and add the safeguard for the transfer to the US (e.g. standard contractual clauses); Venice publishes none</Todo>: Venice runs the model itself and, by its own account, stores neither the request nor the reply.</li>
          <li>“ANONYMIZED” via Venice: Venice relays the message to the model vendor<Todo>OpenAI, Anthropic, Google etc.: confirm role, location, retention and third-country transfer</Todo>.</li>
          <li>“ANONYMIZED” via Liquid Inference (AI.exchange)<Todo>Liquid Inference company, location and third-country transfer (Art. 44 ff. GDPR)</Todo>: Liquid awards the request to a provider
            on its exchange. Liquid commits in its data processing agreement (DPA) to retain no data; on every request we also require that only offers without data retention take part
           <Todo>DPA with Liquid: add its date; providers on Liquid: confirm role and third-country transfer</Todo>.</li>
        </ul>
        <p>These services receive the content of your message and the reply, and we cannot technically prove what they do with it. Do not enter details that identify you in these chats.</p>
        <h3>Web search</h3>
        <p>Web search (on by default, can be switched off): when a question needs current information, the model may write search queries.
          For models on NEAR AI Cloud, NEAR runs the search inside the model’s enclave and sends only the query to the Brave Search API<Todo>Brave as NEAR’s sub-processor: confirm in the DPA with NEAR</Todo>.
          For all other models (including enclave models), our server sends the query to the Brave Search API<Todo>Brave Software, Inc.: location, DPA and third-country transfer (Art. 44 ff. GDPR)</Todo>, so the search query leaves the enclave.
          Only the query text is sent, not your chat history, account id, IP address or session token, though the query may repeat parts of your message. We neither store nor log queries or results. Switch web search off under Settings → Account → “Privacy &amp; tools” or in the chat bar’s “+” menu; in ghost chat it is off until you turn it on there. We keep this setting only in your browser. <Todo>Confirm the legal basis for web search being on by default (proposal: Art. 6(1)(b) GDPR)</Todo></p>
        <h3>Image generation</h3>
        <p>Image generation (Pro and Max, only with web search on, not for models on NEAR AI Cloud): when you ask for an image, the model writes an image description that our server sends to an attested enclave image model on NEAR AI Cloud, even when you picked another provider for the chat.
          Only the description is sent, not your chat history, account id, IP address or session token; the description can still repeat parts of your message. Neither our server nor your browser’s chat history stores the description or the image. <Todo>DPA with NEAR: does it cover image generation?</Todo></p>
<h3>Video generation</h3>
        <p>Video generation (paid plans, Anon level only, with web search on; paid from your credit, about €1.25 per clip): when you ask for a video, the model may write a video description.
          Our server sends that description to Black Forest Labs’ FLUX 3 Video API (EU endpoint) under our own account; this runs outside an enclave, like the other Anon models.
          Only the description is sent, not your chat history, account id, IP address or session token; the description can still repeat parts of your message. The clip reaches you through our server;
          we neither store nor log the description or the clip, and your browser does not keep the clip in your chat history either. <Todo>Black Forest Labs: company, location, DPA, retention of prompts and outputs, any third-country transfer (Art. 44 ff. GDPR)</Todo></p>
        <h3>Attachments</h3>
        <p>Attaching files (optional): images, PDFs and text files you attach are processed in your browser (images scaled down without EXIF metadata, PDFs converted to text) and sent to the selected provider as part of your message.
          With web search on, the model may also put content from attached files into search queries. We neither store nor log attachments on our server; your browser’s local history and encrypted backups keep document text and file names.
          <Todo>Confirm the legal basis for attachments, including special categories (Art. 9 GDPR) and third parties&apos; data in images and documents</Todo></p>
        <p>We do not use your messages, replies or attachments to train or improve AI models, and we do not allow the providers above to do so. <Todo>confirm no-training commitments in each provider&apos;s DPA</Todo></p>

        <h2>5. Passkeys and signed-in devices (optional)</h2>
        <p>If you add a passkey we store its id, public key, signature counter and transport type. Biometric data never leaves your device. Each browser you sign in to gets a random device id with its creation time and the day it was last used (no device name, model or user agent); signing out or removing the device under Settings → Account deletes it. Legal basis: Art. 6(1)(b) GDPR.</p>

        <h2>6. Payments</h2>
        <p>Paid plans are processed by Stripe<Todo>Stripe Payments Europe, Ltd., Ireland – confirm role as controller or processor</Todo>. You enter payment and contact details directly with Stripe; we never receive card data.
          We store only Stripe customer and subscription ids, plan, status and period end. Events sent by Stripe can contain further details (e.g. email); we neither store nor log them.
          Legal basis: Art. 6(1)(b) and (c) GDPR. Stripe&apos;s privacy notice: <a href="https://stripe.com/privacy" rel="noopener noreferrer">stripe.com/privacy</a>.</p>
        <Draft><p>Crypto payments run through Zold (<a href="https://zoldhq.com" rel="noopener noreferrer">zoldhq.com</a>), a service of {C.name}. To match a payment to your plan we keep the transaction id, amount, asset, network and the plan it pays for, linked to your account id; we do not ask for your name or email.
          Public blockchains record every transaction, including the sending address, permanently and visibly to anyone; neither we nor anyone else can delete it.
          Legal basis: Art. 6(1)(b) and (c) GDPR. <Todo>crypto: stored fields into lib/data-inventory.ts once built; Monerium as recipient for euro payouts; retention (§ 147 AO); AML/MiCA duties</Todo></p></Draft>

        <h2>7. Hosting, network and server logs</h2>
        <p>Hosting: we run our own server in Germany; no hosting provider processes data for us. <Todo>confirm server location and physical security measures</Todo> Our application logs metadata only (route, model, status, duration, sizes as numbers), never content or IP addresses.</p>
        <p>Network: every request to hiddensee.app passes through Cloudflare (Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA; DNS and Cloudflare Tunnel).
          Cloudflare terminates the encrypted connection (TLS) and so processes your IP address and the content of requests, including your messages, on their way to our server.
          This is covered by the Cloudflare Data Processing Addendum (processing on our behalf, Art. 28 GDPR); the transfer to the US relies on Cloudflare&apos;s certification under the
          EU-U.S. Data Privacy Framework (Art. 45 GDPR), with standard contractual clauses as fallback. Legal basis: Art. 6(1)(f) GDPR (secure delivery without open ports).
          <Todo>confirm the Cloudflare DPA is accepted in the Cloudflare account</Todo></p>

        <h2>8. Cookies and local storage</h2>
        <p>We set one cookie, <code>pai_session</code>, which is strictly necessary to provide the service (§ 25(2) no. 2 TDDDG) and needs no consent. Your chats, personas and settings are kept in your browser&apos;s local storage and never reach our server, except a message you send.
          We use no analytics, tracking, advertising or third-party cookies, so there is no cookie banner. Fonts and scripts are served from our own domain.</p>

        <h2>9. Recipients and transfers outside the EU</h2>
        <p>We do not sell or rent personal data and share it only with the recipients named in this policy, as far as needed for the purpose described: the AI providers and search provider you use (section 4), Stripe<Draft> and Zold</Draft> (section 6) and Cloudflare (section 7), and authorities where the law requires it.
          Where a recipient is outside the EU/EEA (in particular in the US), the transfer relies on an adequacy decision such as the EU-U.S. Data Privacy Framework (Art. 45 GDPR) or on standard contractual clauses (Art. 46 GDPR), as stated for each recipient above.</p>

        <h2>10. Retention</h2>
        <p>Accounts without an active subscription are deleted automatically {RETENTION_DAYS} days after last use. Counters expire within 2 days. If an operator changes your account (e.g. sets a plan, signs out a device, deletes the account), we log the action, its time and your account id for {AUDIT_LOG_DAYS} days (Art. 6(1)(f) GDPR, accountability); deleting your account removes the id from that log. Details: <a href="/privacy/metadata">/privacy/metadata</a>.
          Invoices for paid plans (held at Stripe) are kept for 10 years (commercial and tax retention duty, Art. 6(1)(c) GDPR). <Todo>legal review of the period (§ 147 AO, § 257 HGB) and Stripe&apos;s role</Todo></p>

        <h2>11. Security</h2>
        <p>All connections are encrypted (TLS, HSTS). Default models run in hardware-isolated enclaves whose attestation you can check in the chat. Our server is reachable only through Cloudflare Tunnel, without open ports, and stores no chat content that could be leaked.
          No system is completely secure, however, and we cannot guarantee the confidentiality of data under all circumstances.</p>

        <h2>12. Your rights</h2>
        <p>You have the rights of access, rectification, erasure, restriction, portability and objection (Art. 15–21 GDPR) and may withdraw any consent with effect for the future (Art. 7(3) GDPR).
          You may complain to a supervisory authority (Art. 77 GDPR), e.g. the Bavarian Data Protection Authority (BayLDA), Ansbach.</p>
        <p>Access and portability: in Settings (⚙︎) under “Account”, “Download my data” gives you everything we store for your account as a JSON file. Erasure: “Delete account” immediately deletes your account, plan, passkeys, signed-in devices and subscription records, and your customer record at Stripe (invoices Stripe must keep by law remain there).
          As we do not know who you are, your session cookie or passkey identifies your account (Art. 11 GDPR); do not email us your session token. There is no automated decision-making or profiling.</p>

        <h2>13. Children</h2>
        <p>Hiddensee is not directed at children. You must be at least 18 years old to use it. <Todo>confirm minimum age (Art. 8 GDPR, § 1 terms)</Todo></p>

        <h2>14. Changes to this policy</h2>
        <p>We update this policy when the service or the law changes. The current version is always on this page; we announce material changes in the app before they take effect.</p>
        <p style={{ fontSize: 13, opacity: 0.8 }}>Last updated: 26 October 2026</p>
      </Lang>

      <Lang id="de">
        <h1>Datenschutzerklärung</h1>
        <p>Diese Erklärung beschreibt, welche personenbezogenen Daten wir verarbeiten, wenn Sie Hiddensee nutzen (die Website hiddensee.app, den Chat, die API und zugehörige Dienste), zu welchem Zweck, auf welcher Rechtsgrundlage, wer sie erhält und welche Rechte Sie haben.
          Sie ist kurz, weil wir sehr wenig erheben: Hiddensee ist so gebaut, dass wir nie speichern, was Sie schreiben.</p>

        <h2>1. Verantwortlicher und Kontakt</h2>
        <p>{C.name}, {C.street}, {C.city}, Deutschland. E-Mail: <a href={`mailto:${C.email}`}>{C.email}</a>, Fax: <a href={C.faxHref}>{C.fax}</a>. Weitere Angaben im <a href="/impressum">Impressum</a>.</p>
        <p>Datenschutzkontakt: <a href={`mailto:${C.email}`}>{C.email}</a>. <Todo>Prüfen, ob eine Benennungspflicht besteht (Art. 37 DSGVO, § 38 BDSG), und die Benennung bestätigen</Todo></p>

        <h2>2. Das Wichtigste in Kürze</h2>
        <ul>
          <li>Wir speichern keine Chat-Inhalte, keine IP-Adressen, keine User-Agents und keine E-Mail-Adressen. Ihr Chatverlauf liegt nur in Ihrem Browser.</li>
          <li>Sie können Hiddensee ohne Konto, Namen oder E-Mail-Adresse nutzen.</li>
          <li>Wir verwenden ein technisch notwendiges Cookie und keine Analyse-, Tracking- oder Werbe-Cookies.</li>
          <li>Standardmäßig gehen Ihre Nachrichten nur an Modelle in vertraulichen Rechenumgebungen (TEE) oder an Anbieter, die vertraglich keine Daten aufbewahren.</li>
          <li>Eine vollständige, automatisch mit dem Code abgeglichene Liste aller gespeicherten Felder und Fristen finden Sie unter <a href="/privacy/metadata">/privacy/metadata</a>.</li>
        </ul>

        <h2>3. Nutzung ohne Konto</h2>
        <p>Beim ersten Aufruf erzeugen wir eine zufällige Konto-ID und legen sie signiert in einem technisch notwendigen Cookie (<code>pai_session</code>) ab
          (§ 25 Abs. 2 Nr. 2 TDDDG). Auf dem Server speichern wir zu dieser ID nur Erstellungszeitpunkt, Tag der letzten Nutzung, Tarif und Zähler für die Nutzungsgrenzen.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des Dienstes) und lit. f (Missbrauchsschutz durch Nutzungsgrenzen).</p>

        <h2>4. Chat-Inhalte und KI-Anbieter</h2>
        <p>Ihre Nachrichten werden über unseren Server an den gewählten KI-Anbieter weitergeleitet und die Antwort zurückgestreamt. Inhalte werden dabei nur im Arbeitsspeicher
          verarbeitet, weder gespeichert noch protokolliert. Standardmäßig nutzen wir nur Anbieter, deren Modelle in vertraulichen Rechenumgebungen (TEE) laufen oder die vertraglich keine Daten aufbewahren.
          Empfänger: NEAR AI Cloud, Phala, Tinfoil, Privatemode (Bochum) und RedPill<Todo>je Firma, Sitz, AVV und ggf. Drittlandtransfer (Art. 44 ff. DSGVO) ergänzen; RedPill: nachgelagerte Anbieter nennen</Todo>.
          Im Ghost-Chat wird der Verlauf auch in Ihrem Browser nicht gespeichert.</p>
        <h3>Inkognito-Modelle (optional)</h3>
        <p>Inkognito-Modelle (optional): Modelle in der Gruppe „Incognito“ laufen nicht in einer TEE und werden nie automatisch ausgewählt. Wählen Sie eines aus, geht Ihre Nachricht
          unter unserem Konto an einen dieser Dienste; Ihre Konto-ID, Ihre IP-Adresse und Ihr Session-Token werden nicht übermittelt:</p>
        <ul>
          <li>„PRIVATE“ über Venice (Venice.ai, 1309 Coffeen Ave, Ste 14343, Sheridan, WY 82801, USA; Verarbeitung in den USA)<Todo>AVV mit Venice abschließen und die Garantie für die Übermittlung in die USA (z. B. Standardvertragsklauseln) eintragen; Venice nennt öffentlich keine</Todo>: Venice betreibt das Modell selbst und speichert nach eigenen Angaben weder Anfrage noch Antwort.</li>
          <li>„ANONYMIZED“ über Venice: Venice leitet die Nachricht an den jeweiligen Modellanbieter weiter<Todo>OpenAI, Anthropic, Google u. a.: Rolle, Sitz, Aufbewahrung und Drittlandtransfer prüfen</Todo>.</li>
          <li>„ANONYMIZED“ über Liquid Inference (AI.exchange)<Todo>Firma, Sitz und Drittlandtransfer (Art. 44 ff. DSGVO) für Liquid Inference ergänzen</Todo>: Liquid vergibt die Anfrage an einen
            Anbieter auf seiner Börse. Liquid sagt in seinem Auftragsverarbeitungsvertrag (AVV) zu, keine Daten aufzubewahren; zusätzlich verlangen wir bei jeder Anfrage, dass nur Angebote ohne
            Datenaufbewahrung teilnehmen<Todo>AVV mit Liquid: Datum eintragen; Anbieter auf Liquid: Rolle und Drittlandtransfer prüfen</Todo>.</li>
        </ul>
        <p>Diese Dienste erhalten den Inhalt Ihrer Nachricht und der Antwort, und wir können technisch nicht nachweisen, was sie damit tun. Geben Sie in diesen Chats keine Angaben ein, die Sie identifizieren.</p>
        <h3>Websuche</h3>
        <p>Websuche (standardmäßig an, abschaltbar): Braucht eine Frage aktuelle Informationen, darf das Modell Suchanfragen formulieren.
          Bei Modellen auf NEAR AI Cloud führt NEAR die Suche in der Enklave des Modells aus und sendet nur die Suchanfrage an die Brave Search API<Todo>Brave als Unterauftragsverarbeiter von NEAR: in der AVV mit NEAR prüfen</Todo>.
          Bei allen anderen Modellen (auch Modellen in einer Enklave) sendet unser Server die Suchanfrage an die Brave Search API<Todo>Brave Software, Inc.: Sitz, AVV und Drittlandtransfer (Art. 44 ff. DSGVO) ergänzen</Todo>; die Suchanfrage verlässt dann die Enklave.
          Übermittelt wird nur der Text der Suchanfrage, nicht Ihr Chatverlauf, Ihre Konto-ID, Ihre IP-Adresse oder Ihr Session-Token, wobei die Suchanfrage Inhalte Ihrer Nachricht wiedergeben kann. Wir speichern und protokollieren weder Suchanfragen noch Treffer. Sie schalten die Websuche unter Einstellungen → Account → „Privacy &amp; tools“ oder im „+“-Menü der Chatleiste aus; im Ghost-Chat ist sie aus, bis Sie sie dort einschalten. Diese Einstellung speichern wir nur in Ihrem Browser. <Todo>Rechtsgrundlage der standardmäßig aktiven Websuche prüfen (Vorschlag: Art. 6 Abs. 1 lit. b DSGVO)</Todo></p>
        <h3>Bilderzeugung</h3>
        <p>Bilderzeugung (Pro und Max, nur bei eingeschalteter Websuche, nicht bei Modellen auf NEAR AI Cloud): Bitten Sie um ein Bild, formuliert das Modell eine Bildbeschreibung, die unser Server an ein Bildmodell von NEAR AI Cloud in einer attestierten Enklave sendet, auch wenn Sie für den Chat einen anderen Anbieter gewählt haben.
          Übermittelt wird nur die Beschreibung, nicht Ihr Chatverlauf, Ihre Konto-ID, Ihre IP-Adresse oder Ihr Session-Token; die Beschreibung kann aber Inhalte Ihrer Nachricht wiedergeben. Weder unser Server noch Ihr Chatverlauf im Browser speichert Beschreibung oder Bild. <Todo>AVV mit NEAR: Bilderzeugung abgedeckt?</Todo></p>
<h3>Videoerzeugung</h3>
        <p>Videoerzeugung (bezahlte Tarife, nur in der Stufe Anon, bei eingeschalteter Websuche; bezahlt aus Ihrem Guthaben, etwa 1,25 € pro Clip): Bitten Sie um ein Video, darf das Modell eine Videobeschreibung formulieren.
          Unser Server sendet diese Beschreibung unter unserem eigenen Konto an die FLUX-3-Video-API von Black Forest Labs (EU-Endpunkt); das läuft wie die übrigen Anon-Modelle außerhalb einer Enklave.
          Übermittelt wird nur die Beschreibung, nicht Ihr Chatverlauf, Ihre Konto-ID, Ihre IP-Adresse oder Ihr Session-Token; die Beschreibung kann aber Inhalte Ihrer Nachricht wiedergeben. Der Clip kommt durch unseren Server zu Ihnen;
          wir speichern und protokollieren weder Beschreibung noch Clip, und auch Ihr Browser speichert den Clip nicht im Chatverlauf. <Todo>Black Forest Labs: Firma, Sitz, AVV, Speicherdauer von Prompts und Ergebnissen, ggf. Drittlandtransfer (Art. 44 ff. DSGVO)</Todo></p>
        <h3>Dateianhänge</h3>
        <p>Dateien anhängen (optional): Bilder, PDFs und Textdateien werden in Ihrem Browser verarbeitet (Bilder ohne EXIF-Metadaten verkleinert, PDFs in Text umgewandelt) und als Teil Ihrer Nachricht an den gewählten Anbieter gesendet.
          Ist die Websuche an, kann das Modell auch Inhalte angehängter Dateien in Suchanfragen übernehmen. Wir speichern und protokollieren Anhänge nicht auf unserem Server; Ihr lokaler Verlauf und verschlüsselte Backups enthalten Dokumententext und Dateinamen.
          <Todo>Rechtsgrundlage für Anhänge prüfen, auch für besondere Kategorien (Art. 9 DSGVO) und Daten Dritter in Bildern und Dokumenten</Todo></p>
        <p>Wir nutzen Ihre Nachrichten, Antworten und Anhänge nicht, um KI-Modelle zu trainieren oder zu verbessern, und gestatten dies auch den oben genannten Anbietern nicht. <Todo>Trainingsverzicht in den AVV der Anbieter bestätigen</Todo></p>

        <h2>5. Passkeys und angemeldete Geräte (optional)</h2>
        <p>Wenn Sie einen Passkey hinzufügen, speichern wir dessen ID, den öffentlichen Schlüssel, einen Signaturzähler und die Verbindungsart. Biometrische Daten verlassen Ihr Gerät nicht. Für jeden Browser, in dem Sie sich anmelden, speichern wir eine zufällige Geräte-ID mit Erstellungszeitpunkt und dem Tag der letzten Nutzung (kein Gerätename, Modell oder User-Agent); Abmelden oder Entfernen des Geräts unter Einstellungen → Account löscht sie.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>

        <h2>6. Zahlungen</h2>
        <p>Bezahlte Tarife werden über Stripe abgewickelt<Todo>Stripe Payments Europe, Ltd., Irland – Rolle als eigener Verantwortlicher/Auftragsverarbeiter prüfen</Todo>.
          Zahlungs- und Kontaktdaten geben Sie direkt bei Stripe ein; wir erhalten keine Kartendaten. Wir speichern nur Stripe-Kunden- und Abo-ID, Tarif, Status und Laufzeitende.
          Von Stripe gesendete Ereignisse können weitere Angaben (z. B. E-Mail) enthalten; diese werden weder gespeichert noch protokolliert.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b und c DSGVO. Datenschutzhinweise von Stripe: <a href="https://stripe.com/de/privacy" rel="noopener noreferrer">stripe.com/de/privacy</a>.</p>
        <Draft><p>Kryptozahlungen laufen über Zold (<a href="https://zoldhq.com" rel="noopener noreferrer">zoldhq.com</a>), einen Dienst der {C.name}. Um eine Zahlung Ihrem Tarif zuzuordnen, speichern wir Transaktions-ID, Betrag, Kryptowert, Netzwerk und den bezahlten Tarif zu Ihrer Konto-ID; Namen oder E-Mail-Adresse fragen wir nicht ab.
          Öffentliche Blockchains verzeichnen jede Transaktion einschließlich der Absenderadresse dauerhaft und für jeden einsehbar; weder wir noch sonst jemand können sie löschen.
          Rechtsgrundlage: Art. 6 Abs. 1 lit. b und c DSGVO. <Todo>Krypto: gespeicherte Felder nach Umsetzung in lib/data-inventory.ts; Monerium als Empfänger bei Euro-Auszahlung; Aufbewahrung (§ 147 AO); GwG/MiCA-Pflichten</Todo></p></Draft>

        <h2>7. Hosting, Netzwerk und Server-Logs</h2>
        <p>Hosting: Wir betreiben einen eigenen Server in Deutschland; kein Hosting-Anbieter verarbeitet Daten in unserem Auftrag. <Todo>Serverstandort und physische Sicherungsmaßnahmen bestätigen</Todo> Unsere Anwendung protokolliert nur Metadaten (Route, Modell, Status, Dauer, Längen als Zahlen), nie Inhalte oder IP-Adressen.</p>
        <p>Netzwerk: Alle Aufrufe von hiddensee.app laufen über Cloudflare (Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA; DNS und Cloudflare Tunnel).
          Cloudflare beendet die verschlüsselte Verbindung (TLS) und verarbeitet dabei Ihre IP-Adresse und den Inhalt der Anfragen, auch Ihre Nachrichten, auf dem Weg zu unserem Server.
          Grundlage ist das Cloudflare Data Processing Addendum (Auftragsverarbeitung, Art. 28 DSGVO); die Übermittlung in die USA stützt sich auf Cloudflares Zertifizierung unter dem
          EU-U.S. Data Privacy Framework (Art. 45 DSGVO), hilfsweise auf Standardvertragsklauseln. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (sichere Bereitstellung ohne offene Ports).
          <Todo>Annahme des Cloudflare-DPA im Cloudflare-Konto bestätigen</Todo></p>

        <h2>8. Cookies und lokale Speicherung</h2>
        <p>Wir setzen ein Cookie, <code>pai_session</code>, das für die Bereitstellung des Dienstes technisch notwendig ist (§ 25 Abs. 2 Nr. 2 TDDDG) und keine Einwilligung erfordert. Ihre Chats, Personas und Einstellungen liegen im lokalen Speicher Ihres Browsers und erreichen unseren Server nicht, außer einer Nachricht, die Sie absenden.
          Wir verwenden keine Analyse-, Tracking-, Werbe- oder Drittanbieter-Cookies, daher gibt es kein Cookie-Banner. Schriften und Skripte liefern wir von unserer eigenen Domain aus.</p>

        <h2>9. Empfänger und Übermittlung in Drittländer</h2>
        <p>Wir verkaufen oder vermieten keine personenbezogenen Daten und geben sie nur an die in dieser Erklärung genannten Empfänger weiter, soweit der beschriebene Zweck es erfordert: die von Ihnen genutzten KI- und Suchanbieter (Abschnitt 4), Stripe<Draft> und Zold</Draft> (Abschnitt 6) und Cloudflare (Abschnitt 7) sowie Behörden, wenn das Gesetz es verlangt.
          Sitzt ein Empfänger außerhalb der EU/des EWR (insbesondere in den USA), stützt sich die Übermittlung auf einen Angemessenheitsbeschluss wie das EU-U.S. Data Privacy Framework (Art. 45 DSGVO) oder auf Standardvertragsklauseln (Art. 46 DSGVO), wie oben je Empfänger angegeben.</p>

        <h2>10. Speicherdauer</h2>
        <p>Konten ohne aktives Abo werden {RETENTION_DAYS} Tage nach der letzten Nutzung automatisch gelöscht. Zähler laufen nach spätestens 2 Tagen ab. Ändert ein Betreiber Ihr Konto (z. B. Tarif setzen, Gerät abmelden, Konto löschen), protokollieren wir Aktion, Zeitpunkt und Ihre Konto-ID {AUDIT_LOG_DAYS} Tage lang (Art. 6 Abs. 1 lit. f DSGVO, Nachvollziehbarkeit); löschen Sie Ihr Konto, wird die ID aus dem Protokoll entfernt. Einzelheiten: <a href="/privacy/metadata">/privacy/metadata</a>.
          Rechnungen zu bezahlten Tarifen (bei Stripe) werden 10 Jahre aufbewahrt (handels- und steuerrechtliche Aufbewahrungspflicht, Art. 6 Abs. 1 lit. c DSGVO). <Todo>Frist (§ 147 AO, § 257 HGB) und Rolle von Stripe rechtlich prüfen</Todo></p>

        <h2>11. Datensicherheit</h2>
        <p>Alle Verbindungen sind verschlüsselt (TLS, HSTS). Standardmodelle laufen in hardwareisolierten Enklaven, deren Attestierung Sie im Chat prüfen können. Unser Server ist nur über Cloudflare Tunnel ohne offene Ports erreichbar und speichert keine Chat-Inhalte, die abfließen könnten.
          Kein System ist jedoch vollständig sicher; die Vertraulichkeit von Daten können wir nicht unter allen Umständen garantieren.</p>

        <h2>12. Ihre Rechte</h2>
        <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) und können eine Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3 DSGVO).
          Sie können sich bei einer Aufsichtsbehörde beschweren (Art. 77 DSGVO), z. B. beim Bayerischen Landesamt für Datenschutzaufsicht (BayLDA), Ansbach.</p>
        <p>Auskunft und Datenübertragbarkeit: In den Einstellungen (⚙︎) unter „Account“ laden Sie mit „Download my data“ alle bei uns gespeicherten Daten Ihres Kontos als JSON-Datei herunter. Löschung: „Delete account“ löscht Ihr Konto, Tarif, Passkeys, angemeldete Geräte und Abo-Daten sofort sowie Ihren Kundendatensatz bei Stripe (gesetzlich aufzubewahrende Rechnungen verbleiben bei Stripe).
          Da wir Sie nicht namentlich kennen, erfolgt die Zuordnung über Ihr Session-Cookie bzw. Ihren Passkey (Art. 11 DSGVO); senden Sie uns Ihr Session-Token nicht per E-Mail. Eine automatisierte Entscheidungsfindung oder Profilbildung findet nicht statt.</p>

        <h2>13. Kinder</h2>
        <p>Hiddensee richtet sich nicht an Kinder. Für die Nutzung müssen Sie mindestens 18 Jahre alt sein. <Todo>Mindestalter bestätigen (Art. 8 DSGVO, § 1 AGB)</Todo></p>

        <h2>14. Änderungen dieser Erklärung</h2>
        <p>Wir passen diese Erklärung an, wenn sich der Dienst oder die Rechtslage ändert. Die aktuelle Fassung steht immer auf dieser Seite; wesentliche Änderungen kündigen wir vor ihrem Inkrafttreten in der App an.</p>
        <p style={{ fontSize: 13, opacity: 0.8 }}>Stand: 26. Oktober 2026</p>
      </Lang>
    </LegalPage>
  );
}
