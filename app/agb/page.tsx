import { LegalPage, Lang, Todo } from "@/components/legal";
import { TIERS } from "@/lib/tiers";

export const metadata = { title: "AGB / Terms of service" };
const eur = (n: number) => `${n} €`;

export default function Agb() {
  const { free, pro, max } = TIERS;
  return (
    <LegalPage title="Allgemeine Geschäftsbedingungen / Terms of service">
      <p><Todo>Gesamten Text anwaltlich prüfen, insb. Widerrufsrecht, Haftung, Preisangaben / full text needs lawyer review</Todo></p>
      <Lang id="de">
        <h2>Allgemeine Geschäftsbedingungen</h2>
        <h3>§ 1 Geltungsbereich</h3>
        <p>Diese AGB gelten für die Nutzung von „Private AI“ (Arbeitstitel) der Zoldenburg UG (haftungsbeschränkt) („wir“). Abweichende Bedingungen gelten nicht.</p>
        <h3>§ 2 Leistungen</h3>
        <p>Wir stellen einen KI-Chat bereit, der Anfragen an Modelle in vertraulichen Rechenumgebungen weiterleitet. Antworten werden automatisiert erzeugt und können unzutreffend sein; sie ersetzen keine fachliche Beratung.
          Wir schulden keine bestimmte Verfügbarkeit. <Todo>Verfügbarkeitszusage / Wartungsfenster festlegen</Todo></p>
        <h3>§ 3 Tarife und Preise</h3>
        <ul>
          <li>{free.name}: kostenlos, {free.dailyMessages} Nachrichten pro Tag.</li>
          <li>{pro.name}: {eur(pro.priceEurMonth)} pro Monat oder jährlich <Todo>Jahrespreis</Todo>, bis zu {pro.dailyMessages} Nachrichten pro Tag.</li>
          <li>{max.name}: {eur(max.priceEurMonth)} pro Monat oder jährlich <Todo>Jahrespreis</Todo>, Fair-Use bis zu {max.dailyMessages} Nachrichten pro Tag.</li>
        </ul>
        <p>Alle Preise inkl. gesetzlicher USt. <Todo>USt-Behandlung (inkl./zzgl., OSS) prüfen</Todo></p>
        <h3>§ 4 Vertragsschluss, Laufzeit, Kündigung</h3>
        <p>Der Vertrag über einen bezahlten Tarif kommt mit Abschluss des Bezahlvorgangs bei Stripe zustande. Abos verlängern sich um die gewählte Laufzeit, bis sie gekündigt werden.
          Kündigung jederzeit zum Ende der Laufzeit über „Abo verwalten“ (Stripe-Kundenportal). <Todo>Kündigungsbutton nach § 312k BGB prüfen</Todo></p>
        <h3>§ 5 Widerrufsrecht für Verbraucher</h3>
        <p><Todo>Widerrufsbelehrung und Muster-Widerrufsformular einfügen; Regelung zum vorzeitigen Erlöschen bei digitalen Leistungen (§ 356 Abs. 5 BGB) inkl. Zustimmung im Checkout</Todo></p>
        <h3>§ 6 Zulässige Nutzung</h3>
        <p>Untersagt sind rechtswidrige Inhalte, Angriffe auf den Dienst, das Umgehen von Nutzungsgrenzen sowie automatisierte Massenabfragen außerhalb der dokumentierten API-Grenzen.</p>
        <h3>§ 7 Haftung</h3>
        <p><Todo>Haftungsbeschränkung (Vorsatz, grobe Fahrlässigkeit, Kardinalpflichten, Produkthaftung) anwaltlich formulieren</Todo></p>
        <h3>§ 8 Schlussbestimmungen</h3>
        <p>Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts; zwingende Verbraucherschutzvorschriften des Aufenthaltsstaats bleiben unberührt. <Todo>Gerichtsstand für Kaufleute</Todo></p>
      </Lang>
      <Lang id="en">
        <h2>Terms of service</h2>
        <h3>1. Scope</h3>
        <p>These terms govern the use of “Private AI” (working title) by Zoldenburg UG (haftungsbeschränkt) (“we”).</p>
        <h3>2. Service</h3>
        <p>We provide an AI chat that relays requests to models running in confidential computing environments. Replies are generated automatically and may be wrong; they are not professional advice.
          No specific availability is promised. <Todo>availability commitment</Todo></p>
        <h3>3. Plans and prices</h3>
        <ul>
          <li>{free.name}: free, {free.dailyMessages} messages per day.</li>
          <li>{pro.name}: {eur(pro.priceEurMonth)} per month or yearly <Todo>annual price</Todo>, up to {pro.dailyMessages} messages per day.</li>
          <li>{max.name}: {eur(max.priceEurMonth)} per month or yearly <Todo>annual price</Todo>, fair use up to {max.dailyMessages} messages per day.</li>
        </ul>
        <h3>4. Contract, term, cancellation</h3>
        <p>A paid plan starts when payment at Stripe completes and renews for the chosen period until cancelled. You can cancel at any time, effective at the end of the period, via “Manage subscription” (Stripe customer portal).</p>
        <h3>5. Right of withdrawal (consumers)</h3>
        <p><Todo>withdrawal notice and model form</Todo></p>
        <h3>6. Acceptable use</h3>
        <p>Unlawful content, attacks on the service, circumventing usage limits and bulk automated use beyond the documented API limits are not allowed.</p>
        <h3>7. Liability</h3>
        <p><Todo>limitation of liability</Todo></p>
        <h3>8. Final provisions</h3>
        <p>German law applies, excluding the UN Convention on Contracts for the International Sale of Goods; mandatory consumer protection in your country of residence is unaffected.</p>
      </Lang>
    </LegalPage>
  );
}
