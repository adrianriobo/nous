# MCP servers

Mount an MCP configuration file at `/run/secrets/mcp.json`. The entrypoint merges its servers into `/sandbox/.pi/agent/mcp.json` before pi starts.

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  -v /path/to/mcp.json:/run/secrets/mcp.json:ro,z \
  ghcr.io/adrianriobo/nous:latest
```

For example:

```json
{
  "mcpServers": {
    "my_server": {
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "hint": "Use for questions about this domain"
    }
  }
}
```

Protect the configuration file if it contains credentials. Configure network access for each server. For a private certificate authority, see [running nous](running.md#private-certificate-authority).

At startup, nous discovers tools from each configured HTTP MCP server. It registers them as pi tools named `<serverName>_<toolName>`. The router supports HTTP+SSE and streamable HTTP transports.

The optional `hint` takes precedence over the server's `initialize` instructions. nous adds the selected text to the tool description. Restart the container after a configuration change. A rebuild is not necessary.
