import { LegalPage, Lang } from "@/components/legal";
import { DATA_INVENTORY, NOT_STORED, type DataField } from "@/lib/data-inventory";

export const metadata = { title: "Stored metadata / Gespeicherte Metadaten" };

const STORE_LABEL: Record<DataField["store"], [string, string]> = {
  postgres: ["Datenbank (Postgres)", "Database (Postgres)"], redis: ["Zähler (Redis)", "Counters (Redis)"],
  "server-log": ["Server-Log", "Server log"], browser: ["Ihr Browser", "Your browser"],
};
const cell = { border: "1px solid #333", padding: "4px 6px", verticalAlign: "top" as const, fontSize: 13 };

function Table({ lang }: { lang: "de" | "en" }) {
  const de = lang === "de";
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }} data-testid={`inventory-${lang}`}>
        <thead><tr>{(de ? ["Ort", "Tabelle / Schlüssel", "Feld", "Inhalt", "Speicherdauer"] : ["Where", "Table / key", "Field", "What", "Kept for"]).map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>
          {DATA_INVENTORY.map((d) => (
            <tr key={`${d.store}:${d.container}:${d.field}`}>
              <td style={cell}>{STORE_LABEL[d.store][de ? 0 : 1]}</td><td style={cell}><code>{d.container}</code></td><td style={cell}><code>{d.field}</code></td>
              <td style={cell}>{de ? d.de : d.en}</td><td style={cell}>{de ? d.retentionDe : d.retentionEn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MetadataPage() {
  return (
    <LegalPage>
      <Lang id="en">
        <h1>What we store – complete list</h1>
        <p>This table is generated from the same source our tests check against the database schema, the Redis keys and the logger. If a field is added without appearing here, the build fails.</p>
        <Table lang="en" />
        <h3>What we do not store</h3>
        <ul>{NOT_STORED.en.map((x) => <li key={x}>{x}</li>)}</ul>
      </Lang>
      <Lang id="de">
        <h1>Was wir speichern – vollständige Liste</h1>
        <p>Diese Tabelle wird aus derselben Quelle erzeugt, die unsere Tests gegen das Datenbankschema, die Redis-Schlüssel und den Logger prüfen. Kommt ein Feld hinzu, ohne hier aufzutauchen, schlägt der Build fehl.</p>
        <Table lang="de" />
        <h3>Was wir nicht speichern</h3>
        <ul>{NOT_STORED.de.map((x) => <li key={x}>{x}</li>)}</ul>
      </Lang>
    </LegalPage>
  );
}
