/** The secret store lives in core (packages/core/src/secrets.ts), so the engine workers can use it too. */
export { defaultSecretStore, fileStore, keychainStore, type SecretStore } from "@zirma/core";
