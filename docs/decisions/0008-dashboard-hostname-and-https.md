# 0008: The dashboard is served at a free deSEC name, through Caddy on the VM

Status: Proposed · 2026-11-23

## Context

The dashboard ([Track D](../plans/minecraft-ff14-features.md#track-d-web-dashboard))
and two-way Minecraft chat ([0006](0006-discord-to-minecraft-chat.md))
need a public HTTPS endpoint on the VM: the browser for the pages and
Discord login, and `mcbridge`, which connects out to the bot. Discord's
OAuth2 redirect URL and the helper's config both hold the hostname, so it
has to stay the same across restarts and deploys. Today the VM accepts no
inbound connections at all.

Constraints: free tiers only, and nothing that needs a payment method
(CLAUDE.md), so no bought domain. The owner isn't publishing the bot
widely, so traffic is a few servers' pages and their helpers' long polls.

D0 listed the hostname, HTTPS, and "proxy or tunnel" as separate
choices. They're one here: a tunnel brings its own hostname and
certificate, and a proxy needs a hostname from somewhere else.

Options, checked on 2026-11-23 against each provider's own docs:

| Option | Free, no card | Stable hostname | Inbound ports on the VM | Notes |
|---|---|---|---|---|
| **deSEC (`<name>.dedyn.io`) + Caddy on the VM** | Free; sign-up is an email and a password | Yes | 80 and 443 | One `dedyn.io` name per account; no inactivity rule found. A full DNS host with an API, rate limits documented, and ACME DNS-01 documented if ever needed. Who runs it couldn't be confirmed from its site. |
| DuckDNS (`<name>.duckdns.org`) + Caddy | Free; sign-in with Google, GitHub and others | Yes | 80 and 443 | Run by two engineers; terms last updated 2018; no inactivity rule; one TXT value only, no documented ACME client. |
| No-IP free + Caddy | "No credit card required" | Yes | 80 and 443 | One hostname. Its confirmation rule for free hostnames wasn't on the page read (from memory it's monthly, which would mean a recurring manual step). |
| Tailscale Funnel (`<machine>.<tailnet>.ts.net`) | Free Personal plan, non-commercial; whether sign-up asks for a card wasn't stated | Yes, unless the machine is renamed; the tailnet part is generated and can't be chosen | None | Beta, with bandwidth limits Tailscale doesn't publish. TLS ends on the VM (the relay can't read it). Long-lived requests aren't documented. Adds `tailscaled` on the VM and a Tailscale account. |
| Cloudflare Tunnel (named) | No: Zero Trust onboarding asks for payment details | Only on a domain on Cloudflare | None | Ruled out: needs a bought domain and a payment method. |
| Cloudflare quick tunnel | Free, no account | No: random, changes each run | None | Ruled out: "for testing and development", no uptime guarantee, 200 requests in flight. |

Both `dedyn.io` and `duckdns.org` are on the Public Suffix List, so Let's
Encrypt counts each name as its own registered domain (50 certificates
per 7 days), not one shared by every user of the provider.

Caddy (an OS package with its own systemd service, not an npm
dependency) gets and renews Let's Encrypt certificates by itself over
ports 80 and 443, redirects HTTP to HTTPS, and proxies long-lived
requests with no read or write timeout by default. Let's Encrypt's
default certificates last 90 days, falling to 100 days from 15 March
2027 and 47 days from 15 March 2029; automatic renewal makes that
invisible.

Oracle (checked 2026-11-23): inbound ports are opened in the subnet's
security list. Oracle warns not to use UFW on its Ubuntu images; that
the VM's own `iptables` also blocks 80 and 443 by default is from
memory, not its docs, and is checked on the VM. An ephemeral public IP stays with the instance when
it's stopped; it goes only if the instance is recreated. Always Free
includes 10 TB a month of outbound data.

## Decision

The dashboard and the helper's endpoint are served at a free
`<name>.dedyn.io` name from deSEC, pointing at the VM's public IP. Caddy
on the VM terminates HTTPS with Let's Encrypt certificates and proxies to
the bot, which listens on `127.0.0.1` only. Ports 80 and 443 are opened
in the OCI security list and the VM's `iptables`, and nothing else.

**Why:** TODO(Alex)

## Consequences

- The VM takes inbound connections for the first time. Only Caddy faces
  the internet, so the bot's HTTP server is never reachable directly, and
  Caddy's TLS and HTTP parsing are a maintained project's, not ours.
- Setup is by hand, once, on the VM and outside the deploy job: the
  deSEC account and A record, Caddy's apt repository and a two-line
  Caddyfile, and the firewall rules. The README's deployment section
  records each step, so the VM can be rebuilt. The deploy job doesn't
  touch Caddy.
- A deploy restarts the bot, not Caddy: for those seconds Caddy answers
  502. Browsers retry, and the helper already backs off on a 5xx (A8).
- If the VM's public IP changes (the instance recreated), the A record
  is updated through deSEC's dynamic DNS API. Until then the dashboard
  and every helper are unreachable. A reserved IP would avoid that; how
  many Always Free includes wasn't confirmed.
- Users and helpers see a `dedyn.io` name, not a branded domain. Moving
  to another name later means changing Discord's OAuth2 redirect URL and
  every helper's config, so it's worth choosing the label once.
- The VM's IP is public in DNS (as it would be with any proxy; only a
  tunnel hides it), and certificate transparency logs list the hostname.
  Scanners will find it.
- Depends on deSEC staying free and online. If it doesn't, DuckDNS is a
  drop-in replacement (same Caddy setup, a new name), and Tailscale Funnel
  the route with no open ports, once it leaves beta and documents its
  limits. Either would supersede this record.
- Not used: DNS-01 and wildcard certificates (Caddy would need a plugin
  build), and IPv6.
