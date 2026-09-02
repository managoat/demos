/**
 * "Sign in with Fountain" for fountain-conversations — see `@managoat/fountain-app/oauth`.
 *
 * The client id is registered on the Fountain server (OAUTH_CLIENTS) along
 * with this app's exact redirect URIs, and it is this app's host label too:
 * fountain-conversations.demo.managoat.com.
 */
import { createOAuth } from "@managoat/fountain-app/oauth";

export { redirectUri } from "@managoat/fountain-app/oauth";
export type { CallbackResult, OAuthClient } from "@managoat/fountain-app/oauth";

export const { beginLogin, completeLoginIfCallback, revoke } = createOAuth("fountain-conversations");
