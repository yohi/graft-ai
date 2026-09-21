import type { ProviderAdapter } from "../types";
import { fetchOpenCodeGoApiKey } from "./api-key";

export { fetchOpenCodeGoApiKey } from "./api-key";

export const openCodeGoAdapter: ProviderAdapter = (env, context) =>
  fetchOpenCodeGoApiKey(env.OPENCODEGO_API_KEY ?? "", context);

export const opencodegoAdapter = openCodeGoAdapter;
