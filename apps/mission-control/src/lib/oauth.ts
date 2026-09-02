/**
 * "Sign in with Fountain" for mission-control — see `@managoat/fountain-app/oauth`.
 *
 * The client id is registered on the Fountain server (OAUTH_CLIENTS) along
 * with this app's exact redirect URIs, and it is this app's host label too:
 * mission-control.demo.managoat.com.
 */
import { createOAuth } from "@managoat/fountain-app/oauth";

export { redirectUri } from "@managoat/fountain-app/oauth";
export type { CallbackResult, OAuthClient } from "@managoat/fountain-app/oauth";

export const { beginLogin, completeLoginIfCallback, revoke } = createOAuth("mission-control");
