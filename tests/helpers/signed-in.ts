import { createSession, signInDevice } from "../../lib/session";

/** A signed-in account (passkey device token): anonymous sessions get free TEE models only. */
export async function signedIn(): Promise<{ id: string; token: string }> {
  const { id } = await createSession();
  return { id, token: await signInDevice(id) };
}
