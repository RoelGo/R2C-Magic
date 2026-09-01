"use server";

import { disconnect } from "@/lib/lightspeed";
import { revalidatePath } from "next/cache";

/**
 * Server action: disconnect the Lightspeed Retail account (spec v2 Slice F).
 * Revokes the refresh token with Lightspeed (best-effort) and removes the
 * local connection, then refreshes the settings screen.
 */
export async function disconnectLightspeedAction(): Promise<void> {
  await disconnect();
  revalidatePath("/settings/lightspeed");
}
