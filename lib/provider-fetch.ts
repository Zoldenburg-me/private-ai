import { privatemodeFetch } from "./privatemode";
import { tinfoilFetch } from "./tinfoil";

/** The fetch a provider's model calls (chat, agent, /models) go through: Tinfoil and Privatemode via their attesting SDKs. */
export const providerFetch = (id: string): typeof fetch =>
  id === "tinfoil" ? tinfoilFetch : id === "privatemode" ? privatemodeFetch : fetch;
