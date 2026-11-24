/** Google for modules' syncs (calendar, mail): the connected accounts, and authorised reads. A thin wrapper over the
 * connection (google.ts), which owns the tokens; modules never see a token, only `get` and `send`. Errors become ServiceError:
 * `reconnect` when Google no longer honours the grant (Settings shows Reconnect), else `unavailable`.
 */
import { ServiceError, type GoogleService } from "@isocline/module-kit";
import type { GoogleConnections } from "./google.ts";

function requestSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function googleService(connections: GoogleConnections, fetchImpl: typeof fetch = globalThis.fetch): GoogleService {
  return {
    accounts: (includeBroken) => connections.status().accounts.filter((account) => includeBroken || !account.broken).map((account) => ({ email: account.email, capabilities: account.capabilities })),
    async session(email) {
      let token: string;
      try {
        token = await connections.accessToken(email);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        throw new ServiceError(code === "broken" || code === "unknown_account" ? "reconnect" : "unavailable", (error as Error).message);
      }
      return {
        async get(url, signal) {
          let response: Response;
          try {
            response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: requestSignal(signal) });
          } catch (error) {
            throw new ServiceError("unavailable", `Google could not be reached: ${(error as Error).message}`);
          }
          const body = (await response.json().catch(() => {
            if (response.ok) throw new ServiceError("unavailable", "Google returned an incomplete response");
            return {};
          })) as Record<string, unknown>;
          if (response.status === 401) throw new ServiceError("reconnect", "Google refused the account's access", 401);
          if (!response.ok) {
            const reason = (body.error as { message?: unknown } | undefined)?.message;
            throw new ServiceError("unavailable", `Google answered ${response.status}${typeof reason === "string" ? `: ${reason.slice(0, 200)}` : ""}`, response.status);
          }
          return body;
        },
        async send(method, url, body, options = {}) {
          let response: Response;
          try {
            response = await fetchImpl(url, {
              method, signal: requestSignal(options.signal),
              headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
          } catch (error) {
            throw new ServiceError("unavailable", `Google could not be reached: ${(error as Error).message}`);
          }
          if (response.status === 401) throw new ServiceError("reconnect", "Google refused the account's access", 401);
          return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
        },
      };
    },
  };
}
