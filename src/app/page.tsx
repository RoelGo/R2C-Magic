export default function Home() {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-2xl font-semibold">Upload an R-Series export</h2>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          Drop the CSV exported from Lightspeed R-Series here. R2C Magic will enrich each book using
          Google Books, Open Library and KB SRU, then produce a C-Series-ready import CSV.
        </p>
      </section>

      <section className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-12 text-center">
        <p className="text-slate-500">
          Upload UI lands in milestone M1. The CSV pipeline, mapping config and source stubs are
          already in place — see <code>src/lib/csv</code> and <code>src/lib/enrichment</code>.
        </p>
      </section>

      <section>
        <h3 className="text-lg font-medium">Status</h3>
        <ul className="mt-2 list-inside list-disc text-sm text-slate-600 dark:text-slate-400">
          <li>M0 scaffold — done</li>
          <li>M1 CSV pipeline (upload → mapping → export, no enrichment yet)</li>
          <li>M2 enrichment (Google Books, Open Library, KB SRU)</li>
          <li>M3 polish (per-run detail, in-app mapping editor, CB adapter)</li>
          <li>M4 desktop bundle (Tauri shell + installers)</li>
        </ul>
      </section>
    </div>
  );
}
