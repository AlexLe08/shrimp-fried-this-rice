# 0008: The dashboard is served at a free DuckDNS name, through Caddy on the VM

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

Options, checked on 2026-11-23 against each provider's own docs (Sources,
below):

| Option | Free, no card | Stable hostname | Inbound ports on the VM | Notes |
|---|---|---|---|---|
| **DuckDNS (`<name>.duckdns.org`) + Caddy on the VM** | Free; sign-in with Google, GitHub and others | Yes | 80 and 443 | Open for sign-ups (checked 2026-11-23, no notice on its pages). Run by two engineers; terms last updated 2018; no inactivity rule; no per-account limit stated. One TXT value only and no documented ACME client, which matters only for DNS-01, not used here. |
| deSEC (`<name>.dedyn.io`) + Caddy | Free; sign-up is an email and a password | Yes | 80 and 443 | Ruled out: `dedyn.io` registration is "suspended until further notice" after a wave of abusive sign-ups (the banner on desec.io, which the owner saw on 2026-11-23; its pages render in the browser only, so fetching them showed nothing). Otherwise the stronger option: a full DNS host with an API and documented limits. |
| FreeDNS (afraid.org), a shared domain such as `mooo.com` + Caddy | Free sign-up, no payment field | Yes, while the domain's owner keeps it shared | 80 and 443 | Set aside: the shared domains belong to other members (`mooo.com` holds about 880,000 hosts), and unless a domain is on the Public Suffix List every name on it shares one Let's Encrypt limit. |
| No-IP free + Caddy | "No credit card required" | Yes | 80 and 443 | One hostname. Its confirmation rule for free hostnames wasn't on the page read (from memory it's monthly, which would mean a recurring manual step). |
| Tailscale Funnel (`<machine>.<tailnet>.ts.net`) | Free Personal plan, non-commercial; whether sign-up asks for a card wasn't stated | Yes, unless the machine is renamed; the tailnet part is generated and can't be chosen | None | Beta, with bandwidth limits Tailscale doesn't publish. TLS ends on the VM (the relay can't read it). Long-lived requests aren't documented. Adds `tailscaled` on the VM and a Tailscale account. |
| Cloudflare Tunnel (named) | No: Zero Trust onboarding asks for payment details | Only on a domain on Cloudflare | None | Ruled out: needs a bought domain and a payment method. |
| Cloudflare quick tunnel | Free, no account | No: random, changes each run | None | Ruled out: "for testing and development", no uptime guarantee, 200 requests in flight. |

`duckdns.org` is on the Public Suffix List (as is `dedyn.io`), so Let's
Encrypt counts each name as its own registered domain (50 certificates
per 7 days), not one shared by every user of the provider.

Caddy (an OS package with its own systemd service, not an npm
dependency) gets and renews Let's Encrypt certificates by itself over
ports 80 and 443, redirects HTTP to HTTPS, and proxies WebSockets and
streamed responses. That its proxy has no read or write timeout by
default is from a summary of its docs, to confirm in D1. Let's Encrypt's
default certificates last 90 days, and lifetimes are getting shorter
industry-wide (the CA/Browser Forum's maximum falls to 100 days from
15 March 2027 and 47 days from 15 March 2029); Caddy renews
automatically, so that's invisible.

Oracle (checked 2026-11-23): inbound ports are opened in the subnet's
security list. Oracle warns not to use UFW on its Ubuntu images. That
the VM's own `iptables` also blocks 80 and 443 by default is from
memory, not its docs, to check on the VM during setup. An ephemeral
public IP stays with the instance when it's stopped, and its lifetime is
tied to the instance's private IP; whether anything short of recreating
the instance changes it, the docs don't say. Always Free includes 10 TB
a month of outbound data.

## Decision

The dashboard and the helper's endpoint are served at a free
`<name>.duckdns.org` name from DuckDNS, pointing at the VM's public IP. Caddy
on the VM terminates HTTPS with Let's Encrypt certificates and proxies to
the bot, which listens on `127.0.0.1` only. Ports 80 and 443 are opened
in the OCI security list and the VM's `iptables`, and nothing else.

