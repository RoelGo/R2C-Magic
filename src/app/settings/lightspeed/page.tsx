import { getConnectionStatus } from "@/lib/lightspeed";
import Link from "next/link";
import { disconnectLightspeedAction } from "../actions";

export const dynamic = "force-dynamic";

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

interface Props {
  searchParams: Promise<{ status?: string; reason?: string }>;
}

const ERROR_REASONS: Record<string, string> = {
  "not-configured": "Lightspeed client credentials are not configured on the server.",
  denied: "Authorization was denied. You can try connecting again.",
  "missing-code": "Lightspeed did not return an authorization code. Please try again.",
  "state-mismatch":
    "The login could not be verified (state mismatch). Please start the connection again.",
  "exchange-failed":
    "Could not exchange the authorization code for a token. Check the client secret and redirect URI, then try again.",
};

/**
 * Lightspeed Retail connection settings (spec v2 Slice F). Shows whether the
 * server is configured and connected, and lets the worker connect (OAuth) or
 * disconnect. The connect link is a full navigation to the server route that
 * starts the authorization-code grant.
 */
export default async function LightspeedSettingsPage({ searchParams }: Props) {
  const { status: resultStatus, reason } = await searchParams;
  const status = getConnectionStatus();

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/intake" className="text-blue-600 hover:underline dark:text-blue-400">
          ← Back to intake
        </Link>
      </nav>

      <header className="space-y-1">
        <h2 className="text-2xl font-semibold">Lightspeed Retail</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Connect this app to your Lightspeed Retail (R-Series) account so intake books can be
          pushed to the webshop.
        </p>
      </header>

      {resultStatus === "connected" ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          Connected to Lightspeed.
        </p>
      ) : null}
      {resultStatus === "error" ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {(reason && ERROR_REASONS[reason]) ?? "Something went wrong connecting to Lightspeed."}
        </p>
      ) : null}

      {!status.configured ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <p className="font-medium">Not configured</p>
          <p className="mt-1">
            Set <code>LIGHTSPEED_CLIENT_ID</code>, <code>LIGHTSPEED_CLIENT_SECRET</code>, and{" "}
            <code>LIGHTSPEED_REDIRECT_URI</code> in the server environment, then restart the app.
            See the README for how to register an API client.
          </p>
        </div>
      ) : status.connected ? (
        <div className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <span className="text-sm font-medium">Connected</span>
          </div>
          <dl className="space-y-2 text-sm">
            <Row label="Account ID" value={status.accountId} />
            <Row label="Scopes" value={status.scope} />
            <Row
              label="Connected"
              value={
                status.connectedAt
                  ? new Date(status.connectedAt).toLocaleString(undefined, DATE_FORMAT)
                  : undefined
              }
            />
            <Row
              label="Token expires"
              value={
                status.accessTokenExpiresAt
                  ? new Date(status.accessTokenExpiresAt).toLocaleString(undefined, DATE_FORMAT)
                  : undefined
              }
            />
          </dl>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The access token is refreshed automatically; you do not need to reconnect unless you
            disconnect below or revoke access in Lightspeed.
          </p>
          <form action={disconnectLightspeedAction}>
            <button
              type="submit"
              className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/30"
            >
              Disconnect
            </button>
          </form>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-400" />
            <span className="text-sm font-medium">Not connected</span>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Authorize this app to access your Lightspeed Retail account. You&apos;ll be sent to
            Lightspeed to log in and approve, then returned here.
          </p>
          <a
            href="/api/lightspeed/connect"
            className="inline-block rounded-md bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700"
          >
            Connect to Lightspeed
          </a>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-right font-medium text-slate-800 dark:text-slate-200">{value ?? "—"}</dd>
    </div>
  );
}
