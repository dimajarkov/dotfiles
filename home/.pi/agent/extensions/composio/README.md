# Pi Composio extension

This extension uses Composio's official `PiProvider` to expose dynamic app tools directly in Pi without MCP.
It registers tool search, connected-account management, tool execution, and optional remote sandbox helpers.

## Setup

Create a Composio API key in [Composio settings](https://dashboard.composio.dev/settings).
For a secret-manager-backed setup, write the value to `~/.config/pi-composio/api-key` with mode `600`.
The extension reads that file automatically without exporting the value into every shell process.
Set `COMPOSIO_API_KEY_FILE` to use a different credential file.

On macOS, the login Keychain is also supported under service `pi-composio-api-key` and your local username.

To add the item manually, run this command in an interactive terminal and enter the key at the password prompt:

```bash
security add-generic-password -U -a "$USER" -s pi-composio-api-key -w
```

You can instead expose the key only to the process that starts Pi:

```bash
COMPOSIO_API_KEY='...' pi
```

Do not commit the API key to this repository or put it in the JSON configuration file.

Run `/composio` inside Pi to verify the integration status.

The extension uses the stable local user ID `pi:<username>` by default.
Override it with `COMPOSIO_USER_ID` if this harness must reuse connected accounts created under another Composio user ID.

## Optional configuration

Create `~/.config/pi-composio/config.json` to restrict toolkits, disable the remote sandbox, set a stable user ID, or configure the post-auth callback URL:

```json
{
  "userId": "pi:my-user",
  "toolkits": ["github", "gmail", "linear"],
  "sandbox": true,
  "callbackUrl": "https://example.com/auth/callback"
}
```

Set `COMPOSIO_CONFIG_PATH` to use a different configuration file.
`COMPOSIO_USER_ID` takes precedence over `userId` in the file.

Connected-account authorization happens in chat through `composio_manage_connections`.
The agent returns a Composio Connect Link when authorization is needed, so OAuth credentials never pass through Pi.