**Why:** TODO(Alex)

## Consequences

- The VM takes inbound connections for the first time. Only Caddy faces
  the internet, so the bot's HTTP server is never reachable directly, and
  Caddy's TLS and HTTP parsing are a maintained project's, not ours.
- Setup is by hand, once, on the VM and outside the deploy job: the
  DuckDNS sign-in and its name's address, Caddy's apt repository and a short
  Caddyfile, and the firewall rules. `ORACLE_CLOUD_DEPLOYMENT.md` records
  each step when it's done, in D1 (its note that no inbound firewall or
  security list changes are needed becomes wrong then), so the VM can be
  rebuilt. The deploy job doesn't touch Caddy.
- A deploy restarts the bot, not Caddy: for those seconds Caddy answers
  502, and a page loaded then shows an error until reloaded. The helper
  is designed to back off on a 5xx (A8).
- If the VM's public IP changes (the instance recreated), the A record
  is updated through DuckDNS's update URL. Until then the dashboard
  and every helper are unreachable. A reserved IP would avoid that; how
  many Always Free includes wasn't confirmed.
- Users and helpers see a `duckdns.org` name, not a branded domain. Moving
  to another name later means changing Discord's OAuth2 redirect URL and
  every helper's config, so it's worth choosing the label once.
- The VM's IP is public in DNS (as it would be with any proxy; only a
  tunnel hides it), and certificate transparency logs list the hostname.
  Scanners will find it.
- Depends on DuckDNS, a two-person free service, staying free and
  online; deSEC closing its sign-ups on short notice shows that's a real
  risk for any free name. Its DNS going down takes the dashboard and every
  helper's connection with it, though Minecraft to Discord chat keeps
  working through webhooks. If it goes, deSEC (if it reopens) is a
  drop-in replacement (same Caddy setup, a new name), and Tailscale Funnel
  the route with no open ports, once it leaves beta and documents its
  limits. Either would supersede this record.
- Sign-up is checked in a browser before this is accepted: a fetched
  page can miss a banner like deSEC's.
- Not used: DNS-01 and wildcard certificates (Caddy would need a plugin
  build), and IPv6.

## Sources

Read 2026-11-23.

- deSEC (sign-ups suspended, per the banner on [desec.io](https://desec.io/)): [domains](https://desec.readthedocs.io/en/latest/dns/domains.html),
  [account](https://desec.readthedocs.io/en/latest/auth/account.html),
  [rate limits](https://desec.readthedocs.io/en/latest/rate-limits.html),
  [Let's Encrypt](https://desec.readthedocs.io/en/latest/integrations/lets-encrypt.html),
  [dynamic DNS](https://desec.readthedocs.io/en/latest/dyndns/update-api.html)
- DuckDNS: [FAQ](https://www.duckdns.org/faqs.jsp),
  [about](https://www.duckdns.org/about.jsp),
  [terms](https://www.duckdns.org/tac.jsp),
  [API](https://www.duckdns.org/spec.jsp)
- FreeDNS: [FAQ](https://freedns.afraid.org/faq/),
  [shared domain registry](https://freedns.afraid.org/domain/registry/)
- No-IP: [free plan](https://www.noip.com/free)
- Tailscale: [Funnel](https://tailscale.com/kb/1223/funnel),
  [HTTPS](https://tailscale.com/kb/1153/enabling-https),
  [pricing](https://tailscale.com/pricing)
- Cloudflare: [Tunnel, get started](https://developers.cloudflare.com/tunnel/get-started/),
  [routing](https://developers.cloudflare.com/tunnel/routing/),
  [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/),
  [quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- Let's Encrypt: [rate limits](https://letsencrypt.org/docs/rate-limits/),
  [profiles](https://letsencrypt.org/docs/profiles/);
  [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat)
- Caddy: [automatic HTTPS](https://caddyserver.com/docs/automatic-https),
  [install](https://caddyserver.com/docs/install),
  [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- Oracle: [Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
  [public IPs](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm),
  [compute best practices](https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm)
