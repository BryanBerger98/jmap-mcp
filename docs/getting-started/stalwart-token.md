# Get a bearer token from Stalwart

The server authenticates to Stalwart with one HTTP header, `Authorization: Bearer <token>`, on every request.
This page says which tokens Stalwart accepts there, how to obtain the durable one, and how to check it before configuring anything.

## The two bearers Stalwart accepts

Stalwart reads a bearer token in two ways, in this order (`crates/common/src/auth/authentication.rs:309-320` on tag `v0.16.19`):

| Bearer | Shape | Lifetime |
| --- | --- | --- |
| API key | Starts with `API_` | Until its expiry, or forever |
| OAuth access token | Opaque string issued by `/auth/token` | One hour by default |

An app password is not a bearer.
It travels with HTTP Basic authentication, and this server only ever sends `Authorization: Bearer`, so an app password is refused.

## Create an API key

1. Open the self-service portal of your Stalwart server, usually `https://mail.example.com/portal`, and sign in with the account the assistant will use.
2. Open the **API Keys** menu and create a key.
3. Leave permissions on **Inherit**: the key then carries every permission of the account, including the `jmap*` family the server needs.
4. Set an expiry date if you want one, or leave it empty for a key that lives until you delete it.
5. Copy the key once, at creation: the portal does not show it again.

`Disable` and `Replace` are the two other permission modes.
Both narrow what the key may do, and a key without the `jmap*` permissions authenticates but then fails on the first method call.

## Documentation and code disagree

The official API key page states that an API key cannot be used to log in over JMAP, only the management API.
The code of `v0.16.19` says otherwise: the bearer branch parses an `API_` prefix before it looks for an OAuth token, validates it as an account credential, and gives it the account's permissions in `Inherit` mode (`crates/common/src/auth/access_token.rs:146-172`).
No protocol gate on API keys was found in the HTTP or JMAP crates of that tag.

The arbiter is the `curl` below.
Run it before you configure any client: if it answers with a session object, your server accepts the key and this page holds; if it answers `401`, fall back to OAuth.

## Verify the token

```sh
curl -sS -H "Authorization: Bearer API_xxx" https://mail.example.com/.well-known/jmap
```

Expect a JSON session object that carries both keys below.
Anything else means the token was refused or the URL is wrong.

```json
{
  "capabilities": { "urn:ietf:params:jmap:core": { "..." : "..." } },
  "primaryAccounts": { "urn:ietf:params:jmap:mail": "a" }
}
```

A refused token returns `401` with an empty body.
Once configured, the server reports the same failure on stderr as `The JMAP server refused the credentials. Check bearerToken: it may be expired, mistyped, or without access to this account.`

## Fallback: an OAuth access token

When your server refuses the API key on `/.well-known/jmap`, obtain an access token with the device flow.
It is the only OAuth flow that needs no callback URL, so it works from a terminal.

1. Ask for a device code. Any `client_id` works unless your server requires client registration, which is off by default.

   ```sh
   curl -sS -X POST https://mail.example.com/auth/device -d "client_id=jmap-mcp"
   ```

2. Open the `verification_uri_complete` link of the answer in a browser, sign in, and approve.
3. Exchange the device code for a token, using the `device_code` of step 1.

   ```sh
   curl -sS -X POST https://mail.example.com/auth/token \
     -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
     -d "device_code=<device_code>" -d "client_id=jmap-mcp"
   ```

4. Use the `access_token` of the answer as the bearer.

An access token expires after one hour by default, so a server configured in the morning is silent by the afternoon.
Raise the limit under **Settings › Authentication › OIDC Provider**, setting `Access token expiry` (`accessTokenExpiry`, in milliseconds) to the duration you accept.
The answer also carries a `refresh_token`, valid thirty days by default, but this server does not refresh tokens itself: a new access token means a new configuration.

## Where the token lives

Give the token to the server through the `JMAP_BEARER_TOKEN` environment variable, or through `bearerToken` in `~/.config/jmap-mcp/config.json`.
It is never a command-line argument: an argument is visible to every process on the machine, and it ends up in shell history.

Next: register the server with [Claude Code](./claude-code.md), [Claude Desktop](./claude-desktop.md) or [Cursor](./cursor.md).
The full list of settings is in the [configuration reference](../reference/configuration.md).
