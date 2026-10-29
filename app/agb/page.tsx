import { LegalPage, Lang, Todo, Draft, COMPANY as C } from "@/components/legal";
import { TIERS, planLines, type TierId } from "@/lib/tiers";

export const metadata = { title: "Terms of service / AGB" };
const eur = (n: number) => `${n} €`;
const IDS: TierId[] = ["free", "plus", "pro", "max"];
const de = (n: number) => n.toLocaleString("de");
/** German counterpart of planLines() in lib/tiers.ts, from the same TIERS numbers. */
function planLinesDe(id: TierId): string[] {
  const t = TIERS[id];
  return [
    `${de(t.dailyMessages)} Max-Privacy-Nachrichten pro Tag`,
    ...(t.topDailyMessages ? [`${de(t.topDailyMessages)} Nachrichten mit Top-Max-Privacy-Modellen pro Tag`] : []),
    `${de(t.incognitoDailyMessages)} Private- und Incognito-Nachrichten pro Tag`,
    t.includedCreditsEur ? `${t.includedCreditsEur} € Frontier-Guthaben pro Monat, danach nutzungsabhängig` : "Top-Frontier-Modelle nur in bezahlten Tarifen",
    `${t.maxContextTokens >= 1_000_000 ? `${t.maxContextTokens / 1_000_000} Mio.` : `${t.maxContextTokens / 1000}k`} Token Kontext, Agent mit ${t.agentMaxSteps} Schritten`,
  ];
}

