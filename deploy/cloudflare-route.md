# Cloudflare route for the connection page

The existing remotely managed `nestor` Tunnel is owned by the sibling `infra` repository. Add one ingress entry **before** its `http_status:404` catch-all:

```hcl
{
  hostname       = "connect.tch.dev"
  service        = "http://127.0.0.1:8790"
  origin_request = {}
},
```

In the sibling stack's `dns.tf`, add a proxied CNAME for the same tunnel:

```hcl
resource "cloudflare_dns_record" "cairn_connect" {
  zone_id = local.zone_id
  name    = "connect.${local.zone_name}"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.nestor.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
```

In `access.tf`, add a separate self-hosted application for the entire hostname using the existing owner-only policy and identity provider:

```hcl
resource "cloudflare_zero_trust_access_application" "cairn_connect" {
  account_id = local.account_id
  name       = "cairn-connect"
  domain     = "connect.${local.zone_name}"
  type       = "self_hosted"

  session_duration            = "24h"
  app_launcher_visible        = false
  auto_redirect_to_identity   = true
  allowed_idps                = [cloudflare_zero_trust_access_identity_provider.one_time_pin.id]
  enable_binding_cookie       = false
  http_only_cookie_attribute  = false
  allow_authenticate_via_warp = false
  options_preflight_bypass    = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.me_only.id
    precedence = 1
  }]
}
```

Keep `/google/callback` under that same policy; do not add a Bypass rule. The tunnel must pass the original `Host: connect.tch.dev` header to Cairn. Never route `connect.tch.dev` to Cairn's MCP port 8789. Apply the Terraform change only after the listener and private config are installed; otherwise the new hostname will return a gateway error.

The separate Google Cloud **Web application** OAuth client must list `https://connect.tch.dev/google/callback` as an authorized redirect URI. The connection page may remain available for reconnecting after token revocation or VPS replacement. The local listener is restartable and binds to `127.0.0.1:8790` only.
