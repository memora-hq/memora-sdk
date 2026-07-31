export * from "./identity.js";
export * from "./manifest.js";
export * from "./store.js";
export * from "./session.js";
export * from "./verify.js";
export * from "./bundle.js";

import { verifySession } from "./verify.js";
import { verifyBundle } from "./bundle.js";

/** @deprecated use {@link verifyBundle} */
export const verifyLocalBundle = verifyBundle;

/** @deprecated use {@link verifySession} */
export const verifyLocalSession = verifySession;