export default function Agb() {
  return (
    <LegalPage>
      <Todo>Full text needs lawyer review, esp. withdrawal, liability, prices / Gesamten Text anwaltlich prüfen, insb. Widerrufsrecht, Haftung, Preisangaben</Todo>
      <Lang id="en">
        <h1>Terms of service</h1>

        <h2>1. Scope and provider</h2>
        <p>These terms govern the use of Hiddensee (the website hiddensee.app, the chat and the API, together the “service”), provided by {C.name}, {C.street}, {C.city}, Germany (“we”).
          Your own terms do not apply unless we agree to them in writing.</p>
        <p>You must be at least 18 years old to use the service. If you use it on behalf of an organisation, you confirm that you may bind it to these terms. <Todo>confirm minimum age; B2B use</Todo></p>

        <h2>2. Account and access</h2>
        <p>You can use the service without registering: a random account id in a cookie identifies you. You can add a passkey to use your account on several devices.
          Keep your devices, passkeys, session and any API keys secure and do not share them; you are responsible for use of your account. Tell us at <a href={`mailto:${C.email}`}>{C.email}</a> if you suspect misuse.</p>

        <h2>3. The service and its availability</h2>
        <p>We provide an AI chat that relays requests to models running in confidential computing environments or at providers that retain no data. Replies are generated automatically.
          We provide the service with reasonable care but do not promise that it is available without interruption or free of errors. We may change, add or remove models, providers and features if this is reasonable for you, in particular to keep the service secure, lawful or working;
          we do not reduce the core of a paid plan during its current term. Registration may require an invite code. <Todo>availability commitment / maintenance windows</Todo></p>
        <p>Third-party providers: we do not run the AI models, the enclaves or the hardware they run on. They are operated by independent providers, which the <a href="/datenschutz">privacy policy</a> names.
          We select the providers and relay your requests, and for providers that run models in an enclave you can check the attestation in the chat, but we have no control over their infrastructure; their availability and performance are outside our control. <Todo>liability for providers as vicarious agents (§ 278 BGB): lawyer to confirm</Todo></p>

        <h2>4. Confidentiality</h2>
        <p>The service is designed so that we cannot read what you write: we never store chat content, and default models run in hardware-isolated enclaves, operated by the providers above, whose attestation you can check.
          Metadata (such as which model you use, when and how much) does not have the same protection. “Incognito” models do not run in an enclave and are offered only when you pick them.
          We take the measures described in the <a href="/datenschutz">privacy policy</a>, but we cannot guarantee the confidentiality of data under all circumstances.</p>

        <h2>5. AI output</h2>
        <p>AI replies can be wrong, incomplete, outdated or offensive, and the same question can get different answers. Check important replies yourself before relying on them.
          Replies are not legal, tax, medical, financial or other professional advice. You decide how you use them and are responsible for that use.</p>

        <h2>6. Your content</h2>
        <p>What you enter (“input”) and the replies you receive (“output”) belong to you as far as the law allows; we claim no rights to them and do not use them to train models.
          You are responsible for having the rights to your input and for not infringing the rights of others. Output can be similar to output other users receive.</p>

        <h2>7. Acceptable use</h2>
        <p>You must not use the service to:</p>
        <ul>
          <li>break the law or infringe the rights of others, or create or spread unlawful content, including material depicting the sexual abuse of children;</li>
          <li>harass, threaten, defraud or deceive people, or pass off AI output as written by a human where this misleads;</li>
          <li>develop malware, attack the service or other systems, or probe them for vulnerabilities without our consent;</li>
          <li>circumvent usage limits or security measures, share or resell access, or run bulk automated requests beyond the documented API limits;</li>
          <li>break the usage policies of the model providers.</li>
        </ul>
        <p>If you break these rules we may suspend or end your access (section 11).</p>

        <h2>8. Plans and prices</h2>
        <ul>
          {IDS.map((id) => <li key={id}>{TIERS[id].name}: {TIERS[id].priceEurMonth ? `${eur(TIERS[id].priceEurMonth)} per month` : "free"}<Draft>, also billed yearly</Draft><Todo>annual price</Todo>; {planLines(id).join("; ")}.</li>)}
        </ul>
        <p>Paid plans differ only in their limits; daily numbers are fair-use limits. Selected top models are paid from credit: every plan includes a monthly credit that lapses at the end of the month; bought credit does not expire. Credit is not transferable and is not paid out. <Todo>credit terms (expiry, refund on cancellation, price per model)</Todo></p>
        <p>All prices include statutory VAT. <Todo>VAT treatment (incl./excl., OSS)</Todo> We announce price changes for subscriptions at least 30 days before they take effect; you can cancel before then. <Todo>price change clause</Todo></p>

        <Draft>
          <h3>Crypto payments</h3>
          <p>You can also pay with crypto assets (such as stablecoins) through Zold (<a href="https://zoldhq.com" rel="noopener noreferrer">zoldhq.com</a>), a service of {C.name}. Prices stay in euros; the amount due in the crypto asset is fixed when you pay.
            Crypto payments are final once confirmed on the blockchain: check the network, address and amount before sending, as we cannot reverse a payment sent to a wrong address or on a wrong network. Refunds, where owed, are paid to a wallet you name, in the same asset or in euros.
            <Todo>crypto terms: assets/networks, exchange-rate fixing, refunds, Monerium/e-money role, MiCA/AML</Todo></p>
        </Draft>

        <h2>9. Contract, term, cancellation</h2>
        <p>A paid plan starts when payment completes, at Stripe or, for crypto payments, at Zold and renews for the chosen period until cancelled. You can cancel at any time, effective at the end of the period, via “Manage subscription” (Stripe customer portal).
          If a payment fails, we may move your account to the free plan until it is paid. <Todo>cancellation button under § 312k BGB</Todo></p>

        <h2>10. Right of withdrawal (consumers)</h2>
        <p>Consumers have a statutory right of withdrawal. We publish the withdrawal notice and the model withdrawal form here before paid plans open. <Todo>withdrawal notice and model withdrawal form; early expiry for digital services (§ 356(5) BGB) incl. consent at checkout</Todo></p>

        <h2>11. Suspension and termination</h2>
        <p>You can stop using the service and delete your account at any time under Settings → Account. We may suspend or terminate your access if you seriously or repeatedly break these terms, if the law requires it, or for non-payment.
          Where reasonable we warn you first, so that you can download your data. Termination for good cause remains possible for both sides.</p>

        <h2>12. Liability</h2>
        <p>We are liable without limitation for intent and gross negligence, for injury to life, body or health, under the Product Liability Act and where we have given a guarantee.
          For slight negligence we are liable only for breach of an obligation essential to the contract (one that makes the contract possible and on which you may rely), limited to the damage typical and foreseeable when the contract was made. Otherwise our liability is excluded.
          This also applies to our employees and agents. Mandatory consumer rights are unaffected. <Todo>limitation of liability: lawyer to confirm wording, cap for free plan</Todo></p>

        <h2>13. Changes to these terms</h2>
        <p>We may change these terms for good reason, such as new features, legal changes or security needs. We announce changes at least 30 days before they take effect. If you do not object before then, the new terms apply; we point this out in the announcement.
          If you object, either side may end the contract when the change takes effect. <Todo>change clause (§ 307 BGB) to be reviewed</Todo></p>

        <h2>14. Governing law and final provisions</h2>
        <p>German law applies, excluding the UN Convention on Contracts for the International Sale of Goods; mandatory consumer protection in your country of residence is unaffected.
          If you are a merchant, the courts of Munich have exclusive jurisdiction. <Todo>place of jurisdiction for merchants</Todo> If any provision is invalid, the rest remains in force.
          Contact: <a href={`mailto:${C.email}`}>{C.email}</a>, fax <a href={C.faxHref}>{C.fax}</a>.</p>
        <p style={{ fontSize: 13, opacity: 0.8 }}>Last updated: 26 October 2026</p>
      </Lang>

      <Lang id="de">
        <h1>Allgemeine Geschäftsbedingungen</h1>

        <h2>§ 1 Geltungsbereich und Anbieter</h2>
        <p>Diese AGB gelten für die Nutzung von Hiddensee (die Website hiddensee.app, der Chat und die API, zusammen der „Dienst“), angeboten von der {C.name}, {C.street}, {C.city}, Deutschland („wir“).
          Abweichende Bedingungen gelten nur, wenn wir ihnen schriftlich zustimmen.</p>
        <p>Für die Nutzung müssen Sie mindestens 18 Jahre alt sein. Nutzen Sie den Dienst für eine Organisation, bestätigen Sie, dass Sie diese an diese AGB binden dürfen. <Todo>Mindestalter; Nutzung durch Unternehmer prüfen</Todo></p>

        <h2>§ 2 Konto und Zugang</h2>
        <p>Sie können den Dienst ohne Registrierung nutzen: Eine zufällige Konto-ID in einem Cookie ordnet Ihre Nutzung zu. Mit einem Passkey nutzen Sie Ihr Konto auf mehreren Geräten.
          Schützen Sie Ihre Geräte, Passkeys, Ihre Sitzung und etwaige API-Schlüssel und geben Sie sie nicht weiter; für die Nutzung Ihres Kontos sind Sie verantwortlich. Bei Verdacht auf Missbrauch schreiben Sie uns an <a href={`mailto:${C.email}`}>{C.email}</a>.</p>

        <h2>§ 3 Leistungen und Verfügbarkeit</h2>
        <p>Wir stellen einen KI-Chat bereit, der Anfragen an Modelle in vertraulichen Rechenumgebungen oder an Anbieter ohne Datenaufbewahrung weiterleitet. Antworten werden automatisiert erzeugt.
          Wir erbringen den Dienst mit angemessener Sorgfalt, schulden aber keine unterbrechungs- oder fehlerfreie Verfügbarkeit. Wir dürfen Modelle, Anbieter und Funktionen ändern, ergänzen oder entfernen, wenn dies für Sie zumutbar ist, insbesondere um den Dienst sicher, rechtmäßig oder funktionsfähig zu halten;
          den Kern eines bezahlten Tarifs schränken wir während der laufenden Laufzeit nicht ein. Die Registrierung kann einen Einladungscode erfordern. <Todo>Verfügbarkeitszusage / Wartungsfenster festlegen</Todo></p>
        <p>Drittanbieter: Wir betreiben weder die KI-Modelle noch die Enklaven oder die Hardware, auf der sie laufen. Diese werden von unabhängigen Anbietern betrieben, die in der <a href="/datenschutz">Datenschutzerklärung</a> genannt sind.
          Wir wählen die Anbieter aus und leiten Ihre Anfragen weiter, und bei Anbietern, die Modelle in einer Enklave betreiben, können Sie die Attestierung im Chat prüfen; auf ihre Infrastruktur haben wir jedoch keinen Einfluss, ihre Verfügbarkeit und Leistung liegen außerhalb unserer Kontrolle. <Todo>Haftung für Anbieter als Erfüllungsgehilfen (§ 278 BGB) anwaltlich prüfen</Todo></p>

        <h2>§ 4 Vertraulichkeit</h2>
        <p>Der Dienst ist so gebaut, dass wir nicht lesen können, was Sie schreiben: Wir speichern keine Chat-Inhalte, und Standardmodelle laufen in hardwareisolierten Enklaven der oben genannten Anbieter, deren Attestierung Sie prüfen können.
          Metadaten (etwa welches Modell Sie wann und wie viel nutzen) sind nicht in gleicher Weise geschützt. „Incognito“-Modelle laufen nicht in einer Enklave und werden nur genutzt, wenn Sie sie auswählen.
          Wir treffen die in der <a href="/datenschutz">Datenschutzerklärung</a> beschriebenen Maßnahmen, können die Vertraulichkeit von Daten aber nicht unter allen Umständen garantieren.</p>

        <h2>§ 5 KI-Ausgaben</h2>
        <p>KI-Antworten können falsch, unvollständig, veraltet oder anstößig sein, und dieselbe Frage kann unterschiedliche Antworten erhalten. Prüfen Sie wichtige Antworten selbst, bevor Sie sich darauf verlassen.
          Antworten sind keine Rechts-, Steuer-, Medizin-, Finanz- oder sonstige fachliche Beratung. Sie entscheiden über die Verwendung und sind dafür verantwortlich.</p>

        <h2>§ 6 Ihre Inhalte</h2>
        <p>Ihre Eingaben und die erhaltenen Antworten stehen, soweit gesetzlich möglich, Ihnen zu; wir beanspruchen daran keine Rechte und nutzen sie nicht zum Training von Modellen.
          Sie sind dafür verantwortlich, über die Rechte an Ihren Eingaben zu verfügen und keine Rechte Dritter zu verletzen. Antworten können solchen ähneln, die andere Nutzer erhalten.</p>

        <h2>§ 7 Zulässige Nutzung</h2>
        <p>Sie dürfen den Dienst nicht nutzen, um:</p>
        <ul>
          <li>gegen Gesetze oder Rechte Dritter zu verstoßen oder rechtswidrige Inhalte zu erstellen oder zu verbreiten, einschließlich Darstellungen sexuellen Missbrauchs von Kindern;</li>
          <li>Menschen zu belästigen, zu bedrohen, zu betrügen oder zu täuschen oder KI-Ausgaben irreführend als von Menschen verfasst auszugeben;</li>
          <li>Schadsoftware zu entwickeln, den Dienst oder andere Systeme anzugreifen oder ohne unsere Zustimmung auf Schwachstellen zu testen;</li>
          <li>Nutzungsgrenzen oder Sicherheitsmaßnahmen zu umgehen, Zugänge weiterzugeben oder weiterzuverkaufen oder automatisierte Massenabfragen außerhalb der dokumentierten API-Grenzen zu stellen;</li>
          <li>gegen die Nutzungsrichtlinien der Modellanbieter zu verstoßen.</li>
        </ul>
        <p>Bei Verstößen können wir Ihren Zugang sperren oder beenden (§ 11).</p>

        <h2>§ 8 Tarife und Preise</h2>
        <ul>
          {IDS.map((id) => <li key={id}>{TIERS[id].name}: {TIERS[id].priceEurMonth ? `${eur(TIERS[id].priceEurMonth)} pro Monat` : "kostenlos"}<Draft>, auch jährlich abrechenbar</Draft><Todo>Jahrespreis</Todo>; {planLinesDe(id).join("; ")}.</li>)}
        </ul>
        <p>Die bezahlten Tarife unterscheiden sich nur in ihren Limits; die Tageszahlen sind Fair-Use-Grenzen. Ausgewählte Spitzenmodelle werden über Guthaben abgerechnet: Jeder Tarif enthält ein monatliches Inklusiv-Guthaben, das am Monatsende verfällt; gekauftes Guthaben verfällt nicht. Guthaben ist nicht übertragbar und wird nicht ausgezahlt. <Todo>Guthabenbedingungen (Verfall, Erstattung bei Kündigung, Preisangabe je Modell) prüfen</Todo></p>
        <p>Alle Preise inkl. gesetzlicher USt. <Todo>USt-Behandlung (inkl./zzgl., OSS) prüfen</Todo> Preisänderungen für Abos kündigen wir mindestens 30 Tage vor Inkrafttreten an; Sie können bis dahin kündigen. <Todo>Preisänderungsklausel prüfen</Todo></p>

        <Draft>
          <h3>Kryptozahlungen</h3>
          <p>Sie können auch mit Kryptowerten (etwa Stablecoins) über Zold (<a href="https://zoldhq.com" rel="noopener noreferrer">zoldhq.com</a>) bezahlen, einen Dienst der {C.name}. Die Preise bleiben in Euro; der Betrag im Kryptowert wird beim Bezahlen festgelegt.
            Kryptozahlungen sind mit der Bestätigung auf der Blockchain endgültig: Prüfen Sie Netzwerk, Adresse und Betrag vor dem Senden, denn eine Zahlung an eine falsche Adresse oder über ein falsches Netzwerk können wir nicht rückgängig machen. Geschuldete Erstattungen zahlen wir an eine von Ihnen genannte Wallet, im selben Kryptowert oder in Euro.
            <Todo>Kryptobedingungen: Kryptowerte/Netzwerke, Kursfestlegung, Erstattung, Rolle von Monerium/E-Geld, MiCA/GwG</Todo></p>
        </Draft>

        <h2>§ 9 Vertragsschluss, Laufzeit, Kündigung</h2>
        <p>Der Vertrag über einen bezahlten Tarif kommt mit Abschluss des Bezahlvorgangs bei Stripe oder, bei Kryptozahlungen, bei Zold zustande. Abos verlängern sich um die gewählte Laufzeit, bis sie gekündigt werden.
          Kündigung jederzeit zum Ende der Laufzeit über „Abo verwalten“ (Stripe-Kundenportal). Schlägt eine Zahlung fehl, können wir Ihr Konto bis zur Zahlung auf den kostenlosen Tarif umstellen. <Todo>Kündigungsbutton nach § 312k BGB prüfen</Todo></p>

        <h2>§ 10 Widerrufsrecht für Verbraucher</h2>
        <p>Verbrauchern steht ein gesetzliches Widerrufsrecht zu. Die Widerrufsbelehrung und das Muster-Widerrufsformular veröffentlichen wir hier, bevor bezahlte Tarife starten. <Todo>Widerrufsbelehrung und Muster-Widerrufsformular einfügen; Regelung zum vorzeitigen Erlöschen bei digitalen Leistungen (§ 356 Abs. 5 BGB) inkl. Zustimmung im Checkout</Todo></p>

        <h2>§ 11 Sperrung und Beendigung</h2>
        <p>Sie können die Nutzung jederzeit beenden und Ihr Konto unter Einstellungen → Account löschen. Wir können Ihren Zugang sperren oder beenden, wenn Sie schwerwiegend oder wiederholt gegen diese AGB verstoßen, wenn das Gesetz es verlangt oder bei Zahlungsverzug.
          Soweit zumutbar, warnen wir Sie vorher, damit Sie Ihre Daten herunterladen können. Das Recht beider Seiten zur Kündigung aus wichtigem Grund bleibt unberührt.</p>

        <h2>§ 12 Haftung</h2>
        <p>Wir haften unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei Verletzung von Leben, Körper oder Gesundheit, nach dem Produkthaftungsgesetz und im Umfang einer übernommenen Garantie.
          Bei leichter Fahrlässigkeit haften wir nur bei Verletzung einer wesentlichen Vertragspflicht (deren Erfüllung die Durchführung des Vertrags erst ermöglicht und auf deren Einhaltung Sie vertrauen dürfen), begrenzt auf den bei Vertragsschluss vorhersehbaren, vertragstypischen Schaden. Im Übrigen ist die Haftung ausgeschlossen.
          Dies gilt auch für unsere Mitarbeiter und Erfüllungsgehilfen. Zwingende Verbraucherrechte bleiben unberührt. <Todo>Haftungsbeschränkung anwaltlich bestätigen, ggf. Begrenzung für den kostenlosen Tarif</Todo></p>

        <h2>§ 13 Änderungen dieser AGB</h2>
        <p>Wir dürfen diese AGB aus triftigem Grund ändern, etwa bei neuen Funktionen, Gesetzesänderungen oder Sicherheitsanforderungen. Änderungen kündigen wir mindestens 30 Tage vor Inkrafttreten an. Widersprechen Sie nicht bis dahin, gelten die neuen AGB; darauf weisen wir in der Ankündigung hin.
          Widersprechen Sie, kann jede Seite den Vertrag zum Inkrafttreten der Änderung beenden. <Todo>Änderungsklausel (§ 307 BGB) prüfen</Todo></p>

        <h2>§ 14 Anwendbares Recht und Schlussbestimmungen</h2>
        <p>Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts; zwingende Verbraucherschutzvorschriften des Aufenthaltsstaats bleiben unberührt.
          Sind Sie Kaufmann, ist ausschließlicher Gerichtsstand München. <Todo>Gerichtsstand für Kaufleute bestätigen</Todo> Ist eine Bestimmung unwirksam, bleiben die übrigen wirksam.
          Kontakt: <a href={`mailto:${C.email}`}>{C.email}</a>, Fax <a href={C.faxHref}>{C.fax}</a>.</p>
        <p style={{ fontSize: 13, opacity: 0.8 }}>Stand: 26. Oktober 2026</p>
      </Lang>
    </LegalPage>
  );
}
